import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { transactions } from "@/db/schema";
import type { Currency } from "@/lib/money";

/**
 * Agregările prognozei (ADR 0045): totalurile lunare pe (monedă, lună, recurent/nerecurent), în
 * tranzacția `withMember` (RLS + filtru explicit pe gospodărie). Doar venituri și cheltuieli,
 * ca în `dashboard.repo.ts`. „Recurent” = `source = 'recurring'` (generat de o regulă).
 */

const t = transactions;

export type SourceMonthRow = Readonly<{
  currency: Currency;
  month: string;
  recurring: boolean;
  income: string;
  expense: string;
}>;

export async function selectMonthlyTotalsBySource(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<SourceMonthRow[]> {
  const month = sql<string>`to_char(${t.occurredOn}, 'YYYY-MM')`;
  const recurring = sql<boolean>`(${t.source} = 'recurring')`;
  const sumOf = (type: "income" | "expense") =>
    sql<string>`coalesce(sum(${t.amountMinor}) filter (where ${t.type} = ${type}), 0)::text`;
  return tx
    .select({
      currency: t.currency,
      month,
      recurring,
      income: sumOf("income"),
      expense: sumOf("expense"),
    })
    .from(t)
    .where(
      and(
        eq(t.householdId, householdId),
        inArray(t.type, ["income", "expense"]),
        sql`${t.occurredOn} between ${from}::date and ${to}::date`,
      ),
    )
    .groupBy(t.currency, month, recurring);
}
