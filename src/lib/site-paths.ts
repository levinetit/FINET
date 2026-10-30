/**
 * Paginile PUBLICE ale site-ului (Faza 11, ADR 0027), existente doar în modul `saas`: prezentarea
 * (`/`), prețurile, termenii, confidențialitatea și suportul (`/support`; ghidul din aplicație rămâne `/help`, în zona autentificată). Paginile care colectează
 * parole (`/register`, `/register/complete`) NU sunt aici: fără analytics și fără CSP relaxat. Singurele pe care se încarcă (după consimțământ)
 * analytics-ul și pe care CSP-ul permite domeniile lui. Aplicația autentificată nu le conține
 * niciodată.
 */
const PUBLIC_SITE_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/pricing",
  "/terms",
  "/privacy",
  "/support",
]);

export function isPublicSitePath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PUBLIC_SITE_PATHS.has(path);
}

/** Legăturile consumatorilor din România (master prompt, Faza 11): ANPC SAL și platforma SOL a UE. */
export const CONSUMER_LINKS = Object.freeze({
  anpcSal: "https://anpc.ro/ce-este-sal/",
  sol: "https://ec.europa.eu/consumers/odr",
});

/**
 * Singura pagină care încarcă widgetul Turnstile (F11-C2, ADR 0030) și al cărei CSP permite
 * `challenges.cloudflare.com`: formularul de înregistrare. `/register/complete` și `/login` nu.
 */
export function isTurnstilePath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return path === "/register";
}
