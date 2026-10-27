import "server-only";

import postgres from "postgres";

import { VERIFYING_SSL_MODES, databaseTlsParams } from "@/lib/db-url";

/**
 * Clientul Postgres comun (postgres.js). Orice cod care deschide conexiuni la bază (acum
 * `/api/health`; din Faza 1 Drizzle, migrațiile, workerul) trece pe aici, ca regulile TLS să fie
 * aceleași peste tot.
 *
 * TLS după `sslmode` din URL (postgres.js NU citește `sslrootcert` din URL, iar config.ts îl
 * refuză):
 * - `verify-full` / `verify-ca` + `DATABASE_CA_FILE` → `ssl: { ca, rejectUnauthorized: true }`:
 *   certificatul serverului trebuie semnat de ACEST CA (de exemplu CA-ul Supabase), nu de
 *   oricare CA public. Numele serverului se verifică în ambele moduri (Node îl verifică
 *   implicit; `verify-ca` e deci la fel de strict ca `verify-full`, decizia mea);
 * - `verify-full` / `verify-ca` fără CA → comportamentul postgres.js: TLS verificat față de
 *   trust store-ul Node (CA-urile publice plus `NODE_EXTRA_CA_CERTS`, dacă e setată la pornire);
 * - `require` / `prefer` / `allow` → TLS FĂRĂ verificarea lanțului de certificate (postgres.js
 *   pune `rejectUnauthorized: false`): criptat, dar fără protecție față de un intermediar;
 * - `disable` sau lipsă → fără TLS (dezvoltare, CI).
 */

/** Opțiunea `ssl` explicită, doar când avem un CA de impus; altfel `undefined` (din URL). */
export function sslOptionFor(
  url: string,
  ca: string | null,
): { ca: string; rejectUnauthorized: true } | undefined {
  if (!ca) return undefined;
  const { sslmode } = databaseTlsParams(url);
  return sslmode !== null && VERIFYING_SSL_MODES.includes(sslmode)
    ? { ca, rejectUnauthorized: true }
    : undefined;
}

export type DbClientOptions = Readonly<{
  /** Conținutul PEM al CA-ului (`config.database.ca`) sau `null`. */
  ca: string | null;
  /** `application_name` în Postgres (vizibil în `pg_stat_activity`). */
  applicationName: string;
  max?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutSeconds?: number;
}>;

export type PostgresOptions = postgres.Options<Record<string, postgres.PostgresType>>;

/** Opțiunile postgres.js pentru un URL (funcție pură, testată fără rețea). */
export function postgresOptions(url: string, options: DbClientOptions): PostgresOptions {
  const ssl = sslOptionFor(url, options.ca);
  return {
    max: options.max ?? 1,
    // Necesar cu pooler-ul Supabase în modul tranzacție (6543).
    prepare: false,
    idle_timeout: options.idleTimeoutSeconds ?? 30,
    connect_timeout: options.connectTimeoutSeconds ?? 3,
    onnotice: () => {},
    connection: { application_name: options.applicationName },
    // O opțiune `ssl` explicită are prioritate față de `sslmode` din URL în postgres.js.
    ...(ssl ? { ssl } : {}),
  };
}

export function createPostgresClient(url: string, options: DbClientOptions): postgres.Sql {
  return postgres(url, postgresOptions(url, options));
}
