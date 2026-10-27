import "server-only";

import { resolve } from "node:path";

import { ConfigError, parseConfig } from "@/lib/config";
import { createPostgresClient } from "@/lib/db-client";

import { MigrationError, runMigrations } from "./migrate";

/**
 * Punctul de intrare al containerului `finet-migrate` (ținta `tools` din Dockerfile):
 *   FINET_ROLE=migrate MIGRATOR_DATABASE_URL_FILE=/run/secrets/... node dist/tools/migrate.mjs
 *
 * Configurația trece prin `parseConfig` (aceleași reguli ca aplicația: doar URL-ul rolului
 * `migrate`, CA din DATABASE_CA_FILE cu `sslmode=verify-full`). Directorul migrațiilor:
 * `FINET_MIGRATIONS_DIR` sau `src/db/migrations` față de directorul curent (`/app` în imagine).
 * Cod de ieșire: 0 = succes (inclusiv „nimic de aplicat”), 1 = eroare. Mesajele nu conțin
 * URL-ul sau parola.
 */

export type CliIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}>;

/** Mesajul unei erori, fără detalii care ar putea conține secrete. */
export function describeError(error: unknown): string {
  if (error instanceof ConfigError || error instanceof MigrationError) return error.message;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; name?: unknown };
    // Erorile Postgres (postgres.js: PostgresError) au un cod SQLSTATE și un mesaj fără parolă;
    // erorile de conexiune au doar codul (ECONNREFUSED etc.).
    const code = typeof e.code === "string" ? e.code : null;
    if (e.name === "PostgresError" && typeof e.message === "string") {
      return `eroare PostgreSQL ${code ?? ""}: ${e.message}`.trim();
    }
    if (code) return `eroare de conexiune sau de sistem (${code})`;
  }
  return "eroare neașteptată";
}

export async function main(io: CliIo): Promise<number> {
  let sql: ReturnType<typeof createPostgresClient> | null = null;
  try {
    const config = parseConfig(io.env);
    if (config.role !== "migrate") {
      io.err(`finet-migrate: FINET_ROLE trebuie să fie „migrate” (acum: ${config.role})`);
      return 1;
    }
    const url = config.database.url;
    if (!url) {
      io.err("finet-migrate: lipsește MIGRATOR_DATABASE_URL(_FILE)");
      return 1;
    }
    const folder = resolve(io.cwd, io.env.FINET_MIGRATIONS_DIR || "src/db/migrations");
    sql = createPostgresClient(url, {
      ca: config.database.ca,
      applicationName: "finet-migrate",
      max: 1,
      connectTimeoutSeconds: 10,
    });
    const result = await runMigrations(sql, { folder, log: (l) => io.out(`finet-migrate: ${l}`) });
    io.out(
      `finet-migrate: gata; aplicate acum ${result.applied.length}, deja aplicate ${result.alreadyApplied}`,
    );
    return 0;
  } catch (error) {
    io.err(`finet-migrate: EȘEC: ${describeError(error)}`);
    return 1;
  } finally {
    await sql?.end({ timeout: 5 });
  }
}
