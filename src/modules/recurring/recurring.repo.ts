import "server-only";

import { and, asc, eq, lte, sql } from "drizzle-orm";

import type { DbOrTx, Tx } from "@/db";
import { recurringOccurrences, recurringRules } from "@/db/schema";

/**
 * Accesul la regulile recurente (în tranzacția `withMember`, cu RLS și filtru pe gospodărie).
 * Excepția: `selectDueRules` apelează funcția SECURITY DEFINER `finet.due_recurring_rules`
 * (workerul, fără context de gospodărie), care întoarce doar identificatori.
 */

export type RecurringRuleRow = typeof recurringRules.$inferSelect;

export async function selectRules(
  tx: Tx,
  householdId: string,
  status?: RecurringRuleRow["status"],
): Promise<RecurringRuleRow[]> {
  const conditions = [eq(recurringRules.householdId, householdId)];
  if (status) conditions.push(eq(recurringRules.status, status));
  return tx
    .select()
    .from(recurringRules)
    .where(and(...conditions))
    .orderBy(
      sql`case ${recurringRules.status} when 'active' then 0 when 'paused' then 1 else 2 end`,
      asc(recurringRules.nextRunOn),
      asc(sql`lower(${recurringRules.description})`),
      asc(recurringRules.id),
    );
}

/** Contoarele gospodăriei: active, active cu scadență ≤ azi, total. */
export async function countRules(
  tx: Tx,
  householdId: string,
  today: string,
): Promise<{ active: number; due: number; total: number }> {
  const [row] = await tx
    .select({
      active: sql<number>`count(*) filter (where ${recurringRules.status} = 'active')::int`,
      due: sql<number>`count(*) filter (where ${recurringRules.status} = 'active' and ${recurringRules.nextRunOn} <= ${today}::date)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(recurringRules)
    .where(eq(recurringRules.householdId, householdId));
  return { active: row?.active ?? 0, due: row?.due ?? 0, total: row?.total ?? 0 };
}

/** Id-urile regulilor active scadente ale gospodăriei (generarea la cerere). */
export async function selectDueRuleIds(
  tx: Tx,
  householdId: string,
  today: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: recurringRules.id })
    .from(recurringRules)
    .where(
      and(
        eq(recurringRules.householdId, householdId),
        eq(recurringRules.status, "active"),
        lte(recurringRules.nextRunOn, today),
      ),
    )
    .orderBy(asc(recurringRules.nextRunOn), asc(recurringRules.id));
  return rows.map((r) => r.id);
}

export async function selectRule(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<RecurringRuleRow | null> {
  const q = tx
    .select()
    .from(recurringRules)
    .where(and(eq(recurringRules.householdId, householdId), eq(recurringRules.id, id)))
    .limit(1);
  const rows = lock ? await q.for("update") : await q;
  return rows[0] ?? null;
}

/**
 * Regula, blocată pentru generare (`FOR UPDATE SKIP LOCKED`): o a doua generare simultană
 * (alt worker, butonul „Generează”) nu așteaptă și nu dublează, ci primește `null`.
 */
export async function lockRuleForGeneration(
  tx: Tx,
  householdId: string,
  id: string,
): Promise<RecurringRuleRow | null> {
  const rows = await tx
    .select()
    .from(recurringRules)
    .where(and(eq(recurringRules.householdId, householdId), eq(recurringRules.id, id)))
    .limit(1)
    .for("update", { skipLocked: true });
  return rows[0] ?? null;
}

export async function insertRule(
  tx: Tx,
  values: typeof recurringRules.$inferInsert,
): Promise<RecurringRuleRow> {
  const [row] = await tx.insert(recurringRules).values(values).returning();
  return row!;
}

export type RulePatch = Partial<
  Pick<
    typeof recurringRules.$inferInsert,
    | "accountId"
    | "currency"
    | "categoryId"
    | "amountMinor"
    | "description"
    | "merchant"
    | "frequency"
    | "interval"
    | "dayOfMonth"
    | "nextRunOn"
    | "endOn"
    | "maxOccurrences"
    | "occurrencesCount"
    | "status"
    | "lastErrorCode"
    | "retryAfter"
  >
>;

export async function updateRuleRow(
  tx: Tx,
  householdId: string,
  id: string,
  patch: RulePatch,
): Promise<RecurringRuleRow | null> {
  const [row] = await tx
    .update(recurringRules)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(recurringRules.householdId, householdId), eq(recurringRules.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteRuleRow(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(recurringRules)
    .where(and(eq(recurringRules.householdId, householdId), eq(recurringRules.id, id)))
    .returning({ id: recurringRules.id });
  return rows.length > 0;
}

/**
 * Înregistrează ocurența `(rule, date)` cu id-ul tranzacției care urmează să fie creată. `false`
 * dacă există deja (conflict pe cheia primară = deja generată): apelantul NU mai creează nimic.
 */
export async function claimOccurrence(
  tx: Tx,
  values: Readonly<{ ruleId: string; householdId: string; date: string; transactionId: string }>,
): Promise<boolean> {
  const rows = await tx
    .insert(recurringOccurrences)
    .values({
      ruleId: values.ruleId,
      householdId: values.householdId,
      occurrenceDate: values.date,
      transactionId: values.transactionId,
    })
    .onConflictDoNothing({
      target: [recurringOccurrences.ruleId, recurringOccurrences.occurrenceDate],
    })
    .returning({ ruleId: recurringOccurrences.ruleId });
  return rows.length > 0;
}

/** Ultima dată generată a regulii (sau `null`). */
export async function lastOccurrenceDate(tx: Tx, householdId: string, ruleId: string) {
  const [row] = await tx
    .select({ last: sql<string | null>`max(${recurringOccurrences.occurrenceDate})::text` })
    .from(recurringOccurrences)
    .where(
      and(
        eq(recurringOccurrences.householdId, householdId),
        eq(recurringOccurrences.ruleId, ruleId),
      ),
    );
  return row?.last ?? null;
}

export type DueRule = Readonly<{ ruleId: string; householdId: string; actorUserId: string }>;

/**
 * Scadențele tuturor gospodăriilor, pentru worker (fără context RLS): DOAR identificatori, din
 * funcția `finet.due_recurring_rules` (migrația 0006).
 */
export async function selectDueRules(db: DbOrTx, today: string, limit: number): Promise<DueRule[]> {
  const rows = await db.execute<{ rule_id: string; household_id: string; actor_user_id: string }>(
    sql`select rule_id, household_id, actor_user_id from finet.due_recurring_rules(${today}::date, ${limit}::int)`,
  );
  return rows.map((r) => ({
    ruleId: r.rule_id,
    householdId: r.household_id,
    actorUserId: r.actor_user_id,
  }));
}
