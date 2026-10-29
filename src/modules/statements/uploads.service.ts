import "server-only";

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import {
  STATEMENT_UPLOAD_MAX_ATTEMPTS,
  STATEMENT_UPLOAD_RETENTION_HOURS,
  statementImports,
  statementUploads,
} from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import {
  type Storage,
  StorageNotFoundError,
  isKeyOfHousehold,
  storageKeyName,
} from "@/lib/storage";
import { insertAudit } from "@/modules/auth/audit";
import { inHousehold } from "@/modules/ledger/context";
import { isValidId } from "@/modules/ledger/input";
import { requireOpenAccount } from "@/modules/transactions/transactions.service";

import { readStatementUpload } from "./files";
import { type MappingSuggestion, mapTable } from "./mapping";
import {
  type PreviewResult,
  STATEMENT_DAILY_LIMIT,
  type StatementDeps,
  chargeStatementQuota,
  createStatementPreview,
  getStatementImport,
} from "./statements.service";
import { StatementError, type StatementErrorCode } from "./types";
import { STATEMENT_ZIP_LIMITS } from "./zip";

/**
 * Încărcarea unui extras prin API (F7-B; ADR 0018 §11). Ordinea, pentru fiecare cerere:
 *
 * 1. contul ales trebuie să fie vizibil membrului (RLS: un cont personal doar proprietarului) și
 *    deschis — ÎNAINTE de a citi sau păstra ceva;
 * 2. cota zilnică se consumă ÎNAINTE de parsare (o tranzacție proprie, angajată imediat: un fișier
 *    care nu se poate citi consumă și el; revizuirea F7-A), câte o unitate pe fișier (un ZIP cu N
 *    fișiere = N);
 * 3. tipul după CONȚINUT (`readStatementUpload`): CSV/XLSX se citesc aici (JavaScript pur, cu
 *    plafoane), cu maparea de coloane trimisă de utilizator (fără ea: răspunsul cere maparea, cu o
 *    sugestie și câteva rânduri de probă; nimic nu se păstrează); PDF-urile se păstrează TEMPORAR
 *    în storage (`statement_uploads`, cel mult 24 h) și le citește workerul, în procesul copil
 *    limitat (extracția PDF NU rulează în serverul web).
 *
 * Erorile sunt coduri fixe (`StatementError`), fără conținut din fișier.
 */

export type UploadDeps = StatementDeps & Readonly<{ storage: Storage }>;

/** Câte rânduri de probă se întorc pentru maparea de coloane (decizia mea). */
export const MAPPING_SAMPLE_ROWS = 15;
const SAMPLE_CELL_MAX = 80;

export type UploadPartOutcome =
  | Readonly<{
      index: number;
      kind: "queued";
      upload: StatementUploadView;
      /** Același PDF era deja în lucru pe acest cont (nimic nou păstrat). */
      duplicate: boolean;
    }>
  | Readonly<{ index: number; kind: "preview"; preview: PreviewResult }>
  | Readonly<{
      index: number;
      kind: "mapping_required";
      format: "csv" | "xlsx";
      columnCount: number;
      rowCount: number;
      sample: readonly (readonly string[])[];
      suggestion: MappingSuggestion;
    }>
  | Readonly<{ index: number; kind: "rejected"; code: StatementErrorCode }>;

export type StatementUploadView = Readonly<{
  id: string;
  accountId: string;
  currency: Currency;
  status: "queued" | "processing" | "parsed" | "failed";
  errorCode: string | null;
  importId: string | null;
  partIndex: number;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date;
  fileDeleted: boolean;
}>;

type UploadRow = typeof statementUploads.$inferSelect;

/** O încercare blocată (workerul oprit de mai multe ori pe același PDF) apare ca eșuată. */
const STALE_MS = 15 * 60 * 1000;

export function uploadView(r: UploadRow, now: Date = new Date()): StatementUploadView {
  const stuck =
    r.status === "processing" &&
    r.attempts >= STATEMENT_UPLOAD_MAX_ATTEMPTS &&
    (r.processingStartedAt === null || now.getTime() - r.processingStartedAt.getTime() > STALE_MS);
  return {
    id: r.id,
    accountId: r.accountId,
    currency: r.currency,
    status: stuck ? "failed" : r.status,
    errorCode: stuck ? "extract_failed" : r.errorCode,
    importId: r.importId,
    partIndex: r.partIndex,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    fileDeleted: r.storageKey === null,
  };
}

const clip = (s: string) => {
  const chars = Array.from(s);
  return chars.length > SAMPLE_CELL_MAX ? `${chars.slice(0, SAMPLE_CELL_MAX).join("")}…` : s;
};

export async function importStatementUpload(
  deps: UploadDeps,
  actor: Actor,
  householdId: string,
  input: Readonly<{ accountId: string; bytes: Uint8Array; mapping?: unknown }>,
): Promise<UploadPartOutcome[]> {
  if (!isValidId(input.accountId)) throw new NotFoundError();
  const accountId = input.accountId.toLowerCase();
  const now = (deps.now ?? (() => new Date()))();
  const limit = deps.dailyLimit ?? STATEMENT_DAILY_LIMIT;

  // 1–2. Contul (vizibil, deschis) și prima unitate de cotă, angajate înainte de citire.
  const account = await inHousehold(deps, actor, householdId, async (tx, m) => {
    const a = await requireOpenAccount(tx, m.householdId, accountId);
    await chargeStatementQuota(tx, m.householdId, 1, now, limit);
    return { id: a.id, currency: a.currency as Currency, householdId: m.householdId };
  });

  // 3. Tipul după conținut; un ZIP se desface în siguranță (plafoane, fără arhive imbricate).
  const parts = readStatementUpload(input.bytes);
  if (parts.length > 1) {
    await inHousehold(deps, actor, account.householdId, (tx) =>
      chargeStatementQuota(tx, account.householdId, parts.length - 1, now, limit),
    );
  }
  const single = parts.length === 1;
  const out: UploadPartOutcome[] = [];
  for (const part of parts) {
    try {
      if (part.kind === "invalid") {
        out.push({ index: part.index, kind: "rejected", code: part.code });
        continue;
      }
      if (part.kind === "pdf") {
        out.push(await queuePdf(deps, actor, account, part, now));
        continue;
      }
      if (input.mapping === undefined) {
        out.push({
          index: part.index,
          kind: "mapping_required",
          format: part.format,
          columnCount: Math.max(0, ...part.table.rows.map((r) => r.length)),
          rowCount: part.table.rows.length,
          sample: part.table.rows.slice(0, MAPPING_SAMPLE_ROWS).map((r) => r.map(clip)),
          suggestion: part.suggestion,
        });
        continue;
      }
      const parsed = mapTable(part.table, input.mapping, {
        currency: account.currency,
        format: part.format,
        bank: part.suggestion.template?.bank ?? "generic",
      });
      const preview = await createStatementPreview(
        { ...deps, quotaCharged: true },
        actor,
        account.householdId,
        { accountId: account.id, sourceSha256: part.sha256, parsed },
      );
      out.push({ index: part.index, kind: "preview", preview });
    } catch (error) {
      // Un fișier singur: eroarea lui. Într-un ZIP: fiecare fișier are rezultatul lui.
      if (single || !(error instanceof StatementError)) throw error;
      out.push({ index: part.index, kind: "rejected", code: error.code });
    }
  }
  return out;
}

async function queuePdf(
  deps: UploadDeps,
  actor: Actor,
  account: { id: string; currency: Currency; householdId: string },
  part: Readonly<{ index: number; bytes: Buffer; sha256: string }>,
  now: Date,
): Promise<UploadPartOutcome> {
  const hh = account.householdId;
  // Același fișier deja previzualizat/importat pe cont → previzualizarea existentă.
  const existing = await inHousehold(deps, actor, hh, async (tx) => {
    const [imp] = await tx
      .select({ id: statementImports.id })
      .from(statementImports)
      .where(
        and(
          eq(statementImports.accountId, account.id),
          eq(statementImports.sourceSha256, part.sha256),
          inArray(statementImports.status, ["previewed", "imported"]),
        ),
      )
      .limit(1);
    if (imp) return { importId: imp.id };
    const [up] = await pendingUpload(tx, account.id, part.sha256);
    return up ? { upload: up } : null;
  });
  if (existing && "importId" in existing && existing.importId) {
    const view = await getStatementImport(deps, actor, hh, existing.importId);
    return {
      index: part.index,
      kind: "preview",
      preview: { import: view, alreadyImported: view.status === "imported", balanceReasons: [] },
    };
  }
  if (existing && "upload" in existing && existing.upload) {
    return {
      index: part.index,
      kind: "queued",
      upload: uploadView(existing.upload, now),
      duplicate: true,
    };
  }

  // Fișierul se scrie întâi; rândul după. Orice eșec la inserare șterge fișierul (fără orfani).
  const key = await deps.storage.put(part.bytes, {
    householdId: hh,
    maxBytes: STATEMENT_ZIP_LIMITS.maxEntryBytes,
  });
  try {
    const row = await inHousehold(deps, actor, hh, async (tx, m) => {
      const [r] = await tx
        .insert(statementUploads)
        .values({
          id: storageKeyName(key),
          householdId: m.householdId,
          accountId: account.id,
          currency: account.currency,
          createdByUserId: actor.userId,
          storageKey: key,
          sha256: part.sha256,
          sizeBytes: part.bytes.byteLength,
          partIndex: part.index,
          expiresAt: new Date(now.getTime() + STATEMENT_UPLOAD_RETENTION_HOURS * 3600_000),
        })
        .returning();
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "statement.uploaded",
        targetType: "statement_upload",
        targetId: r!.id,
        metadata: { bytes: part.bytes.byteLength },
      });
      return r!;
    });
    return { index: part.index, kind: "queued", upload: uploadView(row, now), duplicate: false };
  } catch (error) {
    await deps.storage.delete(key).catch(() => undefined);
    // Cursă: aceeași încărcare a ajuns între timp (indexul unic) → cea existentă.
    if (error instanceof ConflictError && error.reason === "duplicate") {
      const [up] = await inHousehold(deps, actor, hh, (tx) =>
        pendingUpload(tx, account.id, part.sha256),
      );
      if (up)
        return { index: part.index, kind: "queued", upload: uploadView(up, now), duplicate: true };
    }
    throw error;
  }
}

function pendingUpload(tx: Tx, accountId: string, sha256: string) {
  return tx
    .select()
    .from(statementUploads)
    .where(
      and(
        eq(statementUploads.accountId, accountId),
        eq(statementUploads.sha256, sha256),
        inArray(statementUploads.status, ["queued", "processing"]),
      ),
    )
    .limit(1);
}

export async function getStatementUpload(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<StatementUploadView> {
  if (!isValidId(id)) throw new NotFoundError();
  const now = (deps.now ?? (() => new Date()))();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const [row] = await tx
      .select()
      .from(statementUploads)
      .where(
        and(
          eq(statementUploads.householdId, m.householdId),
          eq(statementUploads.id, id.toLowerCase()),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError();
    return uploadView(row, now);
  });
}

export async function listStatementUploads(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
): Promise<StatementUploadView[]> {
  const now = (deps.now ?? (() => new Date()))();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await tx
      .select()
      .from(statementUploads)
      .where(eq(statementUploads.householdId, m.householdId))
      .orderBy(desc(statementUploads.createdAt), desc(statementUploads.id))
      .limit(50);
    return rows.map((r) => uploadView(r, now));
  });
}

/**
 * Șterge fișierele PDF ale unor încărcări (după confirmare, renunțare sau la cererea
 * utilizatorului): ÎNTÂI fișierul (lipsa lui nu e o eroare), apoi cheia se golește. Un eșec lasă
 * rândul pentru curățarea periodică (expirare la 24 h). Fără conținut în erori.
 */
async function deleteUploadFiles(
  deps: UploadDeps,
  actor: Actor,
  householdId: string,
  rows: readonly { id: string; storageKey: string | null }[],
): Promise<number> {
  let n = 0;
  for (const r of rows) {
    if (!r.storageKey || !isKeyOfHousehold(r.storageKey, householdId)) continue;
    try {
      await deps.storage.delete(r.storageKey);
    } catch (error) {
      if (!(error instanceof StorageNotFoundError)) continue;
    }
    await inHousehold(deps, actor, householdId, (tx) =>
      tx
        .update(statementUploads)
        .set({ storageKey: null, fileDeletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(statementUploads.id, r.id), eq(statementUploads.storageKey, r.storageKey!))),
    ).catch(() => undefined);
    n++;
  }
  return n;
}

/** Încărcările (cu fișier) din care provine o previzualizare (înainte de a o confirma/șterge). */
export async function uploadFilesOfImport(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  importId: string,
): Promise<{ id: string; storageKey: string | null }[]> {
  if (!isValidId(importId)) return [];
  return inHousehold(deps, actor, householdId, (tx, m) =>
    tx
      .select({ id: statementUploads.id, storageKey: statementUploads.storageKey })
      .from(statementUploads)
      .where(
        and(
          eq(statementUploads.householdId, m.householdId),
          eq(statementUploads.importId, importId.toLowerCase()),
          isNotNull(statementUploads.storageKey),
        ),
      ),
  ).catch(() => []);
}

/** După confirmare/renunțare: fișierele sursă nu mai sunt necesare (best effort). */
export async function releaseUploadFiles(
  deps: UploadDeps,
  actor: Actor,
  householdId: string,
  rows: readonly { id: string; storageKey: string | null }[],
): Promise<number> {
  return deleteUploadFiles(deps, actor, householdId, rows).catch(() => 0);
}

/**
 * Renunțarea la o încărcare (PDF): fișierul se șterge imediat; o încărcare în așteptare devine
 * `failed` (`upload_cancelled`). Una în lucru acum (workerul o citește) → conflict.
 */
export async function cancelStatementUpload(
  deps: UploadDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<StatementUploadView> {
  if (!isValidId(id)) throw new NotFoundError();
  const uploadId = id.toLowerCase();
  const now = (deps.now ?? (() => new Date()))();
  const row = await inHousehold(deps, actor, householdId, async (tx, m) => {
    const [r] = await tx
      .select()
      .from(statementUploads)
      .where(
        and(eq(statementUploads.householdId, m.householdId), eq(statementUploads.id, uploadId)),
      )
      .for("update")
      .limit(1);
    if (!r) throw new NotFoundError();
    if (r.status === "processing" && uploadView(r, now).status === "processing") {
      throw new ConflictError("statement_upload_processing", "Extrasul e citit chiar acum.");
    }
    if (r.status === "queued") {
      const [u] = await tx
        .update(statementUploads)
        .set({ status: "failed", errorCode: "upload_cancelled", updatedAt: now })
        .where(eq(statementUploads.id, r.id))
        .returning();
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "statement.upload_cancelled",
        targetType: "statement_upload",
        targetId: r.id,
      });
      return u!;
    }
    return r;
  });
  await deleteUploadFiles(deps, actor, householdId, [row]);
  return getStatementUpload(deps, actor, householdId, uploadId);
}

/** Validarea câmpului `mapping` (JSON într-un câmp multipart): obiect, nu altceva. */
export function parseMappingField(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("x");
    return v;
  } catch {
    throw new ValidationError({ mapping: "Maparea coloanelor nu e un obiect JSON valid." });
  }
}

/** Pentru jurnal/teste: câte încărcări mai așteaptă workerul în gospodărie (fără conținut). */
export async function pendingUploadCount(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
): Promise<number> {
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(statementUploads)
      .where(
        and(
          eq(statementUploads.householdId, m.householdId),
          inArray(statementUploads.status, ["queued", "processing"]),
        ),
      );
    return r?.n ?? 0;
  });
}
