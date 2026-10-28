import "server-only";

import type { Config } from "@/lib/config";

import type { FinetAuth } from "./auth";
import { findUserById } from "./users.repo";
import type { Db } from "@/db";
import { withTrustedClientIp } from "./request";

/**
 * Sesiunea curentă pentru rutele `/api/v1/*`: cookie-ul web sau `Authorization: Bearer <token>`
 * (pluginul `bearer`, doar tokenuri semnate). Verificarea o face Better Auth, în bază, la
 * fiecare cerere (fără cookie cache): o sesiune revocată sau expirată e respinsă imediat.
 * Un utilizator dezactivat (`status = disabled`) nu are sesiune validă.
 */

export type SessionInfo = Readonly<{
  userId: string;
  sessionId: string;
  /** `true` dacă sesiunea a venit prin `Authorization: Bearer` (fără cookie, deci fără CSRF). */
  viaBearer: boolean;
}>;

export class UnauthenticatedError extends Error {
  readonly code = "unauthenticated";
  readonly status = 401;
  constructor() {
    super("Trebuie să te autentifici.");
    this.name = "UnauthenticatedError";
  }
}

/** Mutație cu cookie fără `Origin` corect (CSRF, 6.3). */
export class CsrfError extends Error {
  readonly code = "forbidden";
  readonly status = 403;
  constructor() {
    super("Cerere refuzată.");
    this.name = "CsrfError";
  }
}

export type SessionDeps = Readonly<{ auth: FinetAuth; db: Db; config: Config }>;

function isBearer(headers: Headers): boolean {
  return /^bearer\s+\S/i.test(headers.get("authorization") ?? "");
}

export async function requireSession(request: Request, deps: SessionDeps): Promise<SessionInfo> {
  const headers = withTrustedClientIp(request.headers, {
    accessVerified: deps.config.access.required,
  });
  let result: Awaited<ReturnType<FinetAuth["api"]["getSession"]>> = null;
  try {
    result = await deps.auth.api.getSession({ headers, query: { disableCookieCache: true } });
  } catch {
    result = null;
  }
  if (!result) throw new UnauthenticatedError();
  const user = await findUserById(deps.db, result.user.id);
  if (!user || user.status !== "active") throw new UnauthenticatedError();
  return { userId: user.id, sessionId: result.session.id, viaBearer: isBearer(request.headers) };
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF pentru `/api/v1` (Better Auth verifică originea doar pe `/api/auth`): o mutație
 * autentificată prin cookie cere `Origin` egal cu originea `APP_URL` (sau, fără `Origin`,
 * `Sec-Fetch-Site: same-origin`). Cererile bearer nu poartă cookie-uri, deci sunt scutite.
 */
export function assertSameOrigin(request: Request, session: SessionInfo, config: Config): void {
  if (session.viaBearer || !MUTATING.has(request.method.toUpperCase())) return;
  const expected = new URL(config.appUrl ?? "http://localhost:3000").origin;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (origin !== expected) throw new CsrfError();
    return;
  }
  if (request.headers.get("sec-fetch-site") !== "same-origin") throw new CsrfError();
}
