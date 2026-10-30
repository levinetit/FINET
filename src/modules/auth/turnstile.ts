import "server-only";

/**
 * Verificarea serverului pentru Cloudflare Turnstile (Faza 11-C2, ADR 0030). FAIL-CLOSED: orice
 * lucru în afară de un răspuns 200 cu JSON valid, `success: true` și numele de gazdă al aplicației
 * înseamnă respingere (rețea căzută, timeout, status non-200, JSON invalid, câmpuri lipsă). Opusul
 * HIBP-ului din politica parolei (acolo e fail-open, aici verificarea E controlul de securitate).
 *
 * Documentația Cloudflare: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` cu
 * `secret`, `response` (cel mult 2048 de caractere, valabil 300 s, de unică folosință) și opțional
 * `remoteip`; răspunsul are `success`, `hostname`, `error-codes`.
 */

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TOKEN_MAX = 2048;
const TIMEOUT_MS = 5000;

/** `true` doar pentru un token acceptat de Cloudflare pentru această gazdă. */
export type TurnstileVerifier = (token: string, remoteIp: string | null) => Promise<boolean>;

export type TurnstileFetcher = (
  url: string,
  init: { method: "POST"; body: URLSearchParams; signal: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export function createTurnstileVerifier(
  options: Readonly<{
    secretKey: string;
    /** Gazda aplicației (din `APP_URL`): răspunsul trebuie să o confirme. */
    hostname: string;
    fetcher?: TurnstileFetcher;
    timeoutMs?: number;
  }>,
): TurnstileVerifier {
  const fetcher: TurnstileFetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  return async (token, remoteIp) => {
    if (typeof token !== "string" || token.length === 0 || token.length > TURNSTILE_TOKEN_MAX) {
      return false;
    }
    const body = new URLSearchParams({ secret: options.secretKey, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
    try {
      const response = await fetcher(TURNSTILE_VERIFY_URL, {
        method: "POST",
        body,
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const result = (await response.json()) as { success?: unknown; hostname?: unknown } | null;
      return (
        result !== null &&
        typeof result === "object" &&
        result.success === true &&
        result.hostname === options.hostname
      );
    } catch {
      // Fără detalii: nici cheia, nici tokenul nu au ce căuta într-un log.
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}
