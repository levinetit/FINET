/**
 * Apelurile din browser către API-ul FINET (`/api/auth/*`, `/api/v1/*`): aceleași rute ca
 * clientul Android, deci aceleași reguli (validare, rate limiting, CSRF prin `Origin`, audit).
 * Doar JSON, aceeași origine, fără cache.
 */

export type ApiResult<T = unknown> = Readonly<{
  status: number;
  ok: boolean;
  data: T | null;
  error: { code: string; message: string; fields?: Record<string, string> } | null;
  /** Secundele din `Retry-After` (la 429), dacă există. */
  retryAfter: number | null;
}>;

export async function apiFetch<T = unknown>(
  path: string,
  init: Readonly<{ method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown }>,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      credentials: "same-origin",
      cache: "no-store",
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { status: 0, ok: false, data: null, error: null, retryAfter: null };
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
