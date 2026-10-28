import "server-only";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { budgets, categories, households, transactions } from "@/db/schema";

/**
 * Accesul la bugete (în tranzacția `withMember`, cu RLS). Filtrul explicit pe gospodărie și pe
 * vizibilitate (bugetele personale doar ale actorului) dublează politica `budgets_household`.
 */

export type BudgetRow = typeof budgets.$inferSelect;

const visibleTo = (householdId: string, userId: string) =>
  and(
    eq(budgets.householdId, householdId),
    or(eq(budgets.scope, "household"), eq(budgets.userId, userId)),
  );

export async function selectBudgets(
  tx: Tx,
  householdId: string,
  userId: string,
  includeArchived: boolean,
): Promise<BudgetRow[]> {
  const conditions = [visibleTo(householdId, userId)];
  if (!includeArchived) conditions.push(isNull(budgets.archivedAt));
  return tx
    .select()
    .from(budgets)
    .where(and(...conditions))
    .orderBy(
      asc(budgets.archivedAt),
      asc(budgets.scope),
      sql`${budgets.categoryId} is not null`,
      asc(budgets.currency),
      asc(budgets.createdAt),
      asc(budgets.id),
    );
}

export async function selectBudget(
  tx: Tx,
  householdId: string,
  userId: string,
  id: string,
  lock = false,
): Promise<BudgetRow | null> {
  const q = tx
    .select()
    .from(budgets)
    .where(and(visibleTo(householdId, userId), eq(budgets.id, id)))
    .limit(1);
  const rows = lock ? await q.for("update") : await q;
  return rows[0] ?? null;
}

export async function insertBudget(
  tx: Tx,
  values: typeof budgets.$inferInsert,
): Promise<BudgetRow> {
  const [row] = await tx.insert(budgets).values(values).returning();
  return row!;
}

export async function updateBudgetRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<Pick<typeof budgets.$inferInsert, "amountMinor" | "warnPct" | "archivedAt">>,
): Promise<BudgetRow | null> {
  const [row] = await tx
    .update(budgets)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(budgets.householdId, householdId), eq(budgets.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteBudgetRow(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(budgets)
    .where(and(eq(budgets.householdId, householdId), eq(budgets.id, id)))
    .returning({ id: budgets.id });
  return rows.length > 0;
}

/** Fusul orar al gospodăriei (pentru „luna curentă”). */
export async function selectHouseholdTimeZone(tx: Tx, householdId: string): Promise<string | null> {
  const rows = await tx
    .select({ timezone: households.timezone })
    .from(households)
    .where(eq(households.id, householdId))
    .limit(1);
  return rows[0]?.timezone ?? null;
}

/**
 * Cheltuielile unui interval de zile, grupate pe (monedă, categorie-PĂRINTE, categorie, autor).
 * `parentId` = părintele categoriei (sau categoria însăși, dacă nu are), ca un buget pe părinte să
 * includă subcategoriile. Doar `type = 'expense'`: veniturile și transferurile NU contează. Sumele
 * sunt text (`sum(bigint)` = `numeric`), convertite de apelant în `bigint`.
 */
export type ExpenseGroup = Readonly<{
  currency: BudgetRow["currency"];
  categoryId: string | null;
  rootCategoryId: string | null;
  createdByUserId: string | null;
  total: string;
}>;

export async function selectExpenseGroups(
  tx: Tx,
  householdId: string,
  from: string,
  to: string,
): Promise<ExpenseGroup[]> {
  const t = transactions;
  const root = sql<string | null>`coalesce(${categories.parentId}, ${t.categoryId})`;
  const rows = await tx
    .select({
      currency: t.currency,
      categoryId: t.categoryId,
      rootCategoryId: root,
      createdByUserId: t.createdByUserId,
      total: sql<string>`sum(${t.amountMinor})::text`,
    })
    .from(t)
    .leftJoin(categories, eq(categories.id, t.categoryId))
    .where(
      and(
        eq(t.householdId, householdId),
        eq(t.type, "expense"),
        sql`${t.occurredOn} between ${from}::date and ${to}::date`,
      ),
    )
    .groupBy(t.currency, t.categoryId, root, t.createdByUserId);
  return rows;
}
