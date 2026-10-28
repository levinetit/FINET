import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { accounts, householdMembers, transactions } from "@/db/schema";

/**
 * Accesul la `accounts` (în tranzacția `withMember`, cu RLS). Fiecare query filtrează și explicit
 * după `household_id` (6.2, stratul 1), pe lângă politicile din bază (stratul 2).
 */

export type AccountRow = typeof accounts.$inferSelect;

export async function selectAccounts(
  tx: Tx,
  householdId: string,
  options: Readonly<{ includeArchived: boolean; ids?: readonly string[] }>,
): Promise<AccountRow[]> {
  const conditions = [eq(accounts.householdId, householdId)];
  if (!options.includeArchived) conditions.push(isNull(accounts.archivedAt));
  if (options.ids) conditions.push(inArray(accounts.id, [...options.ids]));
  return tx
    .select()
    .from(accounts)
    .where(and(...conditions))
    .orderBy(asc(accounts.archivedAt), asc(sql`lower(${accounts.name})`), asc(accounts.id));
}

/** Contul din gospodărie, opțional blocat (`FOR UPDATE`) pentru modificări. */
export async function selectAccount(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<AccountRow | null> {
  const q = tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), eq(accounts.id, id)))
    .limit(1);
  const rows = lock ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/**
 * Sumele pe cont și pe tip (text din `sum(bigint)` = `numeric`, convertite de apelant în `bigint`).
 * Transferurile sunt separate pe sens: `in` intră în cont, `out` iese.
 */
export type AccountSums = Readonly<{
  accountId: string;
  income: string;
  expense: string;
  transferIn: string;
  transferOut: string;
}>;

export async function selectAccountSums(
  tx: Tx,
  householdId: string,
  accountIds: readonly string[],
): Promise<AccountSums[]> {
  if (accountIds.length === 0) return [];
  const amount = transactions.amountMinor;
  const sumWhere = (cond: ReturnType<typeof sql>) =>
    sql<string>`coalesce(sum(${amount}) filter (where ${cond}), 0)::text`;
  return tx
    .select({
      accountId: transactions.accountId,
      income: sumWhere(sql`${transactions.type} = 'income'`),
      expense: sumWhere(sql`${transactions.type} = 'expense'`),
      transferIn: sumWhere(
        sql`${transactions.type} = 'transfer' and ${transactions.transferDirection} = 'in'`,
      ),
      transferOut: sumWhere(
        sql`${transactions.type} = 'transfer' and ${transactions.transferDirection} = 'out'`,
      ),
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        inArray(transactions.accountId, [...accountIds]),
      ),
    )
    .groupBy(transactions.accountId);
}

export async function insertAccount(
  tx: Tx,
  values: typeof accounts.$inferInsert,
): Promise<AccountRow> {
  const [row] = await tx.insert(accounts).values(values).returning();
  return row!;
}

export async function updateAccountRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<
    Pick<
      typeof accounts.$inferInsert,
      | "name"
      | "type"
      | "currency"
      | "openingBalanceMinor"
      | "bankCode"
      | "ownerUserId"
      | "archivedAt"
    >
  >,
): Promise<AccountRow | null> {
  const [row] = await tx
    .update(accounts)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(accounts.householdId, householdId), eq(accounts.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteAccountRow(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(accounts)
    .where(and(eq(accounts.householdId, householdId), eq(accounts.id, id)))
    .returning({ id: accounts.id });
  return rows.length > 0;
}

export async function accountHasTransactions(
  tx: Tx,
  householdId: string,
  id: string,
): Promise<boolean> {
  const rows = await tx
    .select({ one: sql<number>`1` })
    .from(transactions)
    .where(and(eq(transactions.householdId, householdId), eq(transactions.accountId, id)))
    .limit(1);
  return rows.length > 0;
}

export async function isHouseholdMember(
  tx: Tx,
  householdId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ one: sql<number>`1` })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}
