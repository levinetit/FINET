import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db";
import { documentUsageDaily, documents, processingBatches } from "@/db/schema";

/**
 * Accesul la documente (în tranzacția `withMember`, cu RLS și filtru explicit pe gospodărie).
 * Excepția: `selectQueuedDocuments` apelează funcția SECURITY DEFINER `finet.queued_documents`
 * (workerul, fără context de gospodărie), care întoarce doar identificatori.
 */

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;

export async function selectDocument(
  tx: Tx,
  householdId: string,
  id: string,
): Promise<DocumentRow | null> {
  const [row] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.householdId, householdId), eq(documents.id, id)))
    .limit(1);
  return row ?? null;
}

/** Documentele existente ale gospodăriei cu aceste rezumate SHA-256 (deduplicarea exactă). */
export async function selectBySha256(
  tx: Tx,
  householdId: string,
  hashes: readonly string[],
): Promise<DocumentRow[]> {
  if (hashes.length === 0) return [];
  return tx
    .select()
    .from(documents)
    .where(and(eq(documents.householdId, householdId), inArray(documents.sha256, [...hashes])));
}

/**
 * Lock consultativ pe gospodărie până la sfârșitul tranzacției: două încărcări simultane se
 * serializează, deci limita zilnică și cota nu pot fi depășite prin cereri paralele.
 */
export async function lockHouseholdDocuments(tx: Tx, householdId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`finet.documents:${householdId}`}))`,
  );
}

/**
 * Documentele încărcate în ziua locală `day` (YYYY-MM-DD, Europe/Bucharest), din contorul
 * `document_usage_daily`, care doar crește: ștergerea unui document nu eliberează limita.
 */
export async function usageOfDay(tx: Tx, householdId: string, day: string): Promise<number> {
  const [row] = await tx
    .select({ n: documentUsageDaily.count })
    .from(documentUsageDaily)
    .where(and(eq(documentUsageDaily.householdId, householdId), eq(documentUsageDaily.day, day)))
    .limit(1);
  return row?.n ?? 0;
}

/** Adaugă `n` documente la contorul zilei (atomic, în tranzacția încărcării). */
export async function addUsage(tx: Tx, householdId: string, day: string, n: number): Promise<void> {
  if (n <= 0) return;
  await tx
    .insert(documentUsageDaily)
    .values({ householdId, day, count: n })
    .onConflictDoUpdate({
      target: [documentUsageDaily.householdId, documentUsageDaily.day],
      set: { count: sql`${documentUsageDaily.count} + ${n}`, updatedAt: new Date() },
    });
}

/** Octeții ocupați de fișierele încă stocate ale gospodăriei (cota). */
export async function storedBytes(tx: Tx, householdId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`coalesce(sum(${documents.sizeBytes}), 0)::text` })
    .from(documents)
    .where(and(eq(documents.householdId, householdId), sql`${documents.storageKey} is not null`));
  // Suma încape sigur în 2^53 (cota maximă e de ordinul GB), dar se citește ca text și se verifică.
  const n = Number(row?.n ?? "0");
  if (!Number.isSafeInteger(n)) throw new Error("documents: suma dimensiunilor e în afara plajei");
  return n;
}

/** Inserează documentul; `null` dacă același fișier a apărut între timp (cursă pe sha256). */
export async function insertDocumentRow(tx: Tx, row: NewDocumentRow): Promise<DocumentRow | null> {
  const [inserted] = await tx
    .insert(documents)
    .values(row)
    .onConflictDoNothing({ target: [documents.householdId, documents.sha256] })
    .returning();
  return inserted ?? null;
}

export async function insertBatch(
  tx: Tx,
  householdId: string,
  createdByUserId: string,
  kind: "single" | "long_receipt",
): Promise<string> {
  const [row] = await tx
    .insert(processingBatches)
    .values({ householdId, createdByUserId, kind })
    .returning({ id: processingBatches.id });
  return row!.id;
}

/** Șterge documentul și întoarce cheia fișierului (sau `null` dacă nu există / nu mai are fișier). */
export async function deleteDocumentRow(
  tx: Tx,
  householdId: string,
  id: string,
): Promise<{ storageKey: string | null } | null> {
  const [row] = await tx
    .delete(documents)
    .where(and(eq(documents.householdId, householdId), eq(documents.id, id)))
    .returning({ storageKey: documents.storageKey });
  return row ?? null;
}

/** Documentele `awaiting_consent` încărcate de utilizator → `queued` (după consimțământ). */
export async function queueAwaitingConsentRows(
  tx: Tx,
  householdId: string,
  userId: string,
): Promise<number> {
  const rows = await tx
    .update(documents)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(documents.householdId, householdId),
        eq(documents.uploadedByUserId, userId),
        eq(documents.status, "awaiting_consent"),
      ),
    )
    .returning({ id: documents.id });
  return rows.length;
}

export type QueuedDocument = Readonly<{
  documentId: string;
  householdId: string;
  actorUserId: string;
}>;

/** Documentele de procesat (funcția SECURITY DEFINER; doar identificatori). */
export async function selectQueuedDocuments(
  tx: DbOrTx,
  limit: number,
  staleSeconds: number,
): Promise<QueuedDocument[]> {
  const rows = await tx.execute<{
    document_id: string;
    household_id: string;
    actor_user_id: string;
  }>(sql`select document_id, household_id, actor_user_id
           from finet.queued_documents(${limit}::int, ${staleSeconds}::int)`);
  return rows.map((r) => ({
    documentId: r.document_id,
    householdId: r.household_id,
    actorUserId: r.actor_user_id,
  }));
}

/**
 * Un singur document de procesat (funcția SECURITY DEFINER `queued_document` din 0009): jobul
 * `receipt.process` re-derivă aici gospodăria și membrul, nu le ia din datele jobului.
 */
export async function selectQueuedDocument(
  tx: DbOrTx,
  documentId: string,
): Promise<QueuedDocument | null> {
  const rows = await tx.execute<{
    document_id: string;
    household_id: string;
    actor_user_id: string;
  }>(sql`select document_id, household_id, actor_user_id
           from finet.queued_document(${documentId}::uuid)`);
  const r = rows[0];
  return r
    ? { documentId: r.document_id, householdId: r.household_id, actorUserId: r.actor_user_id }
    : null;
}
