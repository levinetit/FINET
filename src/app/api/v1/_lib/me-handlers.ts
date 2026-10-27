import "server-only";

import { z } from "zod";

import type { Db } from "@/db";
import { ForbiddenError, NotFoundError } from "@/lib/authz";
import type { Config } from "@/lib/config";
import type { FinetAuth } from "@/modules/auth/auth";
import { jsonError } from "@/modules/auth/handler";
import { changePasswordSchema } from "@/modules/auth/password.schema";
import { PasswordChangeError, changePassword } from "@/modules/auth/password.service";
import { hitRateLimit, rateLimitKey } from "@/modules/auth/rate-limit";
import { trustedClientIp } from "@/modules/auth/request";
import {
  CsrfError,
  type SessionInfo,
  UnauthenticatedError,
  assertSameOrigin,
  requireSession,
} from "@/modules/auth/session";
import { profilePatchSchema } from "@/modules/profile/profile.schema";
import { getMe, updateMe } from "@/modules/profile/profile.service";
import {
  listMySessions,
  revokeMyOtherSessions,
  revokeMySession,
} from "@/modules/sessions/sessions.service";

/**
 * Handlerele `/api/v1/me/*` (master prompt 6.4): subțiri peste serviciile din `src/modules`,
 * cu dependențele injectate (rutele Next dau `getAuthRuntime()`, testele o bază de test).
 * Erorile au formatul `{ error: { code, message, fields? } }`; orice eroare neprevăzută dă 500
 * fără detalii. Toate cer o sesiune validă (cookie sau bearer); mutațiile cu cookie cer și
 * `Origin` corect (CSRF).
 */

export type ApiDeps = Readonly<{ auth: FinetAuth; db: Db; config: Config; now?: () => number }>;

const MAX_BODY_BYTES = 16 * 1024;

class BadRequestError extends Error {
  constructor(
    readonly fields: Record<string, string> | undefined,
    message = "Cererea nu e validă.",
  ) {
    super(message);
  }
}

const noStore = { "Cache-Control": "no-store" } as const;

function ok(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: noStore });
}

function fieldsOf(error: z.ZodError): Record<string, string> {
  // Mesaje fixe (nu cele implicite Zod, care pot repeta valoarea); `custom` = mesajul schemei.
  const fields: Record<string, string> = {};
  let root: string | null = null;
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) fields[[...issue.path, k].join(".")] = "Câmp nepermis.";
    } else if (issue.path.length === 0) {
      root ??= issue.code === "custom" ? issue.message : "Valoare invalidă.";
    } else {
      fields[issue.path.join(".")] ??=
        issue.code === "custom" ? issue.message : "Valoare invalidă.";
    }
  }
  // O problemă la rădăcină (de exemplu „nimic de modificat”) apare doar dacă nu e alta.
  if (root !== null && Object.keys(fields).length === 0) fields._ = root;
  return fields;
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new BadRequestError(undefined, "Corpul trebuie să fie JSON.");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new BadRequestError(undefined, "Cererea e prea mare.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BadRequestError(undefined, "JSON invalid.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(fieldsOf(parsed.error));
  return parsed.data;
}

async function handle(
  request: Request,
  deps: ApiDeps,
  fn: (session: SessionInfo) => Promise<Response>,
): Promise<Response> {
  try {
    const session = await requireSession(request, deps);
    assertSameOrigin(request, session, deps.config);
    return await fn(session);
  } catch (error) {
    if (error instanceof UnauthenticatedError || error instanceof CsrfError) {
      return jsonError(error.status, error.code, error.message);
    }
    if (error instanceof NotFoundError || error instanceof ForbiddenError) {
      return jsonError(error.status, error.code, error.message);
    }
    if (error instanceof BadRequestError) {
      return jsonError(400, "invalid_request", error.message, {}, error.fields);
    }
    if (error instanceof PasswordChangeError) {
      return jsonError(400, error.code, error.message, {}, { [error.field]: error.message });
    }
    console.error("[api] eroare neașteptată");
    return jsonError(500, "internal_error", "Eroare internă.");
  }
}

export function getMeHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (s) => ok({ data: await getMe(deps.db, s.userId) }));
}

export function patchMeHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (s) => {
    const patch = await readJson(request, profilePatchSchema);
    return ok({ data: await updateMe(deps.db, s.userId, patch) });
  });
}

export function listSessionsHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (s) => {
    const now = new Date(deps.now?.() ?? Date.now());
    return ok({ data: await listMySessions(deps.db, s, now) });
  });
}

export function deleteSessionHandler(
  request: Request,
  deps: ApiDeps,
  sessionId: string,
): Promise<Response> {
  return handle(request, deps, async (s) => {
    await revokeMySession(deps.db, s, sessionId);
    return new Response(null, { status: 204, headers: noStore });
  });
}

export function revokeOthersHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (s) => {
    const revoked = await revokeMyOtherSessions(deps.db, s);
    return ok({ data: { revoked } });
  });
}

export function changePasswordHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (s) => {
    const ip = trustedClientIp(request.headers, { accessVerified: deps.config.access.required });
    const limit = await hitRateLimit(
      deps.db,
      rateLimitKey("password_change", ip, s.userId),
      deps.config.auth.rateLimits.passwordChange,
      deps.now?.() ?? Date.now(),
    );
    if (!limit.allowed) {
      return jsonError(429, "rate_limited", "Prea multe încercări. Încearcă din nou mai târziu.", {
        "Retry-After": String(limit.retryAfterSeconds),
      });
    }
    const input = await readJson(request, changePasswordSchema);
    const result = await changePassword(deps.db, s, input, {
      hibpEnabled: deps.config.auth.hibpEnabled,
    });
    return ok({ data: result });
  });
}
