import "server-only";

import { z } from "zod";

import type { Tx } from "@/db";
import { DOCUMENT_STATUSES } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { DEFAULT_TIME_ZONE, localDateOf } from "@/lib/calendar";
import type { Config } from "@/lib/config";
import { ConflictError, ValidationError } from "@/lib/errors";
import { type Storage, type StorageKey, isStorageKey, storageKeyName } from "@/lib/storage";
import { insertAudit } from "@/modules/auth/audit";
import { type Entitlements, createEntitlements } from "@/modules/entitlements";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { hasActiveConsent } from "@/modules/usage/consents";

import {
  type DocumentRow,
  addUsage,
  deleteDocumentRow,
  insertBatch,
  insertDocumentRow,
  lockHouseholdDocuments,
  queueAwaitingConsentRows,
  selectBySha256,
  selectDocument,
  selectDocumentsWithReceipt,
  storedBytes,
  usageOfDay,
} from "./documents.repo";
import {
  type DailyUsage,
  type DocumentView,
  type UploadResult,
  type UploadedDocument,
  uploadFieldsSchema,
} from "./documents.schema";
import { type ReceivedFile, type ReceivedUpload, receiveMultipart } from "./multipart";

/**
 * Documentele încărcate (Faza 6; ADR 0013): înregistrarea după încărcare, deduplicarea exactă,
 * limita zilnică, cota, consimțământul pentru AI extern și ștergerea.
 *
 * Ordinea înregistrării (de aici vine „deduplicarea nu e limitată de plan”):
 * 1. fișierele sunt deja în storage (`receiveMultipart`), validate după conținut;
 * 2. pentru fiecare SHA-256 deja existent în gospodărie se întoarce documentul existent (fără
 *    cotă, fără limită zilnică), iar fișierul nou scris se șterge;
 * 3. abia apoi, sub un lock pe gospodărie: limita zilnică (`ai.dailyDocuments`, din contorul
 *    `document_usage_daily`, care doar crește: ștergerea nu eliberează limita) și cota
 *    (`storage.quotaMb`) pentru documentele NOI, apoi inserarea (`ON CONFLICT DO NOTHING` pe
 *    `(household_id, sha256)`: o cursă cu altă cerere devine tot duplicat, nu eroare).
 * Starea inițială: `queued` dacă cel care încarcă are consimțământul `external_ai` activ (în
 * Faza 6 nu există model local, deci fără el nu se procesează nimic), altfel `awaiting_consent`
 * (bonul se poate introduce manual).
 */

export type DocumentsDeps = LedgerDeps &
  Readonly<{
    storage: Storage;
    config: Pick<Config, "appMode" | "ai" | "storage" | "documents">;
    /** Implicit din configurație; injectabil în teste. */
    entitlements?: Entitlements;
    now?: () => Date;
  }>;

const MB = 1024 * 1024;

export function entitlementsOf(deps: Pick<DocumentsDeps, "entitlements" | "config">): Entitlements {
  return deps.entitlements ?? createEntitlements(deps.config.appMode, deps.config);
}

export function documentView(row: DocumentRow): DocumentView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    mime: row.detectedMime,
    sizeBytes: row.sizeBytes,
    pages: row.pages,
    batchId: row.batchId,
    documentOrder: row.documentOrder,
    possibleDuplicateOfId: row.possibleDuplicateOfId,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    fileDeleted: row.storageKey === null,
  };
}

/** Șterge fișierele (fără să arunce: un fișier rămas e curățat manual; vezi ADR 0013). */
async function deleteFiles(storage: Storage, keys: readonly StorageKey[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => storage.delete(key)));
}

/**
 * Primește cererea `multipart/form-data` și înregistrează documentele. Fișierele scrise nu
 * rămân orfane: la orice eroare (validare, limită, bază) se șterg.
 */
export async function uploadDocuments(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
  request: Request,
): Promise<UploadResult> {
  const limits = deps.config.documents;
  // Doar membrii pot scrie în storage-ul gospodăriei: verificarea apartenenței se face ÎNAINTE
  // de a citi corpul (un străin nu poate umple discul altcuiva).
  await inHousehold(deps, actor, householdId, async () => undefined);
  const upload = await receiveMultipart(request, deps.storage, householdId, {
    maxFileBytes: limits.maxUploadBytes,
    maxFiles: limits.maxFilesPerRequest,
    maxImagePixels: limits.maxImagePixels,
  });
  return registerUpload(deps, actor, householdId, upload);
}

/** Înregistrează fișierele deja primite (vezi ordinea din antetul modulului). */
export async function registerUpload(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
  upload: ReceivedUpload,
): Promise<UploadResult> {
  const written = upload.files.map((f) => f.key);
  const discard: StorageKey[] = [];
  try {
    const fields = parseInput(uploadFieldsSchema, upload.fields);
    if (fields.kind === "statement") {
      // Faza 6 acceptă doar bonuri; extrasele vin în Faza 7 (master prompt, Faza 6).
      throw new ValidationError({
        kind: "Extrasele bancare vor fi acceptate într-o versiune viitoare.",
      });
    }
    const longReceipt = fields.longReceipt === "true";
    if (longReceipt) {
      if (upload.files.length < 2 || upload.files.length > 4) {
        throw new ValidationError({ files: "Un bon lung are între 2 și 4 poze." });
      }
      if (upload.files.some((f) => f.mime === "application/pdf")) {
        throw new ValidationError({ files: "Un bon lung se încarcă doar din poze." });
      }
    }
    for (const f of upload.files) {
      if (!isStorageKey(f.key) || !f.key.startsWith(`households/${householdId.toLowerCase()}/`)) {
        throw new Error("documents: cheie de storage neașteptată");
      }
    }

    const now = (deps.now ?? (() => new Date()))();
    const entitlements = entitlementsOf(deps);
    const [dailyLimit, quotaMb] = await Promise.all([
      entitlements.limit(householdId, "ai.dailyDocuments"),
      entitlements.limit(householdId, "storage.quotaMb"),
    ]);
    const retentionDays = deps.config.documents.retentionDays;
    const expiresAt =
      retentionDays > 0 ? new Date(now.getTime() + retentionDays * 24 * 3600 * 1000) : null;

    const result = await inHousehold(deps, actor, householdId, async (tx) => {
      const out: UploadedDocument[] = [];
      const fresh: ReceivedFile[] = [];
      const seen = new Map<string, DocumentRow>();

      // 2. Deduplicarea exactă: înainte de orice limită.
      const known = async () => {
        const rows = await selectBySha256(
          tx,
          householdId,
          upload.files.map((f) => f.sha256),
        );
        for (const r of rows) seen.set(r.sha256, r);
      };
      await known();
      // 3. Lock, apoi a doua verificare (o cerere paralelă poate fi inserat între timp).
      await lockHouseholdDocuments(tx, householdId);
      await known();
      const inRequest = new Set<string>();
      for (const f of upload.files) {
        if (seen.has(f.sha256) || inRequest.has(f.sha256)) continue;
        inRequest.add(f.sha256);
        fresh.push(f);
      }
      if (longReceipt && fresh.length !== upload.files.length) {
        throw new ConflictError(
          "long_receipt_duplicate",
          "Una dintre poze a mai fost încărcată; bonul lung se încarcă din poze noi.",
        );
      }

      const today = localDateOf(now, DEFAULT_TIME_ZONE);
      if (fresh.length > 0) {
        const used = await usageOfDay(tx, householdId, today);
        if (used + fresh.length > dailyLimit) {
          throw new ConflictError(
            "daily_document_limit",
            "Ai atins numărul maxim de documente pentru azi.",
          );
        }
        const bytes = await storedBytes(tx, householdId);
        const added = fresh.reduce((sum, f) => sum + f.sizeBytes, 0);
        if (bytes + added > quotaMb * MB) {
          throw new ConflictError("storage_quota_exceeded", "Spațiul de stocare e plin.");
        }
      }

      const consent = await hasActiveConsent(tx, actor.userId, "external_ai");
      const status = consent ? "queued" : "awaiting_consent";
      const batchId = longReceipt
        ? await insertBatch(tx, householdId, actor.userId, "long_receipt")
        : null;

      const freshKeys = new Set(fresh.map((f) => f.key));
      let created = 0;
      for (const f of upload.files) {
        if (!freshKeys.has(f.key)) {
          // Duplicat: documentul existent sau cel creat mai devreme în aceeași cerere (prima
          // apariție a unui SHA-256 e procesată înaintea celorlalte).
          discard.push(f.key);
          const existing = seen.get(f.sha256);
          if (existing) out.push({ ...documentView(existing), duplicate: true });
          continue;
        }
        const row = await insertDocumentRow(tx, {
          id: storageKeyName(f.key),
          householdId,
          uploadedByUserId: actor.userId,
          kind: "receipt",
          status,
          storageKey: f.key,
          originalMime: f.declaredMime,
          detectedMime: f.mime,
          sizeBytes: f.sizeBytes,
          sha256: f.sha256,
          batchId,
          documentOrder: batchId ? f.index + 1 : null,
          expiresAt,
        });
        if (row) {
          created++;
          seen.set(f.sha256, row);
          out.push({ ...documentView(row), duplicate: false });
        } else {
          // Cursă pierdută pe (household_id, sha256): același rezultat ca un duplicat.
          discard.push(f.key);
          const [existing] = await selectBySha256(tx, householdId, [f.sha256]);
          if (existing) out.push({ ...documentView(existing), duplicate: true });
        }
      }
      // Contorul zilei crește în aceeași tranzacție (nu scade la ștergere).
      await addUsage(tx, householdId, today, created);
      if (created > 0) {
        await insertAudit(tx, actor.userId, householdId, {
          action: "document.uploaded",
          metadata: { created, duplicates: upload.files.length - created },
        });
      }
      return { documents: out, batchId, created };
    });
    await deleteFiles(deps.storage, discard);
    return result;
  } catch (error) {
    await deleteFiles(deps.storage, written);
    throw error;
  }
}

async function documentIn(tx: Tx, householdId: string, id: string): Promise<DocumentRow> {
  if (!isValidId(id)) throw new NotFoundError();
  const row = await selectDocument(tx, householdId, id);
  if (!row) throw new NotFoundError();
  return row;
}

export async function getDocument(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<DocumentView> {
  return inHousehold(deps, actor, householdId, async (tx) =>
    documentView(await documentIn(tx, householdId, id)),
  );
}

/**
 * Șterge documentul (5.6): rândul (bonul extras și liniile lui, în cascadă; tranzacțiile create
 * din el rămân, cu legătura desfăcută de cheia `SET NULL`), apoi fișierul din storage. Auditat
 * fără nume de fișier sau conținut.
 */
export async function deleteDocument(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<void> {
  const key = await inHousehold(deps, actor, householdId, async (tx) => {
    await documentIn(tx, householdId, id);
    const deleted = await deleteDocumentRow(tx, householdId, id);
    if (!deleted) throw new NotFoundError();
    await insertAudit(tx, actor.userId, householdId, {
      action: "document.deleted",
      targetType: "document",
      targetId: id,
    });
    return deleted.storageKey;
  });
  if (key && isStorageKey(key)) await deps.storage.delete(key);
}

/** Consumul de azi (contorul de lângă zona de încărcare). */
export async function dailyUsage(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
): Promise<DailyUsage> {
  const now = (deps.now ?? (() => new Date()))();
  const limit = await entitlementsOf(deps).limit(householdId, "ai.dailyDocuments");
  const used = await inHousehold(deps, actor, householdId, (tx) =>
    usageOfDay(tx, householdId, localDateOf(now, DEFAULT_TIME_ZONE)),
  );
  return { used, limit };
}

/**
 * După acordarea consimțământului `external_ai`: documentele utilizatorului care îl așteptau
 * trec în coadă. Fără consimțământ activ nu schimbă nimic.
 */
export async function queueAwaitingConsent(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
): Promise<number> {
  return inHousehold(deps, actor, householdId, async (tx) => {
    if (!(await hasActiveConsent(tx, actor.userId, "external_ai"))) return 0;
    return queueAwaitingConsentRows(tx, householdId, actor.userId);
  });
}

// --- Lista, starea și fișierul (F6-C) -----------------------------------------------------------

export type DocumentListItem = DocumentView & Readonly<{ receiptId: string | null }>;

export const documentListSchema = z.strictObject({
  status: z.enum(DOCUMENT_STATUSES).optional(),
  /** Doar documentele încărcate după acest moment (pagina Import: „azi”). */
  since: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** Documentele gospodăriei, cele mai noi întâi, cu bonul extras din ele (dacă există). */
export async function listDocuments(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown,
): Promise<DocumentListItem[]> {
  const q = parseInput(documentListSchema, rawQuery);
  return inHousehold(deps, actor, householdId, async (tx) => {
    const rows = await selectDocumentsWithReceipt(tx, householdId, {
      status: q.status,
      since: q.since === undefined ? undefined : new Date(q.since),
      limit: q.limit ?? 50,
    });
    return rows.map((r) => ({ ...documentView(r.d), receiptId: r.receiptId }));
  });
}

export async function getDocumentWithReceipt(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<DocumentListItem> {
  if (!isValidId(id)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx) => {
    const [row] = await selectDocumentsWithReceipt(tx, householdId, { id: id.toLowerCase() });
    if (!row) throw new NotFoundError();
    return { ...documentView(row.d), receiptId: row.receiptId };
  });
}

export type DocumentFile = Readonly<{
  id: string;
  mime: DocumentView["mime"];
  sizeBytes: number;
  body: ReadableStream<Uint8Array>;
}>;

/**
 * Fișierul original al unui document, ca flux, doar pentru membri (RLS). Citirea e plafonată la
 * dimensiunea înregistrată: un fișier schimbat pe disc (mai mare) e tăiat și fluxul se oprește cu
 * eroare. Fișier lipsă sau șters la retenție → 404 uniform.
 */
export async function openDocumentFile(
  deps: DocumentsDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<DocumentFile> {
  const row = await inHousehold(deps, actor, householdId, async (tx) =>
    documentIn(tx, householdId, id),
  );
  const key = row.storageKey;
  if (key === null || !isStorageKey(key)) throw new NotFoundError();
  let source: AsyncIterable<Uint8Array>;
  try {
    source = await deps.storage.openRead(key);
  } catch {
    throw new NotFoundError();
  }
  const limit = row.sizeBytes;
  const iterator = source[Symbol.asyncIterator]();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        sent += value.byteLength;
        if (sent > limit) {
          await iterator.return?.();
          controller.error(new Error("documents: fișier mai mare decât cel înregistrat"));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return { id: row.id, mime: row.detectedMime, sizeBytes: row.sizeBytes, body };
}
