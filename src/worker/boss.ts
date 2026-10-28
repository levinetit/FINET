import type { ConstructorOptions } from "pg-boss";

import { isTlsUrlParam } from "@/lib/db-url";

/**
 * Opțiunile pg-boss ale workerului FINET (ADR 0011). Funcții pure, testate fără rețea.
 *
 * pg-boss folosește driverul `pg` (nu postgres.js). Capcana: `pg` ÎNLOCUIEȘTE opțiunea `ssl` dată
 * explicit cu ce deduce din parametrii URL-ului (`Object.assign(config, parse(connectionString))`),
 * deci CA-ul Supabase s-ar pierde în tăcere. De aceea parametrii TLS se scot din URL și TLS-ul se
 * dă DOAR prin `ssl`, după reguli FAIL-CLOSED (nicio formă necunoscută nu oprește TLS-ul tăcut):
 * - exact un `sslmode`, scris exact (`verify-full`, `verify-ca`, `require`, `disable`); orice alt
 *   parametru TLS (`ssl`, `sslrootcert`, `SSLMODE`, `uselibpqcompat` …), o valoare goală,
 *   necunoscută, altă grafie sau un duplicat → `PgTlsConfigError`;
 * - implicit (ORICE mediu, revizuirea F5, I2): doar `verify-full` + CA → `{ ca,
 *   rejectUnauthorized: true }`; orice altceva → eroare (config.ts cere același lucru);
 * - cu `allowInsecure` (`FINET_ALLOW_INSECURE_DB=1`, doar teste/CI, refuzat de config.ts în
 *   producție): și `verify-ca`/`verify-full` fără CA (trust store), `require` (TLS fără lanț),
 *   `disable` / lipsă (fără TLS). `prefer`/`allow` (pot cădea pe text clar) → eroare oriunde.
 */

export const PGBOSS_SCHEMA = "pgboss";

/** Configurația TLS a workerului e invalidă. Mesajul nu conține URL-ul sau valorile lui. */
export class PgTlsConfigError extends Error {
  constructor(readonly problem: string) {
    super(`TLS-ul workerului e configurat greșit: ${problem}`);
    this.name = "PgTlsConfigError";
  }
}

export type PgTls = false | { rejectUnauthorized: boolean; ca?: string };

export type PgConnection = Readonly<{ connectionString: string; ssl: PgTls }>;

export type PgTlsOptions = Readonly<{
  /** `config.database.allowInsecure` (`FINET_ALLOW_INSECURE_DB=1`, doar teste/CI). */
  allowInsecure: boolean;
}>;

export function pgConnectionOptions(
  url: string,
  ca: string | null,
  options: PgTlsOptions,
): PgConnection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PgTlsConfigError("URL-ul bazei nu poate fi analizat");
  }
  const keys = [...new Set(parsed.searchParams.keys())].filter(isTlsUrlParam);
  if (keys.some((k) => k !== "sslmode")) {
    throw new PgTlsConfigError("parametru TLS nepermis în URL (doar sslmode, scris exact)");
  }
  const modes = parsed.searchParams.getAll("sslmode");
  if (modes.length > 1) throw new PgTlsConfigError("sslmode apare de mai multe ori");
  const mode = modes[0] ?? null;
  parsed.searchParams.delete("sslmode");
  const connectionString = parsed.toString();

  if (!options.allowInsecure) {
    if (mode !== "verify-full" || !ca) {
      throw new PgTlsConfigError("cere sslmode=verify-full și CA-ul (DATABASE_CA_FILE)");
    }
    return { connectionString, ssl: { ca, rejectUnauthorized: true } };
  }
  switch (mode) {
    case "verify-full":
    case "verify-ca":
      return {
        connectionString,
        ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
      };
    case "require":
      return { connectionString, ssl: { rejectUnauthorized: false } };
    case "disable":
    case null:
      return { connectionString, ssl: false };
    default:
      throw new PgTlsConfigError("valoare sslmode nepermisă");
  }
}

/**
 * Constructorul pg-boss pentru `finet_app`: fără DDL la rulare (schema o creează migrația 0007,
 * ca `finet_migrator`), deci `migrate`/`createSchema` oprite; fără reconstruirea indecșilor
 * (REINDEX cere proprietarul) și fără statisticile persistate (`queue_stats` e partiționat pe zile,
 * iar partițiile noi ar cere CREATE TABLE). Mentenanța (expirare, retenție) și programarea (cron)
 * rămân pornite: sunt doar DML. Pool mic (modul sesiune al pooler-ului, 5432).
 */
export function bossOptions(
  url: string,
  ca: string | null,
  options: PgTlsOptions,
): ConstructorOptions {
  const conn = pgConnectionOptions(url, ca, options);
  return {
    connectionString: conn.connectionString,
    ssl: conn.ssl,
    schema: PGBOSS_SCHEMA,
    application_name: "finet-worker-boss",
    max: 3,
    migrate: false,
    createSchema: false,
    reindex: false,
    persistQueueStats: false,
    persistWarnings: false,
    supervise: true,
    schedule: true,
  };
}
