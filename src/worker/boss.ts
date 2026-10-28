import type { ConstructorOptions } from "pg-boss";

import { VERIFYING_SSL_MODES, databaseTlsParams } from "@/lib/db-url";

/**
 * Opțiunile pg-boss ale workerului FINET (ADR 0011). Funcții pure, testate fără rețea.
 *
 * pg-boss folosește driverul `pg` (nu postgres.js), deci regulile TLS din `src/lib/db-client.ts`
 * se refac aici. Capcana: `pg` ÎNLOCUIEȘTE opțiunea `ssl` dată explicit cu ce deduce din `sslmode`
 * din URL (`Object.assign(config, parse(connectionString))`), deci CA-ul Supabase s-ar pierde în
 * tăcere. De aceea parametrii TLS se scot din URL și se dau DOAR prin `ssl`:
 * - `verify-full` / `verify-ca` → `{ ca?, rejectUnauthorized: true }` (cu CA-ul din
 *   DATABASE_CA_FILE dacă e dat; altfel trust store-ul Node), ca postgres.js;
 * - `require` / `prefer` / `allow` → TLS fără verificarea lanțului (ca postgres.js);
 * - `disable` sau lipsă → fără TLS (dezvoltare, CI).
 */

export const PGBOSS_SCHEMA = "pgboss";

/** Parametrii de URL care țin de TLS (eliminați; TLS-ul vine din `ssl`). */
const TLS_URL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl", "uselibpqcompat"];

export type PgTls = false | { rejectUnauthorized: boolean; ca?: string };

export type PgConnection = Readonly<{ connectionString: string; ssl: PgTls }>;

export function pgConnectionOptions(url: string, ca: string | null): PgConnection {
  const { sslmode } = databaseTlsParams(url);
  const parsed = new URL(url);
  for (const p of TLS_URL_PARAMS) parsed.searchParams.delete(p);
  const connectionString = parsed.toString();
  if (sslmode !== null && VERIFYING_SSL_MODES.includes(sslmode)) {
    return {
      connectionString,
      ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
    };
  }
  if (sslmode === "require" || sslmode === "prefer" || sslmode === "allow") {
    return { connectionString, ssl: { rejectUnauthorized: false } };
  }
  return { connectionString, ssl: false };
}

/**
 * Constructorul pg-boss pentru `finet_app`: fără DDL la rulare (schema o creează migrația 0007,
 * ca `finet_migrator`), deci `migrate`/`createSchema` oprite; fără reconstruirea indecșilor
 * (REINDEX cere proprietarul) și fără statisticile persistate (`queue_stats` e partiționat pe zile,
 * iar partițiile noi ar cere CREATE TABLE). Mentenanța (expirare, retenție) și programarea (cron)
 * rămân pornite: sunt doar DML. Pool mic (modul sesiune al pooler-ului, 5432).
 */
export function bossOptions(url: string, ca: string | null): ConstructorOptions {
  const conn = pgConnectionOptions(url, ca);
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
