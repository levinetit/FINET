/**
 * Antetele de securitate (master prompt 6.3), puse de `src/proxy.ts` pe TOATE răspunsurile
 * care trec prin el (inclusiv 403 și redirecționările proprii) și, fără CSP, de
 * `next.config.ts` pe asset-urile statice (`/_next/static/`, excluse din matcher).
 *
 * CSP cu nonce per cerere: Next.js citește nonce-ul din antetul `Content-Security-Policy` al
 * CERERII (pus de proxy) și îl atașează scripturilor proprii (runtime, chunk-uri, payload-ul
 * RSC inline). De aceea paginile sunt randate dinamic (layout-ul rădăcină citește `headers()`).
 *
 * Decizii (ADR 0003, „UI și antete (F1-C)”):
 * - `script-src 'self' 'nonce-…'`, fără `'strict-dynamic'`: chunk-urile vin de pe aceeași origine.
 * - `style-src 'self' 'nonce-…'` în producție (Tailwind e compilat în fișiere CSS; fără
 *   `'unsafe-inline'`, deci fără atribute `style="…"` în markup). În dezvoltare
 *   `'unsafe-inline'` (overlay-ul de erori Next folosește stiluri inline) și `'unsafe-eval'`
 *   (React reconstruiește stivele de erori cu `eval`); niciuna nu ajunge în producție.
 * - Fără `upgrade-insecure-requests` (HSTS acoperă producția; ar strica testele locale pe http).
 * - HSTS fără `preload` (decizia operatorului, după ce domeniul e stabil).
 * - CORS închis: niciun `Access-Control-Allow-*` nu se pune nicăieri.
 */

/** Antetul intern prin care nonce-ul ajunge la randare (în cerere, nu în răspuns). */
export const NONCE_HEADER = "x-nonce";

export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/** Antetele fixe, fără CSP (CSP depinde de nonce). */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Strict-Transport-Security": HSTS_VALUE,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
});

/**
 * Faza 8 (revizuirea F8-B): pe `/join/<token>` browserul nu trimite deloc antetul Referer, ca
 * tokenul invitației să nu plece nicăieri. Pe `/login?next=/join/<token>` rămâne implicitul
 * `strict-origin-when-cross-origin` (spre alte origini pleacă doar originea; CSP permite doar
 * `'self'`); canalul e documentat ca risc acceptat (SECURITY_CHECKLIST §20).
 */
export function referrerPolicyFor(pathname: string): string | null {
  return pathname.startsWith("/join/") ? "no-referrer" : null;
}

/** Un nonce nou: 16 octeți aleatori, base64 (128 de biți). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

export type CspOptions = Readonly<{
  development: boolean;
  /**
   * Doar pe paginile publice ale site-ului `saas`, când există un identificator Google Analytics:
   * permite domeniile etichetei Google (scriptul se încarcă oricum numai după consimțământ).
   */
  analytics?: boolean;
}>;

const GA_SCRIPT = "https://www.googletagmanager.com";
const GA_CONNECT =
  "https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com";
const GA_IMG = "https://www.google-analytics.com https://www.googletagmanager.com";

export function buildCsp(nonce: string, options: CspOptions): string {
  const n = `'nonce-${nonce}'`;
  const directives: [string, string][] = [
    ["default-src", "'self'"],
    [
      "script-src",
      (options.development ? `'self' ${n} 'unsafe-eval'` : `'self' ${n}`) +
        (options.analytics ? ` ${GA_SCRIPT}` : ""),
    ],
    ["style-src", options.development ? "'self' 'unsafe-inline'" : `'self' ${n}`],
    ["img-src", options.analytics ? `'self' data: ${GA_IMG}` : "'self' data:"],
    ["font-src", "'self'"],
    ["connect-src", options.analytics ? `'self' ${GA_CONNECT}` : "'self'"],
    ["frame-ancestors", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

/** Pune antetele de securitate pe un răspuns (suprascrie, nu dublează). */
export function applySecurityHeaders(headers: Headers, csp: string): void {
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) headers.set(name, value);
  headers.set("Content-Security-Policy", csp);
}
