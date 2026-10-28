/**
 * Parametrii TLS dintr-un URL Postgres, fără să-l modifice și fără să întoarcă alte părți din
 * el (parola rămâne doar în URL). Folosit de `src/lib/config.ts` (validare) și de
 * `src/lib/db-client.ts` (opțiunile clientului). Un URL care nu se poate analiza întoarce
 * `sslmode: null` (comportamentul implicit al driverului).
 */
export type DatabaseTlsParams = Readonly<{
  /** Valoarea `sslmode` (de exemplu `disable`, `require`, `verify-full`) sau `null`. */
  sslmode: string | null;
  /** `true` dacă URL-ul conține `sslrootcert` (nesuportat de postgres.js, vezi config.ts). */
  hasSslRootCert: boolean;
}>;

/** Modurile în care certificatul serverului trebuie verificat față de un CA. */
export const VERIFYING_SSL_MODES: readonly string[] = ["verify-full", "verify-ca"];

export function databaseTlsParams(url: string): DatabaseTlsParams {
  try {
    const params = new URL(url).searchParams;
    return { sslmode: params.get("sslmode"), hasSslRootCert: params.has("sslrootcert") };
  } catch {
    return { sslmode: null, hasSslRootCert: false };
  }
}

/**
 * `true` pentru un parametru de URL care ține de TLS, în orice grafie (`sslmode`, `SSLMode`,
 * `ssl`, `sslrootcert`, `sslcert`, `sslkey`, `sslnegotiation`, `uselibpqcompat` …). Folosit de
 * regulile fail-closed ale workerului (config.ts, src/worker/boss.ts).
 */
export function isTlsUrlParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("ssl") || n === "uselibpqcompat";
}
