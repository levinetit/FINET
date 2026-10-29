import "server-only";

import { z } from "zod";

import { type Db, type DbOrTx, withRlsOn } from "@/db";
import { type Actor, ForbiddenError, NotFoundError } from "@/lib/authz";
import type { Config, RateLimitRule } from "@/lib/config";
import { ConflictError, ValidationError } from "@/lib/errors";
import { MoneyOverflowError } from "@/lib/money";
import {
  DEFAULT_ACCEPT_LIMIT,
  InviteRateLimitedError,
  InviteUnavailableError,
} from "@/modules/family/invites.service";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import type { FinetAuth } from "@/modules/auth/auth";
import { hitRateLimit, rateLimitKey } from "@/modules/auth/rate-limit";
import {
  CsrfError,
  type SessionInfo,
  UnauthenticatedError,
  assertSameOrigin,
  requireSession,
} from "@/modules/auth/session";
import {
  IDEMPOTENCY_HEADER,
  type StoredResponse,
  exceedsDepth,
  isValidIdempotencyKey,
  requestHash,
  runIdempotent,
} from "@/modules/idempotency/idempotency";
import { zodFields } from "@/modules/ledger/input";
import { recordClientInstallation } from "@/modules/usage/installations";

/**
 * Stratul HTTP comun al rutelor `/api/v1/*` (master prompt 6.4, ADR 0005): handlere subțiri
 * peste serviciile din `src/modules`, cu dependențele injectate (rutele Next dau
 * `getAuthRuntime()`, testele o bază de test și un ceas controlat).
 *
 * Ordinea la fiecare cerere: sesiune (cookie sau bearer, 401) → CSRF/Origin pe mutațiile cu
 * cookie (403) → antetul `X-FINET-Client` (instalarea, fără să blocheze) → rate limiting pe
 * mutații (429) → handlerul. Erorile: `{ error: { code, message, fields?, reason? } }`; orice
 * eroare neprevăzută dă 500 fără detalii.
 */

export type ApiLimits = Readonly<{
  /** Mutațiile (`POST`/`PUT`/`PATCH`/`DELETE`), pe utilizator. */
  mutations: RateLimitRule;
  /** `POST /api/v1/app/events`, pe utilizator (în plus față de `mutations`). */
  events: RateLimitRule;
  /** Exporturile CSV (`GET /api/v1/exports/*`), pe utilizator: scumpe, deci mai strâns. */
  exports: RateLimitRule;
  /** `POST /api/v1/recurring/generate`, pe utilizator (în plus față de `mutations`). */
  recurringGenerate: RateLimitRule;
  /** Încărcarea documentelor (bonuri), pe utilizator (în plus față de `mutations`). */
  documentUpload: RateLimitRule;
  /** Reprocesarea unui bon (un nou apel AI), pe utilizator (în plus față de `mutations`). */
  receiptReprocess: RateLimitRule;
  /** Acceptarea invitațiilor (Faza 8), pe utilizator, consumată și pentru tokenurile greșite. */
  inviteAccept: RateLimitRule;
}>;

/** Limitele implicite (decizia mea): generoase pentru un client real, mici pentru un abuz. */
export const DEFAULT_API_LIMITS: ApiLimits = Object.freeze({
  mutations: Object.freeze({ max: 120, windowSeconds: 60 }),
  events: Object.freeze({ max: 30, windowSeconds: 60 }),
  // F3-B (decizia mea): 10 exporturi pe minut per utilizator.
  exports: Object.freeze({ max: 10, windowSeconds: 60 }),
  // F5-B (decizia mea): 6 generări la cerere pe minut per utilizator; butonul e rar folosit.
  recurringGenerate: Object.freeze({ max: 6, windowSeconds: 60 }),
  // F6-A (decizia mea): 30 de încărcări (cereri de până la 4 fișiere) la 10 minute per utilizator.
  documentUpload: Object.freeze({ max: 30, windowSeconds: 600 }),
  // F6-C (decizia mea): 10 reprocesări la 10 minute per utilizator (fiecare costă un apel AI).
  receiptReprocess: Object.freeze({ max: 10, windowSeconds: 600 }),
  // F8-A (ADR 0016): 10 încercări de acceptare la 15 minute per utilizator.
  inviteAccept: Object.freeze({ ...DEFAULT_ACCEPT_LIMIT }),
});

export type ApiDeps = Readonly<{
  auth: FinetAuth;
  db: Db;
  config: Config;
  /** Ceasul (ms Unix), injectabil în teste. */
  now?: () => number;
  limits?: Partial<ApiLimits>;
  /** Doar pentru teste: plafonul de rânduri și pagina exportului de tranzacții. */
  exportMaxRows?: number;
  exportPageSize?: number;
  /** Doar pentru teste: ritmul fluxului SSE (`GET /api/v1/events`, ADR 0017). */
  live?: Readonly<{ heartbeatMs?: number; lifetimeMs?: number }>;
}>;

/** Corpul maxim acceptat (octeți). */
export const MAX_BODY_BYTES = 16 * 1024;

const noStore = { "Cache-Control": "no-store" } as const;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** O eroare HTTP explicită (415, 413, 422, 429, 409 `request_in_progress` etc.). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Readonly<{
      fields?: Record<string, string>;
      reason?: string;
      headers?: Record<string, string>;
    }> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ErrorPayload = Readonly<{
  status: number;
  body: {
    error: { code: string; message: string; fields?: Record<string, string>; reason?: string };
  };
  headers?: Record<string, string>;
}>;

/** Eroarea de domeniu → status + corp; `null` pentru o eroare neașteptată (500). */
export function errorPayload(error: unknown): ErrorPayload | null {
  const make = (
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    reason?: string,
    headers?: Record<string, string>,
  ): ErrorPayload => ({
    status,
    body: {
      error: { code, message, ...(fields ? { fields } : {}), ...(reason ? { reason } : {}) },
    },
    headers,
  });
  if (error instanceof UnauthenticatedError || error instanceof CsrfError) {
    return make(error.status, error.code, error.message);
  }
  if (error instanceof NotFoundError || error instanceof ForbiddenError) {
    return make(error.status, error.code, error.message);
  }
  if (error instanceof ValidationError) {
    return make(400, error.code, error.message, { ...error.fields });
  }
  if (error instanceof ConflictError) {
    return make(409, error.code, error.message, undefined, error.reason);
  }
  // Faza 8: invitația inutilizabilă (răspuns uniform, fără enumerare) și limita de acceptare.
  if (error instanceof InviteUnavailableError) {
    return make(404, error.code, error.message);
  }
  if (error instanceof InviteRateLimitedError) {
    return make(429, error.code, error.message, undefined, undefined, {
      "Retry-After": String(Math.max(1, error.retryAfterSeconds)),
    });
  }
  if (error instanceof MoneyOverflowError) {
    // Un sold calculat peste 2^53 nu se poate trimite exact în JSON (MEDIUM-2): cod stabil.
    return make(
      422,
      "amount_out_of_range",
      "O sumă depășește intervalul care poate fi transmis exact.",
    );
  }
  if (error instanceof ApiError) {
    return make(
      error.status,
      error.code,
      error.message,
      error.extra.fields,
      error.extra.reason,
      error.extra.headers,
    );
  }
  return null;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status, headers: { ...noStore, ...headers } });
  return Response.json(body, { status, headers: { ...noStore, ...headers } });
}

function errorResponse(error: unknown): Response {
  const payload = errorPayload(error);
  if (payload) return json(payload.body, payload.status, payload.headers);
  console.error("[api] eroare neașteptată");
  return json({ error: { code: "internal_error", message: "Eroare internă." } }, 500);
}

// ---------------------------------------------------------------------------------------------
// Corpul cererii
// ---------------------------------------------------------------------------------------------

async function readLimitedText(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const tooLarge = () => new ApiError(413, "payload_too_large", "Cererea e prea mare.");
const notJson = () => new ApiError(415, "unsupported_media_type", "Corpul trebuie să fie JSON.");

function isJsonType(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return type === "application/json";
}

/**
 * Corpul JSON al unei mutații (obligatoriu): fără `Content-Type: application/json` → 415, peste
 * `MAX_BODY_BYTES` → 413, JSON invalid → 400. Validarea propriu-zisă o face serviciul (Zod strict).
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  if (!isJsonType(request)) throw notJson();
  const text = await readLimitedText(request);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "invalid_request", "JSON invalid.");
  }
}

/**
 * Corpul opțional (de exemplu `POST .../archive`): fără corp și fără `Content-Type` → `undefined`;
 * un corp trimis trebuie să fie JSON (altfel 415).
 */
export async function readOptionalJsonBody(request: Request): Promise<unknown> {
  if (isJsonType(request)) {
    const text = await readLimitedText(request);
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ApiError(400, "invalid_request", "JSON invalid.");
    }
  }
  const text = await readLimitedText(request);
  if (text.length > 0) throw notJson();
  return undefined;
}

/** Validează corpul cu o schemă Zod locală rutei (mesaje fixe pe câmp). */
export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ValidationError(zodFields(parsed.error));
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Parametrii din URL (strict: un parametru necunoscut sau repetat → 400)
// ---------------------------------------------------------------------------------------------

export type QueryKind = "string" | "int" | "bool";

export function readQuery(
  request: Request,
  spec: Readonly<Record<string, QueryKind>>,
): Record<string, string | number | boolean> {
  const params = new URL(request.url).searchParams;
  const out: Record<string, string | number | boolean> = {};
  const fields: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, raw] of params) {
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) {
      fields[name.slice(0, 64)] = "Parametru nepermis.";
      continue;
    }
    if (seen.has(name)) {
      fields[name] = "Parametru repetat.";
      continue;
    }
    seen.add(name);
    if (kind === "int") {
      if (!/^[0-9]{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        fields[name] = "Valoare invalidă.";
      } else {
        out[name] = Number(raw);
      }
    } else if (kind === "bool") {
      if (raw !== "true" && raw !== "false") fields[name] = "Valoare invalidă.";
      else out[name] = raw === "true";
    } else {
      out[name] = raw;
    }
  }
  if (Object.keys(fields).length > 0) throw new ValidationError(fields);
  return out;
}

/** Parametrul `{id}` al rutei: un id invalid e tratat ca resursă inexistentă (404). */
export function routeId(value: string): string {
  if (!z.uuid().safeParse(value).success) throw new NotFoundError();
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Contextul cererii
// ---------------------------------------------------------------------------------------------

export type ApiContext = Readonly<{
  request: Request;
  deps: ApiDeps;
  session: SessionInfo;
  actor: Actor;
  /** Momentul cererii (ms Unix, ceasul injectat). */
  now: number;
  limits: ApiLimits;
}>;

/**
 * Gospodăria curentă a utilizatorului, din BAZĂ (cea mai veche apartenență, ADR 0003), niciodată
 * din cerere. Fără gospodărie → 404.
 */
export async function currentHousehold(ctx: ApiContext): Promise<string> {
  const id = await withRlsOn(ctx.deps.db, { userId: ctx.actor.userId }, (tx) =>
    currentHouseholdIdOf(tx, ctx.actor.userId),
  );
  if (!id) throw new NotFoundError();
  return id;
}

export async function enforceRateLimit(
  ctx: ApiContext,
  kind:
    | "api_mutation"
    | "app_events"
    | "api_export"
    | "api_recurring_generate"
    | "api_document_upload"
    | "api_receipt_reprocess",
  rule: RateLimitRule,
): Promise<void> {
  const result = await hitRateLimit(
    ctx.deps.db,
    rateLimitKey(kind, null, ctx.actor.userId),
    rule,
    ctx.now,
  );
  if (!result.allowed) {
    throw new ApiError(429, "rate_limited", "Prea multe cereri. Încearcă din nou mai târziu.", {
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    });
  }
}

/** Rulează handlerul cu sesiune, CSRF, instalare, rate limiting și maparea erorilor. */
export async function handle(
  request: Request,
  deps: ApiDeps,
  fn: (ctx: ApiContext) => Promise<Response>,
): Promise<Response> {
  try {
    const session = await requireSession(request, deps);
    assertSameOrigin(request, session, deps.config);
    const ctx: ApiContext = {
      request,
      deps,
      session,
      actor: { userId: session.userId },
      now: deps.now?.() ?? Date.now(),
      limits: { ...DEFAULT_API_LIMITS, ...deps.limits },
    };
    // Statisticile de utilizare (6.5): nu blochează și nu schimbă răspunsul.
    await recordClientInstallation(deps.db, ctx.actor.userId, request.headers, ctx.now);
    if (MUTATING.has(request.method.toUpperCase())) {
      await enforceRateLimit(ctx, "api_mutation", ctx.limits.mutations);
    }
    return await fn(ctx);
  } catch (error) {
    return errorResponse(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Idempotența (`Idempotency-Key`)
// ---------------------------------------------------------------------------------------------

/** Cheia din antet (validată) sau `null` dacă lipsește. Invalidă → 400. */
export function idempotencyKeyOf(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (!isValidIdempotencyKey(key)) {
    throw new ValidationError(
      { "Idempotency-Key": "Cheia are 16–128 caractere: litere, cifre, - sau _." },
      "Antetul Idempotency-Key nu e valid.",
    );
  }
  return key;
}

/**
 * O mutație care creează, cu `Idempotency-Key` opțional. `run(db)` primește clientul de folosit
 * (tranzacția cheii, dacă există cheia) și întoarce statusul și corpul; erorile de domeniu ale
 * serviciului (4xx) se memorează ca răspuns, cele neașteptate (5xx) nu.
 */
export async function idempotentCreate(
  ctx: ApiContext,
  householdId: string,
  body: unknown,
  run: (db: DbOrTx) => Promise<StoredResponse>,
): Promise<Response> {
  const key = idempotencyKeyOf(ctx.request);
  if (key === null) {
    const response = await run(ctx.deps.db);
    return json(response.body, response.status);
  }
  if (exceedsDepth(body)) {
    throw new ValidationError({ _: "Cererea are prea multe niveluri." });
  }
  const hash = requestHash({
    method: ctx.request.method,
    path: new URL(ctx.request.url).pathname,
    userId: ctx.actor.userId,
    body,
  });
  const outcome = await runIdempotent(
    ctx.deps.db,
    ctx.actor,
    householdId,
    key,
    hash,
    ctx.now,
    async (db) => {
      try {
        return await run(db);
      } catch (error) {
        const payload = errorPayload(error);
        // 5xx (eroare neașteptată): se aruncă, tranzacția se anulează, cheia nu se memorează.
        if (!payload || payload.status >= 500) throw error;
        return { status: payload.status, body: payload.body };
      }
    },
  );
  switch (outcome.kind) {
    case "in_progress":
      throw new ApiError(
        409,
        "request_in_progress",
        "O cerere cu aceeași cheie e încă în desfășurare.",
        { reason: "request_in_progress" },
      );
    case "reused":
      throw new ApiError(
        422,
        "idempotency_key_reused",
        "Cheia Idempotency-Key a fost folosită pentru o altă cerere.",
      );
    case "replay":
      return json(outcome.response.body, outcome.response.status, { "Idempotent-Replay": "true" });
    case "fresh":
      return json(outcome.response.body, outcome.response.status);
  }
}
