import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db";

import { type DeletionDeps, eraseAccount } from "./account-deletion";

/**
 * Curățarea conturilor de înregistrare publică rămase neconfirmate (revizia Fazei 11,
 * SECURITY_CHECKLIST §36). Un cont creat la pasul 1 (ADR 0029) și neconfirmat în `days` zile nu are
 * parolă, sesiune sau date: se șterge cu aceeași logică ca ștergerea contului din GDPR (ADR 0021).
 *
 * Alegerea o face `finet.stale_unverified_users` (0021): email neverificat, activ, fără parolă,
 * fără sesiune, fără gospodărie comună, nu administrator. Aici se șterge fiecare cont într-o
 * tranzacție proprie (o eroare la unul nu oprește restul) și se numără; fără id-uri sau emailuri
 * în rezultat.
 */

export const DEFAULT_UNVERIFIED_DAYS = 7;

export type PurgeResult = Readonly<{ found: number; purged: number; failed: number }>;

export async function listStaleUnverifiedUsers(
  db: Db,
  days: number,
  limit: number,
): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(
    sql`select user_id from finet.stale_unverified_users(${days}, ${limit})`,
  );
  return rows.map((r) => r.user_id);
}

/** `apply = false`: doar numără (dry-run), nu șterge nimic. */
export async function purgeUnverifiedAccounts(
  deps: DeletionDeps,
  options: Readonly<{ days?: number; limit?: number; apply: boolean }>,
): Promise<PurgeResult> {
  const ids = await listStaleUnverifiedUsers(
    deps.db,
    options.days ?? DEFAULT_UNVERIFIED_DAYS,
    options.limit ?? 200,
  );
  if (!options.apply) return { found: ids.length, purged: 0, failed: 0 };
  let purged = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await eraseAccount(deps, id);
      purged += 1;
    } catch {
      failed += 1;
    }
  }
  return { found: ids.length, purged, failed };
}
