import "server-only";

import {
  type SQL,
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Tx } from "@/db";
import { receiptLines, receipts, transactionTags, transactions } from "@/db/schema";
import type { Currency } from "@/lib/money";

import type { PriceLine } from "./prices";

/**
 * Citirile din bază pentru prețuri, inflație și rapoartele de micro-cheltuieli (Faza 10, F10-B;
 * ADR 0023). Toate rulează în tranzacția `withMember` (RLS + filtru explicit pe gospodărie) și
 * trec prin ACELAȘI filtru de bonuri: `confirmedVisibleReceipts`.
 *
 * VIZIBILITATEA (conturi personale, Faza 8). `receipts` și `receipt_lines` sunt vizibile tuturor
 * membrilor gospodăriei (ADR 0016, „amânat”), dar legătura cu un cont e DOAR
 * `receipts.transaction_id → transactions.account_id`, iar `transactions` are RLS pe cont
 * (personal ⇒ doar proprietarul). Un bon intră în agregatele unui membru dacă NU are tranzacție
 * (`transaction_id IS NULL`: nelegat sau tranzacția a fost ștearsă, `SET NULL`) SAU tranzacția lui
 * e VIZIBILĂ aceluiași membru (`EXISTS` sub RLS-ul lui). NU `LEFT JOIN … IS NULL`: o tranzacție
 * invizibilă ar semăna cu „fără tranzacție” și linia ar scăpa în agregat.
 *
 * „Confirmat” = `status = 'saved'` (setat de `confirmReceipt`, odată cu `transaction_id`) și dată
 * cunoscută. Bonurile marcate duplicat (`duplicate_of_receipt_id`) și confirmate explicit rămân:
 * utilizatorul a spus că e o cumpărătură separată.
 */

/** Plafonul liniilor citite într-o cerere (peste el: cod fix, utilizatorul îngustează perioada). */
export const MAX_SCAN_LINES = 100_000;

/** S-au găsit mai multe linii decât `MAX_SCAN_LINES`. Fără conținut. */
export class TooManyLinesError extends Error {
  readonly code = "too_many_lines";
  constructor() {
    super("Prea multe linii de bon pentru perioada aleasă.");
    this.name = "TooManyLinesError";
  }
}

export type DateWindow = Readonly<{ from: string | null; to: string | null }>;

/** Condiția pe `receipts` (în afara oricărui join): confirmat, cu dată, vizibil, în fereastră. */
export function confirmedVisibleReceipts(
  tx: Tx,
  householdId: string,
  window: DateWindow = { from: null, to: null },
): SQL {
  const visible = or(
    isNull(receipts.transactionId),
    exists(
      tx
        .select({ one: sql`1` })
        .from(transactions)
        .where(eq(transactions.id, receipts.transactionId)),
    ),
  )!;
  return and(
    eq(receipts.householdId, householdId),
    eq(receipts.status, "saved"),
    isNotNull(receipts.occurredOn),
    visible,
    window.from === null ? undefined : gte(receipts.occurredOn, window.from),
    window.to === null ? undefined : lte(receipts.occurredOn, window.to),
  )!;
}

/**
 * Cheia comerciantului: CUI fără prefixul `RO` (lanțul, nu magazinul fizic), altfel numele
 * normalizat (`n:` + litere mici); `NULL` fără niciuna.
 */
export const merchantKeySql = sql<string | null>`coalesce(
  nullif(regexp_replace(upper(${receipts.merchantTaxId}), '^RO', ''), ''),
  case when nullif(btrim(${receipts.merchantName}), '') is null then null
       else 'n:' || lower(btrim(${receipts.merchantName})) end)`;

/**
 * Liniile de PRODUS ale bonurilor confirmate vizibile din fereastră, pentru prețuri și inflație.
 * Ordonate după dată; peste `MAX_SCAN_LINES` → `TooManyLinesError`.
 */
export async function selectPriceLines(
  tx: Tx,
  householdId: string,
  window: DateWindow,
): Promise<PriceLine[]> {
  const rows = await tx
    .select({
      normalizedName: receiptLines.normalizedName,
      quantity: receiptLines.quantity,
      lineTotalMinor: receiptLines.lineTotalMinor,
      occurredOn: receipts.occurredOn,
      currency: receipts.currency,
      merchantKey: merchantKeySql,
      merchantName: receipts.merchantName,
    })
    .from(receiptLines)
    .innerJoin(
      receipts,
      and(
        eq(receipts.id, receiptLines.receiptId),
        eq(receipts.householdId, receiptLines.householdId),
      ),
    )
    .where(
      and(
        eq(receiptLines.householdId, householdId),
        eq(receiptLines.kind, "product"),
        isNotNull(receiptLines.normalizedName),
        confirmedVisibleReceipts(tx, householdId, window),
      ),
    )
    .orderBy(asc(receipts.occurredOn), asc(receiptLines.id))
    .limit(MAX_SCAN_LINES + 1);
  if (rows.length > MAX_SCAN_LINES) throw new TooManyLinesError();
  return rows.map((r) => ({
    normalizedName: r.normalizedName!,
    quantity: r.quantity,
    lineTotalMinor: r.lineTotalMinor,
    occurredOn: r.occurredOn!,
    currency: r.currency as Currency,
    merchantKey: r.merchantKey,
    merchantName: r.merchantName,
  }));
}

export type LineFilter = Readonly<{
  kinds: readonly string[];
  categoryIds: readonly string[];
  tagIds: readonly string[];
}>;

/** Un rând candidat pentru un raport (potrivirea pe nume se face în cod). */
export type CandidateRow = Readonly<{
  id: string;
  receiptId: string;
  occurredOn: string;
  currency: Currency;
  kind: "product" | "discount" | "deposit_sgr" | "bag" | "other";
  rawName: string;
  normalizedName: string;
  quantity: string | null;
  lineTotalMinor: bigint;
  merchantName: string | null;
}>;

/**
 * Liniile candidate ale unui raport: tipul/categoria/eticheta cerute (eticheta = o etichetă pe
 * tranzacția bonului), bonuri confirmate vizibile, în fereastră. Fără nume normalizat nu se
 * potrivește nimic. Peste `MAX_SCAN_LINES` → `TooManyLinesError`.
 */
export async function selectCandidateLines(
  tx: Tx,
  householdId: string,
  filter: LineFilter,
  window: DateWindow,
): Promise<CandidateRow[]> {
  const rows = await tx
    .select({
      id: receiptLines.id,
      receiptId: receiptLines.receiptId,
      occurredOn: receipts.occurredOn,
      currency: receipts.currency,
      kind: receiptLines.kind,
      rawName: receiptLines.rawName,
      normalizedName: receiptLines.normalizedName,
      quantity: receiptLines.quantity,
      lineTotalMinor: receiptLines.lineTotalMinor,
      merchantName: receipts.merchantName,
    })
    .from(receiptLines)
    .innerJoin(
      receipts,
      and(
        eq(receipts.id, receiptLines.receiptId),
        eq(receipts.householdId, receiptLines.householdId),
      ),
    )
    .where(
      and(
        eq(receiptLines.householdId, householdId),
        isNotNull(receiptLines.normalizedName),
        inArray(receiptLines.kind, [...filter.kinds] as CandidateRow["kind"][]),
        filter.categoryIds.length === 0
          ? undefined
          : inArray(receiptLines.categoryId, [...filter.categoryIds]),
        filter.tagIds.length === 0
          ? undefined
          : exists(
              tx
                .select({ one: sql`1` })
                .from(transactionTags)
                .where(
                  and(
                    eq(transactionTags.transactionId, receipts.transactionId),
                    inArray(transactionTags.tagId, [...filter.tagIds]),
                  ),
                ),
            ),
        confirmedVisibleReceipts(tx, householdId, window),
      ),
    )
    .orderBy(asc(receipts.occurredOn), asc(receiptLines.id))
    .limit(MAX_SCAN_LINES + 1);
  if (rows.length > MAX_SCAN_LINES) throw new TooManyLinesError();
  return rows.map((r) => ({
    id: r.id,
    receiptId: r.receiptId,
    occurredOn: r.occurredOn!,
    currency: r.currency as Currency,
    kind: r.kind,
    rawName: r.rawName,
    normalizedName: r.normalizedName!,
    quantity: r.quantity,
    lineTotalMinor: r.lineTotalMinor,
    merchantName: r.merchantName,
  }));
}

export type CoverageRow = Readonly<{
  firstOn: string | null;
  lastOn: string | null;
  receipts: number;
}>;

/** Primul/ultimul bon confirmat vizibil din fereastră și câte sunt (baza proiecției anuale). */
export async function selectCoverage(
  tx: Tx,
  householdId: string,
  window: DateWindow,
): Promise<CoverageRow> {
  const [row] = await tx
    .select({
      firstOn: sql<string | null>`min(${receipts.occurredOn})`,
      lastOn: sql<string | null>`max(${receipts.occurredOn})`,
      receipts: sql<number>`count(*)::int`,
    })
    .from(receipts)
    .where(confirmedVisibleReceipts(tx, householdId, window));
  return {
    firstOn: row?.firstOn ?? null,
    lastOn: row?.lastOn ?? null,
    receipts: Number(row?.receipts ?? 0),
  };
}
