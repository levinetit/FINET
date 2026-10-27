import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";

import { getConfig } from "@/lib/config";
import { createPostgresClient } from "@/lib/db-client";

import { type Db, type RlsContext, type Tx, withRlsOn } from "./rls";
import * as schema from "./schema";

/**
 * Clientul Drizzle al procesului (rolurile `web` și `worker`), pe `postgresOptions()` din
 * `src/lib/db-client.ts`: aceleași reguli TLS, `prepare: false` (pooler-ul Supabase în modul
 * tranzacție), pool mic.
 *
 * Accesul la datele unei gospodării trece DOAR prin `withRls` (contextul RLS). Fără context,
 * politicile nu întorc niciun rând. Tabelele de autentificare (fără RLS) le folosește stratul de
 * autentificare (F1-B) prin `getDb()`.
 */

export type { Db, RlsContext, Tx } from "./rls";
export { RlsContextError, isUuid, withRlsOn } from "./rls";

/** Pool implicit (decizia mea): mic, sub limitele planului Supabase (docs/INFRA.md). */
export const DEFAULT_POOL_MAX = 5;

export type CreateDbOptions = Readonly<{
  ca: string | null;
  applicationName: string;
  /** Conexiuni maxime în pool (implicit `DEFAULT_POOL_MAX`). */
  max?: number;
}>;

/** Un client Drizzle nou (folosit de `getDb()` și de teste). */
export function createDb(url: string, options: CreateDbOptions): { db: Db; client: postgres.Sql } {
  const client = createPostgresClient(url, {
    ca: options.ca,
    applicationName: options.applicationName,
    max: options.max ?? DEFAULT_POOL_MAX,
  });
  return { db: drizzle({ client, schema }), client };
}

let cached: { db: Db; client: postgres.Sql } | null = null;

/** Clientul procesului curent, creat leneș la primul apel (după validarea configurației). */
export function getDb(options: Readonly<{ max?: number }> = {}): Db {
  if (cached) return cached.db;
  const config = getConfig();
  if (config.role === "migrate") {
    throw new Error(
      "getDb: rolul `migrate` folosește runner-ul de migrații, nu clientul aplicației",
    );
  }
  if (!config.database.url) {
    throw new Error("getDb: lipsește URL-ul bazei de date pentru rolul curent");
  }
  cached = createDb(config.database.url, {
    ca: config.database.ca,
    applicationName: `finet-${config.role}`,
    max: options.max,
  });
  return cached.db;
}

/** Rulează `fn` într-o tranzacție cu contextul RLS, pe clientul procesului. */
export function withRls<T>(context: RlsContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRlsOn(getDb(), context, fn);
}

/** Închide pool-ul (oprirea procesului, teste). */
export async function closeDb(): Promise<void> {
  const current = cached;
  cached = null;
  await current?.client.end({ timeout: 5 });
}
