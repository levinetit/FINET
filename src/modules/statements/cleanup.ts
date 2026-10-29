import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db";
import { type Storage, StorageNotFoundError, isKeyOfHousehold } from "@/lib/storage";

/**
 * Curățarea extraselor (F7-B; ADR 0018 §11), rulată de `finet-admin cleanup-documents` (storage-ul
 * în scriere):
 *
 * 1. fișierele PDF încărcate: cele expirate (24 h) sau eșuate, inclusiv cele al căror autor nu mai
 *    e membru — funcția SECURITY DEFINER `cleanable_statement_uploads` (doar identificatori și
 *    cheia). ÎNTÂI se șterge fișierul (lipsa lui nu e o eroare), apoi `forget_statement_upload_file`
 *    golește cheia (doar dacă e aceeași). Un eșec lasă rândul pentru rularea următoare, nu un
 *    fișier orfan fără evidență;
 * 2. previzualizările neconfirmate mai vechi de 7 zile (`purge_stale_statement_previews`), cu
 *    rândurile lor; cota zilnică nu se eliberează.
 *
 * Ieșirea: doar contoare (fără chei, căi, nume).
 */

export const STATEMENT_CLEANUP_BATCH = 200;
export const STALE_PREVIEW_DAYS = 7;

export type StatementCleanupResult = Readonly<{ files: number; failed: number; previews: number }>;

type Cleanable = { upload_id: string; household_id: string; storage_key: string };

export async function cleanupStatementFiles(
  deps: Readonly<{ db: Db; storage: Storage; skipFiles?: boolean; batch?: number }>,
): Promise<StatementCleanupResult> {
  let files = 0;
  let failed = 0;
  if (!deps.skipFiles) {
    const rows = await deps.db.execute<Cleanable>(
      sql`select upload_id, household_id, storage_key
            from finet.cleanable_statement_uploads(${deps.batch ?? STATEMENT_CLEANUP_BATCH}::int)`,
    );
    for (const r of rows) {
      try {
        // Apărare în adâncime: cheia trebuie să fie a gospodăriei rândului (peste CHECK-ul din bază).
        if (!isKeyOfHousehold(r.storage_key, r.household_id)) {
          failed++;
          continue;
        }
        try {
          await deps.storage.delete(r.storage_key);
        } catch (error) {
          if (!(error instanceof StorageNotFoundError)) throw error;
        }
        const [ok] = await deps.db.execute<{ ok: boolean }>(
          sql`select finet.forget_statement_upload_file(${r.upload_id}::uuid, ${r.storage_key}) as ok`,
        );
        if (ok?.ok) files++;
      } catch {
        failed++;
      }
    }
  }
  const [purged] = await deps.db.execute<{ n: number }>(
    sql`select finet.purge_stale_statement_previews(${STALE_PREVIEW_DAYS}::int, 500::int) as n`,
  );
  return { files, failed, previews: purged?.n ?? 0 };
}
