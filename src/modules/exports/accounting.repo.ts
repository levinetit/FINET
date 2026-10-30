import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { receiptLines, receipts, transactions } from "@/db/schema";
import { confirmedVisibleReceipts } from "@/modules/prices/prices.repo";

/**
 * Citirile exportului pentru contabil (F10-C; ADR 0024). Aceeași regulă de vizibilitate ca la
 * prețuri (`confirmedVisibleReceipts`, F10-B): bonuri CONFIRMATE, cu dată, ale căror tranzacții
 * sunt vizibile membrului sub RLS; bonul unui cont personal al altui membru nu apare.
 */

export type AccountingWindow = Readonly<{ from: string; to: string }>;

export async function countAccountingReceipts(
  tx: Tx,
  householdId: string,
  window: AccountingWindow,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(receipts)
    .where(confirmedVisibleReceipts(tx, householdId, window));
  return row?.n ?? 0;
}

export async function selectAccountingReceipts(
  tx: Tx,
  householdId: string,
  window: AccountingWindow,
  limit: number,
) {
  return tx
    .select({
      id: receipts.id,
      occurredOn: receipts.occurredOn,
      number: receipts.receiptNumber,
      merchantName: receipts.merchantName,
      merchantTaxId: receipts.merchantTaxId,
      currency: receipts.currency,
      totalMinor: receipts.totalMinor,
      vatTotalMinor: receipts.vatTotalMinor,
      transactionId: receipts.transactionId,
    })
    .from(receipts)
    .where(confirmedVisibleReceipts(tx, householdId, window))
    .orderBy(asc(receipts.occurredOn), asc(receipts.id))
    .limit(limit);
}

/** Valoarea brută a liniilor, pe bon și cotă (o singură interogare pentru toată fereastra). */
export async function selectAccountingGroups(
  tx: Tx,
  householdId: string,
  window: AccountingWindow,
) {
  return tx
    .select({
      receiptId: receiptLines.receiptId,
      rate: receiptLines.vatRate,
      gross: sql<string>`sum(${receiptLines.lineTotalMinor})::text`,
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
        confirmedVisibleReceipts(tx, householdId, window),
      ),
    )
    .groupBy(receiptLines.receiptId, receiptLines.vatRate);
}

/** Contul și categoria tranzacțiilor bonurilor din fereastră (sub RLS: doar cele vizibile). */
export async function selectTransactionLinks(
  tx: Tx,
  householdId: string,
  window: AccountingWindow,
) {
  return tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      categoryId: transactions.categoryId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        inArray(
          transactions.id,
          tx
            .select({ id: receipts.transactionId })
            .from(receipts)
            .where(confirmedVisibleReceipts(tx, householdId, window)),
        ),
      ),
    );
}
