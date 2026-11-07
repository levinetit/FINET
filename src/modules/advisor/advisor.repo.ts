import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { categories, transactions } from "@/db/schema";
import type { Currency } from "@/lib/money";

/**
 * Agregările consilierului (modernizare 2026, pasul F; ADR 0045), în tranzacția `withMember`
 * (RLS + filtru explicit pe gospodărie). Doar cheltuieli (`type = 'expense'`). Comerciantul e
 * normalizat ca la topul comercianților (`lower(btrim(merchant))`); medianele sunt
 * `percentile_disc` (o valoare reală din date, `bigint`, nu o medie cu zecimale).
 */

const t = transactions;
const between = (from: string, to: string) =>
  sql`${t.occurredOn} between ${from}::date and ${to}::date`;
const merchantKey = sql<string | null>`nullif(lower(btrim(${t.merchant})), '')`;
const root = sql<string | null>`coalesce(${categories.parentId}, ${t.categoryId})`;

export type ExpenseRow = Readonly<{
  id: string;
  currency: Currency;
  occurredOn: string;
  amountMinor: bigint;
  merchant: string | null;
  merchantKey: string | null;
  categoryId: string | null;
  rootCategoryId: string | null;
  description: string | null;
  source: string;
}>;

/** Cele mai mari `limit` cheltuieli ale lunii (cele mici nu pot fi „neobișnuite”). */
export async function selectMonthExpenses(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
  limit: number,
): Promise<ExpenseRow[]> {
  return tx
    .select({
      id: t.id,
      currency: t.currency,
      occurredOn: t.occurredOn,
      amountMinor: t.amountMinor,
      merchant: t.merchant,
      merchantKey,
      categoryId: t.categoryId,
      rootCategoryId: root,
      description: t.description,
      source: t.source,
    })
    .from(t)
    .leftJoin(categories, eq(categories.id, t.categoryId))
    .where(and(eq(t.householdId, householdId), eq(t.type, "expense"), between(from, to)))
    .orderBy(sql`${t.amountMinor} desc`, sql`${t.occurredOn} desc`, sql`${t.id}`)
    .limit(limit);
}

export type MerchantStatRow = Readonly<{
  currency: Currency;
  merchantKey: string;
  merchant: string;
  count: number;
  median: string;
}>;

/** Pe comerciant normalizat, în interval: numărul de cheltuieli și mediana sumei. */
export async function selectMerchantStats(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<MerchantStatRow[]> {
  const rows = await tx
    .select({
      currency: t.currency,
      merchantKey: sql<string>`lower(btrim(${t.merchant}))`,
      merchant: sql<string>`min(btrim(${t.merchant}))`,
      count: sql<number>`count(*)::int`,
      median: sql<string>`(percentile_disc(0.5) within group (order by ${t.amountMinor}))::text`,
    })
    .from(t)
    .where(
      and(
        eq(t.householdId, householdId),
        eq(t.type, "expense"),
        between(from, to),
        sql`${t.merchant} is not null and btrim(${t.merchant}) <> ''`,
      ),
    )
    .groupBy(t.currency, sql`lower(btrim(${t.merchant}))`);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export type CategoryStatRow = Readonly<{
  currency: Currency;
  rootCategoryId: string | null;
  count: number;
  median: string;
}>;

/** Pe categorie-părinte, în interval: numărul de cheltuieli și mediana sumei unei cheltuieli. */
export async function selectCategoryStats(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<CategoryStatRow[]> {
  const rows = await tx
    .select({
      currency: t.currency,
      rootCategoryId: root,
      count: sql<number>`count(*)::int`,
      median: sql<string>`(percentile_disc(0.5) within group (order by ${t.amountMinor}))::text`,
    })
    .from(t)
    .leftJoin(categories, eq(categories.id, t.categoryId))
    .where(and(eq(t.householdId, householdId), eq(t.type, "expense"), between(from, to)))
    .groupBy(t.currency, root);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export type CategoryMonthRow = Readonly<{
  currency: Currency;
  month: string;
  rootCategoryId: string | null;
  total: string;
}>;

/** Totalul cheltuielilor pe (monedă, lună, categorie-părinte) în interval. */
export async function selectMonthlyByRootCategory(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<CategoryMonthRow[]> {
  const month = sql<string>`to_char(${t.occurredOn}, 'YYYY-MM')`;
  return tx
    .select({
      currency: t.currency,
      month,
      rootCategoryId: root,
      total: sql<string>`sum(${t.amountMinor})::text`,
    })
    .from(t)
    .leftJoin(categories, eq(categories.id, t.categoryId))
    .where(and(eq(t.householdId, householdId), eq(t.type, "expense"), between(from, to)))
    .groupBy(t.currency, month, root);
}
