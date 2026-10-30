/**
 * Paginile PUBLICE ale site-ului (Faza 11, ADR 0027), existente doar în modul `saas`: prezentarea
 * (`/`), prețurile, termenii și confidențialitatea. Singurele pe care se încarcă (după consimțământ)
 * analytics-ul și pe care CSP-ul permite domeniile lui. Aplicația autentificată nu le conține
 * niciodată.
 */
const PUBLIC_SITE_PATHS: ReadonlySet<string> = new Set(["/", "/pricing", "/terms", "/privacy"]);

export function isPublicSitePath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PUBLIC_SITE_PATHS.has(path);
}

/** Legăturile consumatorilor din România (master prompt, Faza 11): ANPC SAL și platforma SOL a UE. */
export const CONSUMER_LINKS = Object.freeze({
  anpcSal: "https://anpc.ro/ce-este-sal/",
  sol: "https://ec.europa.eu/consumers/odr",
});
