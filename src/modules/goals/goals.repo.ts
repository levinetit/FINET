import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { goals } from "@/db/schema";

/** Accesul la obiective (în tranzacția `withMember`, cu RLS și filtru pe gospodărie). */

export type GoalRow = typeof goals.$inferSelect;

export async function selectGoals(
  tx: Tx,
  householdId: string,
  status?: GoalRow["status"],
): Promise<GoalRow[]> {
  const conditions = [eq(goals.householdId, householdId)];
  if (status) conditions.push(eq(goals.status, status));
  return tx
    .select()
    .from(goals)
    .where(and(...conditions))
    .orderBy(
      sql`case ${goals.status} when 'active' then 0 when 'achieved' then 1 else 2 end`,
      sql`${goals.deadline} asc nulls last`,
      asc(sql`lower(${goals.name})`),
      asc(goals.id),
    );
}

export async function selectGoal(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<GoalRow | null> {
  const q = tx
    .select()
    .from(goals)
    .where(and(eq(goals.householdId, householdId), eq(goals.id, id)))
    .limit(1);
  const rows = lock ? await q.for("update") : await q;
  return rows[0] ?? null;
}

export async function insertGoal(tx: Tx, values: typeof goals.$inferInsert): Promise<GoalRow> {
  const [row] = await tx.insert(goals).values(values).returning();
  return row!;
}

export async function updateGoalRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<
    Pick<
      typeof goals.$inferInsert,
      "name" | "targetMinor" | "savedMinor" | "deadline" | "status" | "accountId"
    >
  >,
): Promise<GoalRow | null> {
  const [row] = await tx
    .update(goals)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(goals.householdId, householdId), eq(goals.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteGoalRow(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(goals)
    .where(and(eq(goals.householdId, householdId), eq(goals.id, id)))
    .returning({ id: goals.id });
  return rows.length > 0;
}
