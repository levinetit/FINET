import "server-only";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { reportDefinitions } from "@/db/schema";

import type { ReportDefinitionView } from "./report-definitions.schema";
import { type ReportRules, reportRulesSchema } from "./rules";

/**
 * Citirile/scrierile `report_definitions` (în tranzacția `withMember`, deci sub RLS: rapoartele de
 * sistem + cele ale gospodăriei curente). Regulile se re-validează la citire (Zod): un rând cu
 * reguli corupte (editat de operator) devine eroare, nu un raport care potrivește ce nu trebuie.
 */

const t = reportDefinitions;
type Row = typeof t.$inferSelect;

export class CorruptRulesError extends Error {
  readonly code = "report_rules_corrupt";
  constructor() {
    super("Regulile raportului nu sunt valide.");
    this.name = "CorruptRulesError";
  }
}

function view(row: Row): ReportDefinitionView {
  const parsed = reportRulesSchema.safeParse(row.rules);
  if (!parsed.success) throw new CorruptRulesError();
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    advice: row.advice,
    rules: parsed.data as ReportRules,
    isSystem: row.isSystem,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Sistem primele (după nume), apoi ale gospodăriei (după nume). */
export async function selectDefinitions(
  tx: Tx,
  householdId: string,
  includeArchived: boolean,
): Promise<ReportDefinitionView[]> {
  const rows = await tx
    .select()
    .from(t)
    .where(
      and(
        or(isNull(t.householdId), eq(t.householdId, householdId)),
        includeArchived ? undefined : eq(t.archived, false),
      ),
    )
    .orderBy(sql`${t.isSystem} desc`, sql`lower(${t.name})`, asc(t.id));
  return rows.map(view);
}

export async function selectDefinition(
  tx: Tx,
  householdId: string,
  id: string,
): Promise<ReportDefinitionView | null> {
  const rows = await tx
    .select()
    .from(t)
    .where(and(eq(t.id, id), or(isNull(t.householdId), eq(t.householdId, householdId))))
    .limit(1);
  return rows[0] ? view(rows[0]) : null;
}

export async function insertDefinition(
  tx: Tx,
  input: Readonly<{
    householdId: string;
    createdByUserId: string;
    name: string;
    description: string | null;
    advice: string | null;
    rules: ReportRules;
  }>,
): Promise<ReportDefinitionView> {
  const [row] = await tx
    .insert(t)
    .values({
      householdId: input.householdId,
      name: input.name,
      description: input.description,
      advice: input.advice,
      rules: input.rules as unknown as Record<string, unknown>,
      isSystem: false,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return view(row!);
}

export async function updateDefinition(
  tx: Tx,
  householdId: string,
  id: string,
  patch: Partial<{
    name: string;
    description: string | null;
    advice: string | null;
    rules: ReportRules;
    archived: boolean;
  }>,
): Promise<ReportDefinitionView | null> {
  const { rules, ...rest } = patch;
  const [row] = await tx
    .update(t)
    .set({
      ...rest,
      ...(rules === undefined ? {} : { rules: rules as unknown as Record<string, unknown> }),
      updatedAt: new Date(),
    })
    .where(and(eq(t.id, id), eq(t.householdId, householdId)))
    .returning();
  return row ? view(row) : null;
}

export async function deleteDefinition(tx: Tx, householdId: string, id: string): Promise<boolean> {
  const rows = await tx
    .delete(t)
    .where(and(eq(t.id, id), eq(t.householdId, householdId)))
    .returning({ id: t.id });
  return rows.length > 0;
}

/** Câte rapoarte are gospodăria (pentru mesajul plafonului; plafonul real e triggerul din 0018). */
export async function countOwn(tx: Tx, householdId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(eq(t.householdId, householdId));
  return row?.n ?? 0;
}
