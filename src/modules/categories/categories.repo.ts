import "server-only";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { categories, categoryVisibility, transactions } from "@/db/schema";

/**
 * Accesul la categorii (în tranzacția `withMember`, cu RLS). Categoriile vizibile unei gospodării
 * = cele de sistem (`household_id IS NULL`) + cele proprii; filtrul explicit dublează RLS.
 */

export type CategoryRow = typeof categories.$inferSelect & { visibilityHidden: boolean | null };

const visibleTo = (householdId: string) =>
  or(isNull(categories.householdId), eq(categories.householdId, householdId));

export async function selectCategories(tx: Tx, householdId: string): Promise<CategoryRow[]> {
  const rows = await tx
    .select({ c: categories, visibilityHidden: categoryVisibility.hidden })
    .from(categories)
    .leftJoin(
      categoryVisibility,
      and(
        eq(categoryVisibility.categoryId, categories.id),
        eq(categoryVisibility.householdId, householdId),
      ),
    )
    .where(visibleTo(householdId))
    .orderBy(
      asc(categories.kind),
      sql`${categories.householdId} is not null`,
      asc(categories.sortOrder),
      asc(sql`lower(${categories.name})`),
      asc(categories.id),
    );
  return rows.map((r) => ({ ...r.c, visibilityHidden: r.visibilityHidden }));
}

export async function selectCategory(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<CategoryRow | null> {
  const q = tx
    .select({ c: categories, visibilityHidden: categoryVisibility.hidden })
    .from(categories)
    .leftJoin(
      categoryVisibility,
      and(
        eq(categoryVisibility.categoryId, categories.id),
        eq(categoryVisibility.householdId, householdId),
      ),
    )
    .where(and(eq(categories.id, id), visibleTo(householdId)))
    .limit(1);
  if (lock) {
    // Doar categoriile proprii se blochează (pe cele de sistem finet_app nu le poate modifica).
    const locked = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.householdId, householdId)))
      .for("update");
    if (locked.length === 0) return null;
  }
  const rows = await q;
  const r = rows[0];
  return r ? { ...r.c, visibilityHidden: r.visibilityHidden } : null;
}

export async function insertCategory(
  tx: Tx,
  values: typeof categories.$inferInsert,
): Promise<typeof categories.$inferSelect> {
  const [row] = await tx.insert(categories).values(values).returning();
  return row!;
}

export async function updateCategoryRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<
    Pick<typeof categories.$inferInsert, "name" | "parentId" | "icon" | "color" | "hidden">
  >,
): Promise<boolean> {
  const rows = await tx
    .update(categories)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(categories.householdId, householdId), eq(categories.id, id)))
    .returning({ id: categories.id });
  return rows.length > 0;
}

export async function upsertVisibility(
  tx: Tx,
  householdId: string,
  categoryId: string,
  hidden: boolean,
): Promise<void> {
  await tx
    .insert(categoryVisibility)
    .values({ householdId, categoryId, hidden })
    .onConflictDoUpdate({
      target: [categoryVisibility.householdId, categoryVisibility.categoryId],
      set: { hidden, updatedAt: new Date() },
    });
}

export async function hasChildren(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .select({ one: sql<number>`1` })
    .from(categories)
    .where(and(eq(categories.parentId, id), visibleTo(householdId)))
    .limit(1);
  return rows.length > 0;
}

export async function countUsage(tx: Tx, householdId: string, id: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(eq(transactions.householdId, householdId), eq(transactions.categoryId, id)));
  return row?.n ?? 0;
}

export async function reassignTransactions(
  tx: Tx,
  householdId: string,
  fromId: string,
  toId: string,
): Promise<number> {
  const rows = await tx
    .update(transactions)
    .set({ categoryId: toId, updatedAt: new Date() })
    .where(and(eq(transactions.householdId, householdId), eq(transactions.categoryId, fromId)))
    .returning({ id: transactions.id });
  return rows.length;
}

/**
 * Faza 8 (revizuirea m1): categoria e folosită în rânduri pe care utilizatorul curent NU le vede
 * (tranzacții sau reguli din conturile personale ale altor membri, bugetele lor personale)?
 * Funcția SECURITY DEFINER întoarce doar un boolean, pentru gospodăria din contextul RLS.
 */
export async function categoryUsedElsewhere(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.execute<{ used: boolean }>(
    sql`select finet.category_used_elsewhere(${id}::uuid) as used`,
  );
  return rows[0]?.used === true;
}

/** Câți membri are gospodăria (din contextul RLS: membrii gospodăriei curente). */
export async function householdMemberCount(tx: Tx, householdId: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from finet.household_members where household_id = ${householdId}`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function deleteCategoryRow(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(categories)
    .where(and(eq(categories.householdId, householdId), eq(categories.id, id)))
    .returning({ id: categories.id });
  return rows.length > 0;
}
