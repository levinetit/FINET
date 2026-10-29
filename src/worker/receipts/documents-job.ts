import "server-only";

import { and, eq, lt, sql } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db";
import { DOCUMENT_MAX_ATTEMPTS, documents } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { type Storage, StorageNotFoundError, isStorageKey } from "@/lib/storage";
import {
  type DocumentRow,
  type QueuedDocument,
  selectQueuedDocuments,
} from "@/modules/documents/documents.repo";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";

import {
  type PreprocessLimits,
  PreprocessError,
  type Preprocessed,
  preprocessDocument,
} from "./preprocess";

/**
 * Pasul de preprocesare al workerului pentru un document (Faza 6, F6-A; ADR 0013). Workerul
 * rulează ca `finet_app` (NOBYPASSRLS): găsește documentele prin funcția SECURITY DEFINER
 * `finet.queued_documents` (doar identificatori), apoi lucrează în contextul RLS al gospodăriei,
 * în numele membrului întors de funcție.
 *
 * 1. `claimDocument` (tranzacție proprie, angajată imediat): `FOR UPDATE SKIP LOCKED`, starea
 *    `processing`, `attempts + 1`, `processing_started_at`. O încercare se numără ÎNAINTE de
 *    lucru: un PDF care omoară procesul (memorie) nu e reluat la nesfârșit (plafonul
 *    `DOCUMENT_MAX_ATTEMPTS`, apoi funcția nu-l mai întoarce).
 * 2. `prepareDocument`: citește originalul (storage doar-citire), îl preprocesează în memorie,
 *    salvează `pages`, `perceptual_hash` și legătura „posibil duplicat” (distanța Hamming ≤
 *    prag; nu blochează nimic). Un document refuzat trece în `rejected` cu un cod stabil.
 *
 * Jobul pg-boss care leagă pașii de AI (F6-B) NU e încă înregistrat în `src/worker/main.ts`:
 * fără pasul următor, un document ar rămâne în `processing`. Funcțiile sunt apelate direct în
 * teste.
 */

export type DocumentJobDeps = LedgerDeps &
  Readonly<{
    storage: Storage;
    limits: PreprocessLimits & Readonly<{ duplicateMaxDistance: number }>;
    log?: (event: Readonly<Record<string, string | number | boolean>>) => void;
  }>;

/** Termenul de lucru: după el, un document `processing` e reluat (worker oprit brusc). */
export const PROCESSING_STALE_SECONDS = 15 * 60;

/** Documentele de procesat, în ordinea încărcării (doar identificatori). */
export function listQueuedDocuments(db: DbOrTx, limit = 10): Promise<QueuedDocument[]> {
  return selectQueuedDocuments(db, limit, PROCESSING_STALE_SECONDS);
}

const actorOf = (ref: QueuedDocument): Actor => ({ userId: ref.actorUserId });

/** Revendică documentul; `null` dacă e luat de alt worker, terminat sau peste plafon. */
export async function claimDocument(
  deps: LedgerDeps,
  ref: QueuedDocument,
  now: Date = new Date(),
): Promise<DocumentRow | null> {
  return inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_SECONDS * 1000);
    const [row] = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.householdId, ref.householdId),
          eq(documents.id, ref.documentId),
          lt(documents.attempts, DOCUMENT_MAX_ATTEMPTS),
          sql`${documents.storageKey} is not null`,
          sql`(${documents.status} = 'queued' or (${documents.status} = 'processing' and (${documents.processingStartedAt} is null or ${documents.processingStartedAt} < ${staleBefore.toISOString()}::timestamptz)))`,
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!row) return null;
    const [claimed] = await tx
      .update(documents)
      .set({
        status: "processing",
        attempts: row.attempts + 1,
        processingStartedAt: now,
        errorCode: null,
        updatedAt: now,
      })
      .where(and(eq(documents.householdId, ref.householdId), eq(documents.id, row.id)))
      .returning();
    return claimed ?? null;
  });
}

async function setOutcome(
  tx: Tx,
  row: DocumentRow,
  patch: Partial<
    Pick<
      DocumentRow,
      | "status"
      | "errorCode"
      | "pages"
      | "perceptualHash"
      | "possibleDuplicateOfId"
      | "processingStartedAt"
    >
  >,
): Promise<void> {
  await tx
    .update(documents)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(documents.householdId, row.householdId), eq(documents.id, row.id)));
}

/** Cel mai apropiat document al gospodăriei după dHash (sub prag), altul decât `row`. */
async function nearestDuplicate(
  tx: Tx,
  row: DocumentRow,
  hash: bigint,
  maxDistance: number,
): Promise<string | null> {
  const distance = sql`bit_count((${documents.perceptualHash} # ${hash.toString()}::bigint)::bit(64))`;
  const [match] = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.householdId, row.householdId),
        sql`${documents.id} <> ${row.id}`,
        sql`${documents.perceptualHash} is not null`,
        sql`${distance} <= ${maxDistance}`,
      ),
    )
    .orderBy(distance, documents.createdAt, documents.id)
    .limit(1);
  return match?.id ?? null;
}

export type PrepareOutcome =
  | Readonly<{ outcome: "skipped" }>
  | Readonly<{ outcome: "rejected"; code: string }>
  | Readonly<{
      outcome: "ready";
      document: DocumentRow;
      preprocessed: Preprocessed;
      possibleDuplicateOfId: string | null;
    }>;

/** Revendică și preprocesează documentul (vezi antetul modulului). */
export async function prepareDocument(
  deps: DocumentJobDeps,
  ref: QueuedDocument,
): Promise<PrepareOutcome> {
  let row: DocumentRow | null;
  try {
    row = await claimDocument(deps, ref);
  } catch (error) {
    // Membrul nu mai e în gospodărie (sau documentul a dispărut): nimic de făcut.
    if (error instanceof NotFoundError) return { outcome: "skipped" };
    throw error;
  }
  if (!row) return { outcome: "skipped" };
  const claimed = row;

  const reject = async (code: string): Promise<PrepareOutcome> => {
    await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
      setOutcome(tx, claimed, { status: "rejected", errorCode: code, processingStartedAt: null }),
    );
    deps.log?.({ job: "documents.prepare", outcome: "rejected", code });
    return { outcome: "rejected", code };
  };

  let input: Buffer;
  try {
    if (!claimed.storageKey || !isStorageKey(claimed.storageKey)) return reject("file_missing");
    // Citire plafonată la dimensiunea înregistrată: un fișier înlocuit pe disc (mai mare) nu
    // ocolește limita de încărcare și nu ajunge întreg în memorie.
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of await deps.storage.openRead(claimed.storageKey)) {
      size += chunk.byteLength;
      if (size > claimed.sizeBytes) return reject("file_changed");
      parts.push(Buffer.from(chunk));
    }
    input = Buffer.concat(parts, size);
  } catch (error) {
    if (error instanceof StorageNotFoundError) return reject("file_missing");
    throw error;
  }

  let preprocessed: Preprocessed;
  try {
    preprocessed = await preprocessDocument(input, claimed.detectedMime, deps.limits);
  } catch (error) {
    if (error instanceof PreprocessError) return reject(error.code);
    throw error;
  }

  const hash = preprocessed.kind === "images" ? (preprocessed.images[0]?.dhash ?? null) : null;
  const possibleDuplicateOfId = await inHousehold(
    deps,
    actorOf(ref),
    ref.householdId,
    async (tx) => {
      const duplicate =
        hash === null
          ? null
          : await nearestDuplicate(tx, claimed, hash, deps.limits.duplicateMaxDistance);
      await setOutcome(tx, claimed, {
        pages: preprocessed.pages,
        perceptualHash: hash,
        possibleDuplicateOfId: duplicate,
      });
      return duplicate;
    },
  );
  deps.log?.({
    job: "documents.prepare",
    outcome: "ready",
    kind: preprocessed.kind,
    pages: preprocessed.pages,
    possibleDuplicate: possibleDuplicateOfId !== null,
  });
  return {
    outcome: "ready",
    document: {
      ...claimed,
      pages: preprocessed.pages,
      perceptualHash: hash,
      possibleDuplicateOfId,
    },
    preprocessed,
    possibleDuplicateOfId,
  };
}
