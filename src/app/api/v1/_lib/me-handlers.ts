import "server-only";

import { changePasswordSchema } from "@/modules/auth/password.schema";
import { PasswordChangeError, changePassword } from "@/modules/auth/password.service";
import { hitRateLimit, rateLimitKey } from "@/modules/auth/rate-limit";
import { CLIENT_HEADER, parseClientInfo, trustedClientIp } from "@/modules/auth/request";
import { profilePatchSchema } from "@/modules/profile/profile.schema";
import { getMe, updateMe } from "@/modules/profile/profile.service";
import {
  listMySessions,
  revokeMyOtherSessions,
  revokeMySession,
} from "@/modules/sessions/sessions.service";
import { getConsents, setConsents } from "@/modules/usage/consents";
import { recordEvents } from "@/modules/usage/events";

import {
  ApiError,
  type ApiDeps,
  enforceRateLimit,
  handle,
  json,
  parseWith,
  readJsonBody,
  readOptionalJsonBody,
} from "./http";

/**
 * Handlerele `/api/v1/me/*` (master prompt 6.4) și `/api/v1/app/events` (6.5): subțiri peste
 * serviciile din `src/modules`, pe stratul comun din `./http` (sesiune cookie sau bearer, CSRF pe
 * mutațiile cu cookie, `X-FINET-Client`, rate limiting, formatul de eroare
 * `{ error: { code, message, fields? } }`, 500 fără detalii).
 */

export type { ApiDeps } from "./http";

export function getMeHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) =>
    json({ data: await getMe(deps.db, ctx.actor.userId) }),
  );
}

export function patchMeHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) => {
    const patch = parseWith(profilePatchSchema, await readJsonBody(request));
    return json({ data: await updateMe(deps.db, ctx.actor.userId, patch) });
  });
}

export function listSessionsHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) =>
    json({ data: await listMySessions(deps.db, ctx.session, new Date(ctx.now)) }),
  );
}

export function deleteSessionHandler(
  request: Request,
  deps: ApiDeps,
  sessionId: string,
): Promise<Response> {
  return handle(request, deps, async (ctx) => {
    await revokeMySession(deps.db, ctx.session, sessionId);
    return json(null, 204);
  });
}

export function revokeOthersHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) => {
    await readOptionalJsonBody(request);
    const revoked = await revokeMyOtherSessions(deps.db, ctx.session);
    return json({ data: { revoked } });
  });
}

export function changePasswordHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) => {
    const ip = trustedClientIp(request.headers, { accessVerified: deps.config.access.required });
    const limit = await hitRateLimit(
      deps.db,
      rateLimitKey("password_change", ip, ctx.actor.userId),
      deps.config.auth.rateLimits.passwordChange,
      ctx.now,
    );
    if (!limit.allowed) {
      throw new ApiError(
        429,
        "rate_limited",
        "Prea multe încercări. Încearcă din nou mai târziu.",
        {
          headers: { "Retry-After": String(limit.retryAfterSeconds) },
        },
      );
    }
    const input = parseWith(changePasswordSchema, await readJsonBody(request));
    try {
      const result = await changePassword(deps.db, ctx.session, input, {
        hibpEnabled: deps.config.auth.hibpEnabled,
      });
      return json({ data: result });
    } catch (error) {
      if (error instanceof PasswordChangeError) {
        throw new ApiError(400, error.code, error.message, {
          fields: { [error.field]: error.message },
        });
      }
      throw error;
    }
  });
}

// --- Consimțămintele (6.5) -------------------------------------------------------------------

export function getConsentsHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) =>
    json({ data: await getConsents(deps.db, ctx.actor.userId) }),
  );
}

export function putConsentsHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) => {
    const body = await readJsonBody(request);
    return json({ data: await setConsents(deps.db, ctx.actor.userId, body) });
  });
}

// --- Evenimentele de utilizare (6.5) ---------------------------------------------------------

/** Mereu 204 (stocat sau nu, după consimțământ); lot invalid → 400 cu mesaj fix. */
export function appEventsHandler(request: Request, deps: ApiDeps): Promise<Response> {
  return handle(request, deps, async (ctx) => {
    await enforceRateLimit(ctx, "app_events", ctx.limits.events);
    const body = await readJsonBody(request);
    const client = parseClientInfo(request.headers.get(CLIENT_HEADER));
    await recordEvents(deps.db, ctx.actor.userId, body, client, ctx.now);
    return json(null, 204);
  });
}
