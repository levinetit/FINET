import "server-only";

import { NotFoundError } from "@/lib/authz";
import type { Config, RateLimitRule } from "@/lib/config";
import { type Mailer, createMailer } from "@/modules/auth/mailer";
import { hitRateLimit, rateLimitKey } from "@/modules/auth/rate-limit";
import {
  completeInputSchema,
  completeRegistration,
  registerAccount,
  registerInputSchema,
} from "@/modules/auth/registration";
import { CsrfError } from "@/modules/auth/session";
import { trustedClientIp } from "@/modules/auth/request";

import { type ApiDeps, ApiError, errorPayload, json, parseWith, readJsonBody } from "./http";

/**
 * Înregistrarea publică (Faza 11-C, ADR 0029). RUTE FĂRĂ SESIUNE, de aceea nu trec prin `handle`:
 * își fac singure verificarea de origine (CSRF), limitele de rate și maparea erorilor. Există doar
 * dacă modul e `saas`, `SIGNUP_ENABLED=1` și SMTP e configurat; altfel răspund 404, ca și cum n-ar
 * exista. Răspunsul la prima cerere nu depinde de existența adresei.
 */

let defaultMailer: { smtp: Config["notify"]["smtp"]; mailer: Mailer | null } | null = null;

function mailerOf(deps: ApiDeps): Mailer | null {
  if (deps.mailer !== undefined) return deps.mailer;
  const smtp = deps.config.notify.smtp;
  if (defaultMailer?.smtp !== smtp) {
    defaultMailer = {
      smtp,
      mailer: createMailer(smtp, { production: deps.config.nodeEnv === "production" }),
    };
  }
  return defaultMailer.mailer;
}

function openOr404(deps: ApiDeps): Mailer {
  const mailer = mailerOf(deps);
  if (deps.config.appMode !== "saas" || !deps.config.auth.signupEnabled || !mailer) {
    throw new NotFoundError();
  }
  return mailer;
}

/** Aceeași regulă ca la rutele cu sesiune: `Origin` identic cu aplicația, sau `Sec-Fetch-Site: same-origin`. */
function assertBrowserOrigin(request: Request, config: Config): void {
  const expected = new URL(config.appUrl ?? "http://localhost:3000").origin;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin !== expected) throw new CsrfError();
    return;
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") throw new CsrfError();
}

const IP_RULE: RateLimitRule = Object.freeze({ max: 10, windowSeconds: 60 * 60 });
// Fără IP de încredere (fără Access), grupul „necunoscut” e comun: plafon global, nu pe client.
const SHARED_RULE: RateLimitRule = Object.freeze({ max: 60, windowSeconds: 60 * 60 });

async function limit(
  deps: ApiDeps,
  request: Request,
  now: number,
  kind: "register" | "register_ip",
  subject: string,
  rule: RateLimitRule,
): Promise<void> {
  const ip = trustedClientIp(request.headers, { accessVerified: deps.config.access.required });
  const result = await hitRateLimit(deps.db, rateLimitKey(kind, ip, subject), rule, now);
  if (!result.allowed) {
    throw new ApiError(429, "rate_limited", "Prea multe cereri. Încearcă din nou mai târziu.", {
      headers: { "Retry-After": String(result.retryAfterSeconds) },
    });
  }
}

function failure(error: unknown): Response {
  const payload = errorPayload(error);
  if (payload) return json(payload.body, payload.status, payload.headers);
  console.error("[register] eroare neașteptată");
  return json({ error: { code: "internal_error", message: "Eroare internă." } }, 500);
}

/** `POST /api/v1/register`: pasul 1 (email, nume, termeni). 202 fix, indiferent de adresă. */
export async function registerHandler(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    const mailer = openOr404(deps);
    assertBrowserOrigin(request, deps.config);
    const now = deps.now?.() ?? Date.now();
    const input = parseWith(registerInputSchema, await readJsonBody(request));
    await limit(deps, request, now, "register_ip", "register", {
      ...(trustedClientIp(request.headers, { accessVerified: deps.config.access.required })
        ? IP_RULE
        : SHARED_RULE),
    });
    await limit(deps, request, now, "register", input.email, deps.config.auth.rateLimits.email);
    await registerAccount(
      { db: deps.db, config: deps.config, mailer, ...(deps.now ? { now: deps.now } : {}) },
      input,
    );
    return json({ data: { status: "pending" } }, 202);
  } catch (error) {
    return failure(error);
  }
}

/** `POST /api/v1/register/complete`: pasul 2 (linkul semnat + parola aleasă). */
export async function completeRegisterHandler(request: Request, deps: ApiDeps): Promise<Response> {
  try {
    openOr404(deps);
    assertBrowserOrigin(request, deps.config);
    const now = deps.now?.() ?? Date.now();
    const input = parseWith(completeInputSchema, await readJsonBody(request));
    // Contra ghicirii tokenurilor: pe IP, subiect fix (tokenul e prea lung ca subiect util).
    await limit(deps, request, now, "register_ip", "complete", {
      ...(trustedClientIp(request.headers, { accessVerified: deps.config.access.required })
        ? IP_RULE
        : SHARED_RULE),
    });
    const result = await completeRegistration(
      {
        db: deps.db,
        config: deps.config,
        mailer: openOr404(deps),
        ...(deps.now ? { now: deps.now } : {}),
      },
      input,
    );
    if (!result.ok) {
      return json(
        { error: { code: result.reason, message: result.message } },
        result.reason === "password" ? 400 : 410,
      );
    }
    return json({ data: { status: "verified" } });
  } catch (error) {
    return failure(error);
  }
}
