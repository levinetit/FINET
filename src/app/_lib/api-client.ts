/**
 * Apelurile din browser către API-ul FINET (`/api/auth/*`, `/api/v1/*`): aceleași rute ca
 * clientul Android, deci aceleași reguli (validare, rate limiting, CSRF prin `Origin`, audit).
 * Doar JSON, aceeași origine, fără cache. Pe `/api/v1/*` se adaugă `X-FINET-Client` doar cu
 * consimțământul `usage_stats` (`usage-client.ts`); `Idempotency-Key` doar când e dat explicit.
 */

import { CLIENT_HEADER_NAME, clientHeaderFor } from "./usage-client";

export type ApiResult<T = unknown> = Readonly<{
  status: number;
  ok: boolean;
  data: T | null;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    reason?: string;
  } | null;
  /** Secundele din `Retry-After` (la 429), dacă există. */
  retryAfter: number | null;
  /** Corpul JSON complet (de exemplu `{ data, nextCursor }`), sau `null`. */
  raw: unknown;
}>;

export async function apiFetch<T = unknown>(
  path: string,
  init: Readonly<{
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    /** Corpul deja serializat (de exemplu cel legat de cheia de idempotență). */
    rawBody?: string;
    idempotencyKey?: string;
  }>,
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  const payload = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const client = clientHeaderFor(path);
  if (client) headers[CLIENT_HEADER_NAME] = client;
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: payload,
    });
  } catch {
    return { status: 0, ok: false, data: null, error: null, retryAfter: null, raw: null };
  }
  let json: unknown = null;
  if (response.status !== 204) {
    try {
      json = await response.json();
    } catch {
      json = null;
    }
  }
  const body = (json ?? {}) as { data?: T; error?: ApiResult["error"] };
  const retry = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  return {
    status: response.status,
    ok: response.ok,
    data: response.ok ? ((body.data ?? json) as T) : null,
    error: response.ok ? null : (body.error ?? null),
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null,
    raw: json,
  };
}

/** Sesiunea a expirat sau a fost revocată între timp: înapoi la login, cu revenire aici. */
export function goToLogin(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  const target = `/login?next=${encodeURIComponent(next)}`;
  // Navigare completă (nu `router.push`): starea clientului se golește odată cu sesiunea.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- navigare completă intenționată: sesiunea s-a schimbat, cache-ul routerului trebuie golit
  window.location.assign(target);
}
