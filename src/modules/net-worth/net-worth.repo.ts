import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { accountValuations, transactions } from "@/db/schema";

/** Accesul la date al averii nete (ADR 0046), în tranzacția `withMember` (RLS + filtru explicit). */

export type ValuationRow = typeof accountValuations.$inferSelect;

export async function selectValuations(tx: Tx, householdId: string): Promise<ValuationRow[]> {
  return tx
    .select()
    .from(accountValuations)
    .where(eq(accountValuations.householdId, householdId))
    .orderBy(asc(accountValuations.valuedOn), asc(accountValuations.id));
}

export async function selectAccountValuations(
  tx: Tx,
  householdId: string,
  accountId: string,
): Promise<ValuationRow[]> {
  return tx
    .select()
    .from(accountValuations)
    .where(
      and(
        eq(accountValuations.householdId, householdId),
        eq(accountValuations.accountId, accountId),
      ),
    )
    .orderBy(desc(accountValuations.valuedOn), desc(accountValuations.id));
}

export async function insertValuation(
  tx: Tx,
  values: typeof accountValuations.$inferInsert,
): Promise<ValuationRow> {
  const [row] = await tx.insert(accountValuations).values(values).returning();
  return row!;
}

export async function deleteValuationRow(
  tx: Tx,
  householdId: string,
  accountId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .delete(accountValuations)
    .where(
      and(
        eq(accountValuations.householdId, householdId),
        eq(accountValuations.accountId, accountId),
        eq(accountValuations.id, id),
      ),
    )
    .returning({ id: accountValuations.id });
  return rows.length > 0;
}

export type AccountMonthNetRow = Readonly<{ accountId: string; month: string; net: string }>;

/**
 * Netul tranzacțiilor pe (cont, lună) până la `to` inclusiv: venituri și intrări de transfer cu
 * plus, cheltuieli și ieșiri cu minus (aceeași formulă ca soldul din `accounts.service.ts`).
 */
export async function selectAccountMonthlyNets(
  tx: Tx,
  householdId: string,
  to: string,
): Promise<AccountMonthNetRow[]> {
  const t = transactions;
  const month = sql<string>`to_char(${t.occurredOn}, 'YYYY-MM')`;
  const signed = sql<string>`coalesce(sum(case
      when ${t.type} = 'income' then ${t.amountMinor}
      when ${t.type} = 'expense' then -${t.amountMinor}
      when ${t.type} = 'transfer' and ${t.transferDirection} = 'in' then ${t.amountMinor}
      when ${t.type} = 'transfer' and ${t.transferDirection} = 'out' then -${t.amountMinor}
      else 0 end), 0)::text`;
  return tx
    .select({ accountId: t.accountId, month, net: signed })
    .from(t)
    .where(and(eq(t.householdId, householdId), sql`${t.occurredOn} <= ${to}::date`))
    .groupBy(t.accountId, month);
}
