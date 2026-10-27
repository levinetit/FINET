import "server-only";

import type { Db } from "@/db";
import type { Config, RateLimitRule } from "@/lib/config";

import type { FinetAuth } from "./auth";
import { checkPasswordPolicy, PASSWORD_PROBLEM_MESSAGES } from "./password";
import {
  type RateLimitKind,
  hitRateLimit,
  incrementDailyStat,
  rateLimitKey,
  resetRateLimit,
} from "./rate-limit";
import {
  CLIENT_HEADER,
  normalizeEmail,
  parseClientHeader,
  trustedClientIp,
  withTrustedClientIp,
} from "./request";

/**
 * Intrarea HTTP a Better Auth (`/api/auth/*`), în fața `auth.handler`. Cererea a trecut deja de
 * `src/proxy.ts` (JWT Cloudflare Access, fail closed); aici se adaugă:
 * 1. `personal`: orice `/api/auth/sign-up...` → 404 (nu 403: înregistrarea „nu există”),
 *    indiferent de majuscule sau `/` final;
 * 2. antetul intern cu IP-ul clientului, doar din sursa de încredere (`request.ts`); valoarea
 *    trimisă de client se șterge;
 * 3. emailul normalizat (trim + litere mici) în corpul JSON, înainte de Better Auth;
 * 4. rate limiting pe IP + email (login web, login mobil, emailuri, resetare), cu răspuns
 *    uniform 429 (nu spune dacă emailul există);
 * 5. contorul agregat al login-urilor eșuate și resetarea contorului după un login reușit;
 * 6. politica parolelor (HIBP opțional) la resetarea prin email.
 */

export type AuthHandlerDeps = Readonly<{
  auth: FinetAuth;
  db: Db;
  config: Config;
  /** Ceasul (ms Unix), injectabil în teste. */
  now?: () => number;
}>;

const AUTH_BASE = "/api/auth";
const MAX_BODY_BYTES = 16 * 1024;

const RATE_LIMITED_MESSAGE = "Prea multe încercări. Încearcă din nou mai târziu.";

export function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
  fields?: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message, ...(fields ? { fields } : {}) } },
    { status, headers: { "Cache-Control": "no-store", ...extraHeaders } },
  );
}

const notFound = () => jsonError(404, "not_found", "Resursa nu a fost găsită.");

/** Calea relativă la `/api/auth`, normalizată pentru comparații (litere mici, fără `/` final). */
export function authSubpath(pathname: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  path = path.toLowerCase().replace(/\/{2,}/g, "/");
  if (path !== AUTH_BASE && !path.startsWith(`${AUTH_BASE}/`)) return null;
  const sub = path.slice(AUTH_BASE.length).replace(/\/+$/, "");
  return sub === "" ? "/" : sub;
}

type Limited = Readonly<{ kind: RateLimitKind; rule: RateLimitRule; subject: string }>;

function limitFor(
  sub: string,
  method: string,
  body: Record<string, unknown> | null,
  headers: Headers,
  config: Config,
): Limited | null {
  if (method !== "POST") return null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  const limits = config.auth.rateLimits;
  switch (sub) {
    case "/sign-in/email":
      return parseClientHeader(headers.get(CLIENT_HEADER))
        ? { kind: "mobile_login", rule: limits.mobileLogin, subject: email }
        : { kind: "login", rule: limits.login, subject: email };
    case "/sign-in/magic-link":
    case "/request-password-reset":
    case "/forget-password":
      return { kind: "email", rule: limits.email, subject: email };
    case "/reset-password":
      // Tokenul e în corp; limita e pe IP (subiect fix), ca ghicirea tokenurilor să fie oprită.
      return { kind: "email", rule: limits.email, subject: "reset-password" };
    default:
      return null;
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null | "too_big"> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) return null;
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return "too_big";
  const text = await request.clone().text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return "too_big";
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function handleAuthRequest(
  request: Request,
  deps: AuthHandlerDeps,
): Promise<Response> {
  const { auth, db, config } = deps;
  const now = deps.now ?? Date.now;
  const url = new URL(request.url);
  const sub = authSubpath(url.pathname);
  if (sub === null) return notFound();

  if (config.appMode === "personal" && (sub === "/sign-up" || sub.startsWith("/sign-up/"))) {
    return notFound();
  }

  const policy = { accessVerified: config.access.required };
  const headers = withTrustedClientIp(request.headers, policy);
  const method = request.method.toUpperCase();

  let body: Record<string, unknown> | null = null;
  let bodyText: string | null = null;
  if (method === "POST") {
    const parsed = await readJsonBody(request);
    if (parsed === "too_big") return jsonError(413, "payload_too_large", "Cererea e prea mare.");
    body = parsed;
    if (body && typeof body.email === "string") {
      body = { ...body, email: normalizeEmail(body.email) };
      bodyText = JSON.stringify(body);
    }
  }

  const limited = limitFor(sub, method, body, headers, config);
  let limitKey: string | null = null;
  if (limited) {
    const ip = trustedClientIp(request.headers, policy);
    limitKey = rateLimitKey(limited.kind, ip, limited.subject);
    const result = await hitRateLimit(db, limitKey, limited.rule, now());
    if (!result.allowed) {
      return jsonError(429, "rate_limited", RATE_LIMITED_MESSAGE, {
        "Retry-After": String(result.retryAfterSeconds),
      });
    }
  }

  if (sub === "/reset-password" && method === "POST" && typeof body?.newPassword === "string") {
    const problem = await checkPasswordPolicy(body.newPassword, {
      hibpEnabled: config.auth.hibpEnabled,
    });
    if (problem) {
      return jsonError(
        400,
        "invalid_password",
        PASSWORD_PROBLEM_MESSAGES[problem],
        {},
        {
          newPassword: PASSWORD_PROBLEM_MESSAGES[problem],
        },
      );
    }
  }

  if (bodyText !== null) headers.set("content-length", String(Buffer.byteLength(bodyText)));
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : (bodyText ?? (await request.text())),
  });
  const response = await auth.handler(forwarded);

  if (sub === "/sign-in/email" && method === "POST") {
    if (response.status === 401) await incrementDailyStat(db, "login_failed", now());
    else if (response.ok && limitKey) await resetRateLimit(db, limitKey);
  }
  return response;
}
