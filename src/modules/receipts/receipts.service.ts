import "server-only";

import { createHash } from "node:crypto";

import { type SQL, and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import {
  documents,
  processingBatches,
  productAliases,
  receiptLines,
  receipts,
  vatRates,
} from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { DEFAULT_TIME_ZONE, localDateOf } from "@/lib/calendar";
import { ConflictError, ValidationError } from "@/lib/errors";
import { InvalidAmountError, parseAmount } from "@/lib/money";
import { type Storage, isKeyOfHousehold } from "@/lib/storage";
import { insertAudit } from "@/modules/auth/audit";
import { selectCategory } from "@/modules/categories/categories.repo";
import { addUsage, lockHouseholdDocuments, usageOfDay } from "@/modules/documents/documents.repo";
import { type DocumentsDeps, entitlementsOf } from "@/modules/documents/documents.service";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { assertAccountsWithinJsonRange } from "@/modules/ledger/range-guard";
import { insertTransactionRow, escapeLike } from "@/modules/transactions/transactions.repo";
import { requireOpenAccount } from "@/modules/transactions/transactions.service";

import { type ReceiptIssue, checkReceipt, confidenceScore, dedupSource } from "./checks";
import { normalizeTaxId } from "./cui";
import type { ExtractedLine, ExtractedReceipt } from "./extraction.schema";
import { normalizeProductName } from "./normalize";
import {
  RECEIPT_LIST_DEFAULT_LIMIT,
  type ReceiptConfirm,
  type ReceiptDetail,
  type ReceiptIssueView,
  type ReceiptLineInput,
  type ReceiptLineView,
  type ReceiptListQuery,
  type ReceiptPage,
  type ReceiptView,
  type RemovedLineView,
  decodeReceiptCursor,
  encodeReceiptCursor,
  receiptConfirmSchema,
  receiptListSchema,
  receiptPatchSchema,
} from "./receipts.schema";
import { type VatRateRow, parseRateBp } from "./vat";

/**
 * Bonurile din punctul de vedere al utilizatorului (Faza 6, F6-C; ADR 0015): lista cu filtre,
 * ecranul de verificare, corectarea, confirmarea (→ tranzacție), reprocesarea și ștergerea.
 * Totul în tranzacția membrului (`inHousehold`: RLS + filtru explicit pe gospodărie), cu erori
 * cu cod fix, fără ecou din conținutul bonului. NIMIC nu creează o tranzacție fără confirmarea
 * explicită a utilizatorului (decizia de siguranță a Fazei 6, ADR 0014).
 *
 * Regulile (decizia mea, ADR 0015):
 * - corectarea (`PATCH`) e permisă până la confirmare; liniile se înlocuiesc integral; verificările
 *   din cod (`checkReceipt`) și scorul se RECALCULEAZĂ, ca ecranul să nu arate probleme vechi;
 *   cheia de deduplicare se recalculează (o coliziune marchează bonul „posibil duplicat”);
 *   o categorie aleasă pe o linie de produs actualizează `product_aliases` (corecturile
 *   utilizatorului au prioritate la bonurile următoare, 3.6);
 * - confirmarea: o tranzacție de cheltuială per bon (suma = totalul bonului, moneda contului =
 *   moneda bonului), `source = receipt`, `document_id` = primul document; categoria tranzacției
 *   = cea aleasă sau categoria cu cea mai mare sumă pe liniile de produs; categoriile liniilor
 *   rămân pe `receipt_lines`. O diferență între suma liniilor și total NU blochează confirmarea
 *   (utilizatorul a văzut-o pe ecran); totalul lipsă sau 0 o blochează. Un „posibil duplicat”
 *   cere `allowDuplicate: true`;
 * - reprocesarea costă (un nou apel AI): consumă limita zilnică (contorul doar crește), are o
 *   limită de cereri proprie (în handler) și repune `attempts` la 0;
 * - ștergerea bonului șterge documentele lui (fișierele) și lotul; tranzacția creată rămâne (5.6).
 */

export type ReceiptsDeps = LedgerDeps &
  Pick<DocumentsDeps, "config" | "entitlements" | "now"> &
  Readonly<{ storage?: Storage }>;

type ReceiptRow = typeof receipts.$inferSelect;
type LineRow = typeof receiptLines.$inferSelect;

const nowOf = (deps: Pick<ReceiptsDeps, "now">) => (deps.now ?? (() => new Date()))();

// --- Citirea --------------------------------------------------------------------------------------

/** Coloanele calculate ale listei (sub RLS, cu filtrul pe gospodărie în fiecare subinterogare). */
function listColumns() {
  return {
    r: receipts,
    cursorKey: sql<string>`to_char(${receipts.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    documentIds: sql<
      string[]
    >`coalesce((select array_agg(d.id::text order by d.document_order nulls first, d.id)
        from finet.documents d
       where d.household_id = finet.receipts.household_id
         and (d.id = finet.receipts.document_id or d.batch_id = finet.receipts.batch_id)), '{}'::text[])`,
    categoryIds: sql<string[]>`coalesce((select array_agg(distinct l.category_id::text)
        from finet.receipt_lines l
       where l.receipt_id = finet.receipts.id and l.household_id = finet.receipts.household_id
         and l.category_id is not null), '{}'::text[])`,
    lineCount: sql<number>`(select count(*)::int from finet.receipt_lines l
       where l.receipt_id = finet.receipts.id and l.household_id = finet.receipts.household_id)`,
    linesSum: sql<
      string | null
    >`(select sum(case when l.kind = 'discount' then -l.line_total_minor else l.line_total_minor end)::text
        from finet.receipt_lines l
       where l.receipt_id = finet.receipts.id and l.household_id = finet.receipts.household_id)`,
  };
}

type ListRow = Readonly<{
  r: ReceiptRow;
  cursorKey: string;
  documentIds: string[];
  categoryIds: string[];
  lineCount: number;
  linesSum: string | null;
}>;

function issuesOf(raw: unknown): ReceiptIssueView[] {
  if (!Array.isArray(raw)) return [];
  const out: ReceiptIssueView[] = [];
  for (const i of raw.slice(0, 100)) {
    if (!i || typeof i !== "object") continue;
    const { code, field, line } = i as { code?: unknown; field?: unknown; line?: unknown };
    if (typeof code !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(code)) continue;
    out.push({
      code,
      ...(typeof field === "string" && /^[a-zA-Z]{1,20}$/.test(field) ? { field } : {}),
      ...(typeof line === "number" && Number.isSafeInteger(line) ? { line } : {}),
    });
  }
  return out;
}

function viewOf(row: ListRow): ReceiptView {
  const r = row.r;
  return {
    id: r.id,
    status: r.status,
    documentIds: row.documentIds,
    batchId: r.batchId,
    merchantName: r.merchantName,
    merchantTaxId: r.merchantTaxId,
    storeAddress: r.storeAddress,
    receiptNumber: r.receiptNumber,
    occurredOn: r.occurredOn,
    paymentMethod: r.paymentMethod,
    totalMinor: r.totalMinor,
    vatTotalMinor: r.vatTotalMinor,
    currency: r.currency,
    confidence: r.confidence,
    providerUsed: r.providerUsed,
    fallbackReason: r.fallbackReason,
    transactionId: r.transactionId,
    duplicateOfReceiptId: r.duplicateOfReceiptId,
    issues: issuesOf(r.issues),
    linesSumMinor: row.linesSum === null ? null : BigInt(row.linesSum),
    categoryIds: [...row.categoryIds].sort(),
    lineCount: row.lineCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function lineView(l: LineRow): ReceiptLineView {
  return {
    id: l.id,
    position: l.position,
    rawName: l.rawName,
    normalizedName: l.normalizedName,
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    lineTotalMinor: l.lineTotalMinor,
    vatRate: l.vatRate,
    categoryId: l.categoryId,
    kind: l.kind,
  };
}

/** Raportul unirii (jsonb scris de worker): doar câmpurile cunoscute, validate. */
function removedOf(report: unknown): { removed: RemovedLineView[]; count: number } {
  if (!report || typeof report !== "object") return { removed: [], count: 0 };
  const r = report as { removed?: unknown; removedCount?: unknown };
  const removed: RemovedLineView[] = [];
  if (Array.isArray(r.removed)) {
    for (const x of r.removed.slice(0, 100)) {
      if (!x || typeof x !== "object") continue;
      const { part, position, name } = x as { part?: unknown; position?: unknown; name?: unknown };
      if (Number.isSafeInteger(part) && Number.isSafeInteger(position)) {
        removed.push({
          part: part as number,
          position: position as number,
          reason: "overlap",
          name:
            typeof name === "string" && name !== "" ? Array.from(name).slice(0, 80).join("") : null,
        });
      }
    }
  }
  const count = Number.isSafeInteger(r.removedCount) ? (r.removedCount as number) : removed.length;
  return { removed, count };
}

/** Sugestia „Ordonează automat” a unirii (pozele 1..4), dacă există. */
export function suggestedOrderOf(report: unknown): number[] | null {
  if (!report || typeof report !== "object") return null;
  const s = (report as { suggestedOrder?: unknown }).suggestedOrder;
  if (!Array.isArray(s) || s.length < 2 || s.length > 4) return null;
  if (!s.every((x) => Number.isSafeInteger(x) && x >= 1 && x <= s.length)) return null;
  return new Set(s).size === s.length ? (s as number[]) : null;
}

async function selectListRow(tx: Tx, householdId: string, id: string): Promise<ListRow | null> {
  const [row] = await tx
    .select(listColumns())
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), eq(receipts.id, id)))
    .limit(1);
  return row ?? null;
}

async function selectLines(tx: Tx, householdId: string, receiptId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(receiptLines)
    .where(and(eq(receiptLines.householdId, householdId), eq(receiptLines.receiptId, receiptId)))
    .orderBy(asc(receiptLines.position));
}

async function detailIn(tx: Tx, householdId: string, id: string): Promise<ReceiptDetail> {
  const row = await selectListRow(tx, householdId, id);
  if (!row) throw new NotFoundError();
  const lines = await selectLines(tx, householdId, id);
  const { removed, count } = removedOf(row.r.mergeReport);
  return {
    ...viewOf(row),
    lines: lines.map(lineView),
    removedLines: removed,
    removedCount: count,
    suggestedOrder: suggestedOrderOf(row.r.mergeReport),
  };
}

/** Textul de căutare ca sumă („45,90”, „45.90”, „45”), fără float; `null` dacă nu e sumă. */
export function amountOfQuery(q: string): bigint | null {
  try {
    return parseAmount(q, "RON").amountMinor;
  } catch (error) {
    if (error instanceof InvalidAmountError) return null;
    throw error;
  }
}

export async function listReceipts(
  deps: ReceiptsDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown,
): Promise<ReceiptPage> {
  const q: ReceiptListQuery = parseInput(receiptListSchema, rawQuery);
  if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) {
    throw new ValidationError({ dateTo: "Intervalul de date e invers." });
  }
  if (
    q.amountMinMinor !== undefined &&
    q.amountMaxMinor !== undefined &&
    q.amountMinMinor > q.amountMaxMinor
  ) {
    throw new ValidationError({ amountMaxMinor: "Intervalul de sume e invers." });
  }
  const limit = q.limit ?? RECEIPT_LIST_DEFAULT_LIMIT;
  const cursor = q.cursor === undefined ? null : decodeReceiptCursor(q.cursor);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const hh = m.householdId;
    const conds: SQL[] = [eq(receipts.householdId, hh)];
    if (q.status) conds.push(eq(receipts.status, q.status));
    if (q.merchant) conds.push(ilike(receipts.merchantName, `%${escapeLike(q.merchant)}%`));
    if (q.q) {
      const like = `%${escapeLike(q.q)}%`;
      const normalized = normalizeProductName(q.q);
      const normLike = normalized === null ? like : `%${escapeLike(normalized)}%`;
      const parts: SQL[] = [
        ilike(receipts.merchantName, like),
        sql`exists (select 1 from finet.receipt_lines l
             where l.receipt_id = finet.receipts.id and l.household_id = ${hh}
               and (l.raw_name ilike ${like} or l.normalized_name ilike ${normLike}))`,
      ];
      const amount = amountOfQuery(q.q);
      if (amount !== null) {
        parts.push(eq(receipts.totalMinor, amount));
        parts.push(sql`exists (select 1 from finet.receipt_lines l
             where l.receipt_id = finet.receipts.id and l.household_id = ${hh}
               and l.line_total_minor = ${amount})`);
      }
      conds.push(or(...parts)!);
    }
    if (q.dateFrom) conds.push(gte(receipts.occurredOn, q.dateFrom));
    if (q.dateTo) conds.push(lte(receipts.occurredOn, q.dateTo));
    if (q.amountMinMinor !== undefined) {
      conds.push(gte(receipts.totalMinor, BigInt(q.amountMinMinor)));
    }
    if (q.amountMaxMinor !== undefined) {
      conds.push(lte(receipts.totalMinor, BigInt(q.amountMaxMinor)));
    }
    if (q.categoryId) {
      conds.push(sql`exists (select 1 from finet.receipt_lines l
           where l.receipt_id = finet.receipts.id and l.household_id = ${hh}
             and l.category_id = ${q.categoryId})`);
    }
    if (q.tagId) {
      // Liniile nu au etichete: filtrul privește tranzacția creată din bon (decizia mea, ADR 0015).
      conds.push(sql`exists (select 1 from finet.transaction_tags tt
           where tt.transaction_id = finet.receipts.transaction_id and tt.household_id = ${hh}
             and tt.tag_id = ${q.tagId})`);
    }
    if (cursor) {
      conds.push(
        sql`(${receipts.createdAt}, ${receipts.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await tx
      .select(listColumns())
      .from(receipts)
      .where(and(...conds))
      .orderBy(desc(receipts.createdAt), desc(receipts.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(viewOf),
      nextCursor:
        rows.length > limit && last
          ? encodeReceiptCursor({ createdAt: last.cursorKey, id: last.r.id })
          : null,
    };
  });
}

export async function getReceipt(
  deps: ReceiptsDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<ReceiptDetail> {
  if (!isValidId(id)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, (tx, m) =>
    detailIn(tx, m.householdId, id.toLowerCase()),
  );
}

// --- Corectarea -----------------------------------------------------------------------------------

async function lockReceipt(tx: Tx, householdId: string, id: string): Promise<ReceiptRow> {
  const [row] = await tx
    .select()
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), eq(receipts.id, id)))
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundError();
  return row;
}

function assertEditable(row: ReceiptRow): void {
  if (row.status === "saved" || row.transactionId !== null) {
    throw new ConflictError("receipt_saved", "Bonul a fost deja salvat ca tranzacție.");
  }
}

async function loadVatRates(tx: Tx): Promise<VatRateRow[]> {
  return tx
    .select({ rateBp: vatRates.rateBp, validFrom: vatRates.validFrom, validTo: vatRates.validTo })
    .from(vatRates)
    .where(eq(vatRates.country, "RO"));
}

/** Liniile din bază → forma verificărilor din cod. */
function extractedLineOf(
  l: Pick<
    LineRow,
    | "rawName"
    | "normalizedName"
    | "quantity"
    | "unitPriceMinor"
    | "lineTotalMinor"
    | "vatRate"
    | "kind"
  >,
): ExtractedLine {
  return {
    rawName: l.rawName,
    normalizedName: l.normalizedName,
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    lineTotalMinor: l.lineTotalMinor,
    vatRateBp: l.vatRate === null ? null : parseRateBp(l.vatRate),
    kind: l.kind,
  };
}

/** Problemele care nu se pot recalcula din date (ale imaginii/lotului), păstrate la corectare. */
const CARRIED_ISSUES = new Set(["possible_duplicate_image", "long_receipt_mismatch"]);

async function categoryOk(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const c = await selectCategory(tx, householdId, id);
  return c !== null && c.kind === "expense";
}

type NewLine = Readonly<{
  id: string | undefined;
  rawName: string;
  normalizedName: string | null;
  quantity: string | null;
  unitPriceMinor: bigint | null;
  lineTotalMinor: bigint;
  vatRate: string | null;
  categoryId: string | null;
  kind: LineRow["kind"];
}>;

function newLineOf(input: ReceiptLineInput, previous: LineRow | undefined): NewLine {
  const keepVat = input.vatRate === undefined ? (previous?.vatRate ?? null) : input.vatRate;
  return {
    id: input.id,
    rawName: input.rawName,
    normalizedName: normalizeProductName(input.rawName),
    quantity: input.quantity === undefined ? (previous?.quantity ?? null) : input.quantity,
    unitPriceMinor:
      input.unitPriceMinor === undefined
        ? (previous?.unitPriceMinor ?? null)
        : input.unitPriceMinor === null
          ? null
          : BigInt(input.unitPriceMinor),
    lineTotalMinor: BigInt(input.lineTotalMinor),
    vatRate: keepVat === null ? null : keepVat.includes(".") ? keepVat : `${keepVat}.00`,
    categoryId: input.categoryId === undefined ? (previous?.categoryId ?? null) : input.categoryId,
    kind: input.kind,
  };
}

export async function updateReceipt(
  deps: ReceiptsDeps,
  actor: Actor,
  householdId: string,
  id: string,
  rawPatch: unknown,
): Promise<ReceiptDetail> {
  if (!isValidId(id)) throw new NotFoundError();
  const patch = parseInput(receiptPatchSchema, rawPatch);
  let taxId: string | null | undefined;
  if (patch.merchantTaxId !== undefined) {
    if (patch.merchantTaxId === null || patch.merchantTaxId === "") taxId = null;
    else {
      taxId = normalizeTaxId(patch.merchantTaxId);
      if (taxId === null) {
        throw new ValidationError({ merchantTaxId: "CUI-ul are forma RO urmat de 2–10 cifre." });
      }
    }
  }
  const receiptId = id.toLowerCase();
  const today = localDateOf(nowOf(deps), DEFAULT_TIME_ZONE);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const hh = m.householdId;
    // Serializat cu workerul (cheia de deduplicare) și cu alte corecturi.
    await lockHouseholdDocuments(tx, hh);
    const current = await lockReceipt(tx, hh, receiptId);
    assertEditable(current);
    const before = await selectLines(tx, hh, receiptId);
    const byId = new Map(before.map((l) => [l.id, l]));

    let lines: NewLine[] | null = null;
    if (patch.lines !== undefined) {
      const seenIds = new Set<string>();
      lines = patch.lines.map((input, i) => {
        if (input.id !== undefined) {
          if (!byId.has(input.id) || seenIds.has(input.id)) {
            throw new ValidationError({ [`lines.${i}.id`]: "Linie necunoscută." });
          }
          seenIds.add(input.id);
        }
        return newLineOf(input, input.id === undefined ? undefined : byId.get(input.id));
      });
      const cats = [...new Set(lines.map((l) => l.categoryId).filter((c) => c !== null))];
      for (const c of cats) {
        if (!(await categoryOk(tx, hh, c))) {
          const i = lines.findIndex((l) => l.categoryId === c);
          throw new ValidationError({
            [`lines.${i}.categoryId`]: "Categorie de cheltuieli inexistentă.",
          });
        }
      }
    }

    const next = {
      merchantName: patch.merchantName === undefined ? current.merchantName : patch.merchantName,
      merchantTaxId: taxId === undefined ? current.merchantTaxId : taxId,
      storeAddress: patch.storeAddress === undefined ? current.storeAddress : patch.storeAddress,
      receiptNumber:
        patch.receiptNumber === undefined ? current.receiptNumber : patch.receiptNumber,
      occurredOn: patch.occurredOn === undefined ? current.occurredOn : patch.occurredOn,
      paymentMethod:
        patch.paymentMethod === undefined ? current.paymentMethod : patch.paymentMethod,
      totalMinor:
        patch.totalMinor === undefined
          ? current.totalMinor
          : patch.totalMinor === null
            ? null
            : BigInt(patch.totalMinor),
      vatTotalMinor:
        patch.vatTotalMinor === undefined
          ? current.vatTotalMinor
          : patch.vatTotalMinor === null
            ? null
            : BigInt(patch.vatTotalMinor),
    };
    const finalLines: ExtractedLine[] = (lines ?? before).map(extractedLineOf);
    const extracted: ExtractedReceipt = {
      ...next,
      merchantTaxIdMalformed: false,
      currency: current.currency,
      paymentMethod: next.paymentMethod,
      lines: finalLines,
    };

    // Verificările din cod, recalculate; plus ce ține de imagine/lot (nu se poate recalcula).
    const issues: ReceiptIssue[] = checkReceipt(extracted, {
      today,
      vatRates: await loadVatRates(tx),
    });
    for (const i of issuesOf(current.issues)) {
      if (CARRIED_ISSUES.has(i.code)) issues.push(i as ReceiptIssue);
    }

    // Cheia de deduplicare (CUI + număr + dată + total), recalculată.
    let duplicateOf = current.duplicateOfReceiptId;
    let dedupKey = current.dedupKey;
    if (duplicateOf === null) {
      const src = dedupSource(extracted);
      const key = src === null ? null : createHash("sha256").update(src).digest("hex");
      if (key !== current.dedupKey) {
        dedupKey = key;
        if (key !== null) {
          const [other] = await tx
            .select({ id: receipts.id })
            .from(receipts)
            .where(and(eq(receipts.householdId, hh), eq(receipts.dedupKey, key)))
            .limit(1);
          if (other && other.id !== receiptId) {
            duplicateOf = other.id;
            dedupKey = null;
          }
        }
      }
    }
    if (duplicateOf !== null) issues.push({ code: "duplicate_receipt" });
    const confidence = confidenceScore(issues);

    await tx
      .update(receipts)
      .set({
        merchantName: next.merchantName,
        merchantTaxId: next.merchantTaxId,
        storeAddress: next.storeAddress,
        receiptNumber: next.receiptNumber,
        occurredOn: next.occurredOn,
        paymentMethod: next.paymentMethod,
        totalMinor: next.totalMinor,
        vatTotalMinor: next.vatTotalMinor,
        status: "needs_review",
        confidence,
        issues: issues.slice(0, 100),
        dedupKey,
        duplicateOfReceiptId: duplicateOf,
        updatedAt: new Date(),
      })
      .where(and(eq(receipts.householdId, hh), eq(receipts.id, receiptId)));

    let aliases = 0;
    if (lines !== null) {
      await tx
        .delete(receiptLines)
        .where(and(eq(receiptLines.householdId, hh), eq(receiptLines.receiptId, receiptId)));
      if (lines.length > 0) {
        await tx.insert(receiptLines).values(
          lines.map((l, i) => ({
            ...(l.id !== undefined ? { id: l.id } : {}),
            receiptId,
            householdId: hh,
            position: i + 1,
            rawName: l.rawName,
            normalizedName: l.normalizedName,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
            lineTotalMinor: l.lineTotalMinor,
            vatRate: l.vatRate,
            categoryId: l.categoryId,
            kind: l.kind,
          })),
        );
      }
      // Corecturile de categorie → `product_aliases` (doar produse, cu nume normalizat).
      const learned = new Map<string, string>();
      for (const l of lines) {
        if (l.kind !== "product" || l.categoryId === null || l.normalizedName === null) continue;
        const prev = l.id === undefined ? undefined : byId.get(l.id);
        if (prev && prev.categoryId === l.categoryId && prev.normalizedName === l.normalizedName) {
          continue;
        }
        learned.set(l.normalizedName, l.categoryId);
      }
      for (const [name, categoryId] of learned) {
        await tx
          .insert(productAliases)
          .values({ householdId: hh, normalizedName: name, categoryId })
          .onConflictDoUpdate({
            target: [productAliases.householdId, productAliases.normalizedName],
            set: { categoryId, updatedAt: new Date() },
          });
      }
      aliases = learned.size;
    }
    await insertAudit(tx, actor.userId, hh, {
      action: "receipt.corrected",
      targetType: "receipt",
      targetId: receiptId,
      metadata: { lines: lines?.length ?? before.length, aliases, issues: issues.length },
    });
    return detailIn(tx, hh, receiptId);
  });
}

// --- Confirmarea → tranzacție --------------------------------------------------------------------

/** Categoria cu cea mai mare sumă pe liniile de produs (la egalitate: prima apariție). */
export function dominantCategory(
  lines: readonly Pick<LineRow, "kind" | "categoryId" | "lineTotalMinor">[],
): string | null {
  const totals = new Map<string, bigint>();
  for (const l of lines) {
    if (l.kind !== "product" || l.categoryId === null) continue;
    totals.set(l.categoryId, (totals.get(l.categoryId) ?? 0n) + l.lineTotalMinor);
  }
  let best: string | null = null;
  let bestTotal = -1n;
  for (const [id, total] of totals) {
    if (total > bestTotal) {
      best = id;
      bestTotal = total;
    }
  }
  return best;
}

async function documentIdsOf(tx: Tx, householdId: string, r: ReceiptRow) {
  return tx
    .select({
      id: documents.id,
      status: documents.status,
      storageKey: documents.storageKey,
      documentOrder: documents.documentOrder,
    })
    .from(documents)
    .where(
      and(
        eq(documents.householdId, householdId),
        r.batchId === null ? eq(documents.id, r.documentId!) : eq(documents.batchId, r.batchId),
      ),
    )
    .orderBy(sql`${documents.documentOrder} nulls first`, asc(documents.id));
}

export type ConfirmResult = Readonly<{ receipt: ReceiptDetail; transactionId: string }>;

export async function confirmReceipt(
  deps: ReceiptsDeps,
  actor: Actor,
  householdId: string,
  id: string,
  rawInput: unknown,
): Promise<ConfirmResult> {
  if (!isValidId(id)) throw new NotFoundError();
  const input: ReceiptConfirm = parseInput(receiptConfirmSchema, rawInput);
  const receiptId = id.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const hh = m.householdId;
    const r = await lockReceipt(tx, hh, receiptId);
    if (r.status === "saved" || r.transactionId !== null) {
      throw new ConflictError("receipt_already_saved", "Bonul a fost deja salvat ca tranzacție.");
    }
    if (r.duplicateOfReceiptId !== null && input.allowDuplicate !== true) {
      throw new ConflictError(
        "possible_duplicate",
        "Bonul pare un duplicat; confirmă explicit dacă e o cumpărătură separată.",
      );
    }
    if (r.totalMinor === null || r.totalMinor <= 0n) {
      throw new ConflictError("total_required", "Completează totalul bonului înainte de salvare.");
    }
    const occurredOn = input.occurredOn ?? r.occurredOn;
    if (occurredOn === null) {
      throw new ConflictError("date_required", "Completează data bonului înainte de salvare.");
    }
    const account = await requireOpenAccount(tx, hh, input.accountId);
    if (account.currency !== r.currency) {
      throw new ConflictError("currency_mismatch", "Contul are altă monedă decât bonul.");
    }
    const lines = await selectLines(tx, hh, receiptId);
    const categoryId = input.categoryId === undefined ? dominantCategory(lines) : input.categoryId;
    if (categoryId !== null && !(await categoryOk(tx, hh, categoryId))) {
      throw new ValidationError({ categoryId: "Categorie de cheltuieli inexistentă." });
    }
    const docs = await documentIdsOf(tx, hh, r);
    const tr = await insertTransactionRow(tx, {
      householdId: hh,
      accountId: account.id,
      categoryId,
      createdByUserId: actor.userId,
      type: "expense",
      amountMinor: r.totalMinor,
      currency: account.currency,
      occurredOn,
      description: input.description ?? r.merchantName ?? "Bon",
      merchant: r.merchantName,
      notes: input.notes ?? null,
      source: "receipt",
      documentId: docs[0]?.id ?? null,
    });
    await assertAccountsWithinJsonRange(tx, hh, [account.id]);
    await tx
      .update(receipts)
      .set({ status: "saved", transactionId: tr.id, updatedAt: new Date() })
      .where(and(eq(receipts.householdId, hh), eq(receipts.id, receiptId)));
    if (docs.length > 0) {
      await tx
        .update(documents)
        .set({ status: "done", updatedAt: new Date() })
        .where(
          and(
            eq(documents.householdId, hh),
            inArray(
              documents.id,
              docs.map((d) => d.id),
            ),
          ),
        );
    }
    if (r.batchId !== null) {
      await tx
        .update(processingBatches)
        .set({ status: "done", updatedAt: new Date() })
        .where(and(eq(processingBatches.householdId, hh), eq(processingBatches.id, r.batchId)));
    }
    await insertAudit(tx, actor.userId, hh, {
      action: "receipt.confirmed",
      targetType: "receipt",
      targetId: receiptId,
      metadata: { lines: lines.length, duplicate: r.duplicateOfReceiptId !== null },
    });
    return { receipt: await detailIn(tx, hh, receiptId), transactionId: tr.id };
  });
}

// --- Reprocesarea ----------------------------------------------------------------------------------

export type ReprocessResult = Readonly<{ documentIds: readonly string[]; queued: number }>;

/** `order` = pozele în ordinea nouă (valorile vechi 1..n), doar pentru un bon lung. */
export function validOrder(order: readonly number[], n: number): boolean {
  return (
    order.length === n &&
    new Set(order).size === n &&
    order.every((x) => Number.isSafeInteger(x) && x >= 1 && x <= n)
  );
}

export async function reprocessReceipt(
  deps: ReceiptsDeps,
  actor: Actor,
  householdId: string,
  id: string,
  order: readonly number[] | undefined,
): Promise<ReprocessResult> {
  if (!isValidId(id)) throw new NotFoundError();
  const receiptId = id.toLowerCase();
  const now = nowOf(deps);
  const limit = await entitlementsOf(deps).limit(householdId, "ai.dailyDocuments");
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const hh = m.householdId;
    await lockHouseholdDocuments(tx, hh);
    const r = await lockReceipt(tx, hh, receiptId);
    assertEditable(r);
    const docs = await documentIdsOf(tx, hh, r);
    if (docs.length === 0) throw new NotFoundError();
    if (docs.some((d) => d.storageKey === null)) {
      throw new ConflictError("file_deleted", "Poza originală nu mai există (retenția a expirat).");
    }
    if (docs.some((d) => d.status === "rejected")) {
      throw new ConflictError(
        "document_rejected",
        "Fișierul a fost refuzat și nu se poate reciti.",
      );
    }
    if (order !== undefined && (r.batchId === null || !validOrder(order, docs.length))) {
      throw new ValidationError({ order: "Ordinea pozelor nu e validă." });
    }
    const today = localDateOf(now, DEFAULT_TIME_ZONE);
    const used = await usageOfDay(tx, hh, today);
    if (used + docs.length > limit) {
      throw new ConflictError(
        "daily_document_limit",
        "Ai atins numărul maxim de documente pentru azi.",
      );
    }
    // Reprocesarea costă un nou apel AI: se numără la limita zilnică (contorul doar crește).
    await addUsage(tx, hh, today, docs.length);
    await tx.delete(receipts).where(and(eq(receipts.householdId, hh), eq(receipts.id, receiptId)));
    if (order !== undefined && r.batchId !== null) {
      // Unicitatea (lot, ordine): întâi se golesc ordinele, apoi se scriu cele noi.
      const ids = docs.map((d) => d.id);
      await tx
        .update(documents)
        .set({ batchId: null, documentOrder: null })
        .where(and(eq(documents.householdId, hh), inArray(documents.id, ids)));
      for (let i = 0; i < order.length; i++) {
        await tx
          .update(documents)
          .set({ batchId: r.batchId, documentOrder: i + 1 })
          .where(and(eq(documents.householdId, hh), eq(documents.id, docs[order[i]! - 1]!.id)));
      }
    }
    // Consimțământul îl verifică workerul (fără el documentul trece în `awaiting_consent`).
    await tx
      .update(documents)
      .set({
        status: "queued",
        attempts: 0,
        errorCode: null,
        processingStartedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.householdId, hh),
          inArray(
            documents.id,
            docs.map((d) => d.id),
          ),
        ),
      );
    if (r.batchId !== null) {
      await tx
        .update(processingBatches)
        .set({ status: "queued", updatedAt: new Date() })
        .where(and(eq(processingBatches.householdId, hh), eq(processingBatches.id, r.batchId)));
    }
    await insertAudit(tx, actor.userId, hh, {
      action: "receipt.reprocessed",
      targetType: "receipt",
      targetId: receiptId,
      metadata: { documents: docs.length, reordered: order !== undefined },
    });
    return { documentIds: docs.map((d) => d.id), queued: docs.length };
  });
}

// --- Ștergerea -------------------------------------------------------------------------------------

/**
 * Șterge bonul ȘI sursa lui (documentele, fișierele, lotul): fără documente, bonul n-ar mai
 * putea fi recitit, iar fișierele cu date personale n-ar mai avea un motiv să rămână. Tranzacția
 * creată din bon rămâne (5.6; `transactions.document_id` → `SET NULL`).
 */
export async function deleteReceipt(
  deps: ReceiptsDeps,
  actor: Actor,
  householdId: string,
  id: string,
): Promise<void> {
  if (!isValidId(id)) throw new NotFoundError();
  const receiptId = id.toLowerCase();
  const keys = await inHousehold(deps, actor, householdId, async (tx, m) => {
    const hh = m.householdId;
    const r = await lockReceipt(tx, hh, receiptId);
    const docs = await documentIdsOf(tx, hh, r);
    await tx.delete(receipts).where(and(eq(receipts.householdId, hh), eq(receipts.id, receiptId)));
    if (docs.length > 0) {
      await tx.delete(documents).where(
        and(
          eq(documents.householdId, hh),
          inArray(
            documents.id,
            docs.map((d) => d.id),
          ),
        ),
      );
    }
    if (r.batchId !== null) {
      await tx
        .delete(processingBatches)
        .where(and(eq(processingBatches.householdId, hh), eq(processingBatches.id, r.batchId)));
    }
    await insertAudit(tx, actor.userId, hh, {
      action: "receipt.deleted",
      targetType: "receipt",
      targetId: receiptId,
      metadata: { documents: docs.length, saved: r.transactionId !== null },
    });
    return docs.map((d) => d.storageKey).filter((k) => k !== null);
  });
  if (deps.storage) {
    const own = keys.filter((k) => isKeyOfHousehold(k, householdId));
    await Promise.allSettled(own.map((k) => deps.storage!.delete(k)));
  }
}

// --- Legătura tranzacție → bon ---------------------------------------------------------------------

/** Bonul (id) din care s-au creat tranzacțiile date (insigna „din bon” și linkul din listă). */
export async function receiptIdsForTransactions(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transactionIds: readonly string[],
): Promise<Map<string, string>> {
  if (transactionIds.length === 0) return new Map();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await tx
      .select({ id: receipts.id, transactionId: receipts.transactionId })
      .from(receipts)
      .where(
        and(
          eq(receipts.householdId, m.householdId),
          inArray(receipts.transactionId, [...transactionIds]),
        ),
      );
    return new Map(
      rows.filter((r) => r.transactionId !== null).map((r) => [r.transactionId!, r.id] as const),
    );
  });
}
