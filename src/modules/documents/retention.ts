import "server-only";

import { and, eq, isNotNull, lte, sql } from "drizzle-orm";

import type { Db } from "@/db";
import { documents } from "@/db/schema";
import { type Storage, isStorageKey } from "@/lib/storage";
import { insertAudit } from "@/modules/auth/audit";
import { inHousehold } from "@/modules/ledger/context";

/**
 * Retenția originalelor (Faza 6, F6-C; ADR 0015): după `expires_at`
 * (`RECEIPT_IMAGE_RETENTION_DAYS`), fișierul original (cu EXIF/GPS, așa cum a fost încărcat) se
 * șterge de pe disc; rândul documentului și datele extrase (bonul, liniile, tranzacția) rămân,
 * cu `storage_key = NULL` și `file_deleted_at` (CHECK-ul `documents_file_deleted_shape`).
 *
 * Selecția: funcția SECURITY DEFINER `finet.expired_documents` (0011; doar identificatori). Pentru
 * fiecare document, ca membrul întors de funcție, sub RLS: rândul e re-citit și blocat, apoi
 * ÎNTÂI se șterge fișierul (lipsa lui nu e o eroare), apoi se golește `storage_key`. O eroare
 * după ștergerea fișierului lasă rândul de reluat la rularea următoare (nu un original orfan pe
 * disc). Rulează din CLI-ul de administrare (`cleanup-documents`), care are storage-ul în scriere.
 */

export const RETENTION_BATCH = 200;

export type RetentionResult = Readonly<{ expired: number; failed: number; tempRemoved: number }>;

type ExpiredRef = { document_id: string; household_id: string; actor_user_id: string };

export async function expireDocumentFiles(
  deps: Readonly<{
    db: Db;
    storage: Storage & { cleanupTemp?: (olderThanMs: number) => Promise<number> };
    /** Fișierele temporare `*.tmp-*` mai vechi de atât se șterg (scrieri întrerupte). */
    tempOlderThanMs?: number;
    batch?: number;
    /** Storage-ul pare nemontat: nu se atinge niciun document (doar fișierele temporare). */
    skipFiles?: boolean;
  }>,
): Promise<RetentionResult> {
  const refs: readonly ExpiredRef[] = deps.skipFiles
    ? []
    : await deps.db.execute<ExpiredRef>(
        sql`select document_id, household_id, actor_user_id
          from finet.expired_documents(${deps.batch ?? RETENTION_BATCH}::int)`,
      );
  let expired = 0;
  let failed = 0;
  const perHousehold = new Map<string, { actor: string; n: number }>();
  for (const ref of refs) {
    try {
      const done = await inHousehold(
        { db: deps.db },
        { userId: ref.actor_user_id },
        ref.household_id,
        async (tx) => {
          const [row] = await tx
            .select({ storageKey: documents.storageKey })
            .from(documents)
            .where(
              and(
                eq(documents.householdId, ref.household_id),
                eq(documents.id, ref.document_id),
                isNotNull(documents.storageKey),
                lte(documents.expiresAt, sql`now()`),
              ),
            )
            .limit(1)
            .for("update");
          if (!row?.storageKey || !isStorageKey(row.storageKey)) return false;
          await deps.storage.delete(row.storageKey);
          await tx
            .update(documents)
            .set({ storageKey: null, fileDeletedAt: new Date(), updatedAt: new Date() })
            .where(
              and(eq(documents.householdId, ref.household_id), eq(documents.id, ref.document_id)),
            );
          return true;
        },
      );
      if (done) {
        expired++;
        const h = perHousehold.get(ref.household_id) ?? { actor: ref.actor_user_id, n: 0 };
        h.n++;
        perHousehold.set(ref.household_id, h);
      }
    } catch {
      // Fără detalii (căi, chei): numărul eșecurilor apare în rezultat; rândul se reia data viitoare.
      failed++;
    }
  }
  for (const [householdId, h] of perHousehold) {
    await inHousehold({ db: deps.db }, { userId: h.actor }, householdId, (tx) =>
      insertAudit(tx, h.actor, householdId, {
        action: "documents.expired",
        targetType: "household",
        targetId: householdId,
        metadata: { files: h.n },
      }),
    ).catch(() => undefined);
  }
  let tempRemoved = 0;
  if (deps.tempOlderThanMs !== undefined && deps.storage.cleanupTemp) {
    tempRemoved = await deps.storage.cleanupTemp(deps.tempOlderThanMs);
  }
  return { expired, failed, tempRemoved };
}
