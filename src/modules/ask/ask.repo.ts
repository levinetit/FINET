import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { transactions } from "@/db/schema";
import type { Currency } from "@/lib/money";

/**
 * Citirile „Întreabă FINET” (F10-C; ADR 0025): agregate filtrate pe tranzacțiile vizibile
 * membrului (sub RLS, conturile personale ale altora nu intră) și lista comercianților, folosită
 * doar ca să recunoască un nume din întrebare. Valorile filtrelor sunt parametri legați, niciodată
 * text în SQL.
 */

const t = transactions;

export type TotalRow = Readonly<{ currency: Currency; total: string; count: number }>;

export async function selectAskTotals(
  tx: Tx,
  householdId: string,
  type: "income" | "expense",
  from: string,
  to: string,
  categoryIds: readonly string[] | null,
  merchantKey: string | null,
): Promise<TotalRow[]> {
  const rows = await tx
    .select({
      currency: t.currency,
      total: sql<string>`coalesce(sum(${t.amountMinor}), 0)::text`,
      count: sql<number>`count(*)::int`,
    })
    .from(t)
    .where(
      and(
        eq(t.householdId, householdId),
        eq(t.type, type),
        sql`${t.occurredOn} between ${from}::date and ${to}::date`,
        categoryIds === null ? undefined : inArray(t.categoryId, [...categoryIds]),
        merchantKey === null ? undefined : sql`lower(btrim(${t.merchant})) = ${merchantKey}`,
      ),
    )
    .groupBy(t.currency);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

/** Comercianții folosiți în ultimele 36 de luni (cei mai frecvenți primii, cel mult 500). */
export async function selectKnownMerchants(
  tx: Tx,
  householdId: string,
  since: string,
): Promise<string[]> {
  const rows = await tx.execute<{ merchant: string }>(sql`
    select min(btrim(${t.merchant})) as merchant
      from ${t}
     where ${t.householdId} = ${householdId} and ${t.type} in ('expense', 'income')
       and ${t.occurredOn} >= ${since}::date
       and ${t.merchant} is not null and btrim(${t.merchant}) <> ''
     group by lower(btrim(${t.merchant}))
     order by count(*) desc, lower(btrim(${t.merchant}))
     limit 500`);
  return rows.map((r) => r.merchant);
}
