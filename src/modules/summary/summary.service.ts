import "server-only";

import type { Actor } from "@/lib/authz";
import { addMonths } from "@/lib/calendar";
import { ValidationError } from "@/lib/errors";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { categoryNames } from "@/modules/dashboard/dashboard.service";
import { inHousehold } from "@/modules/ledger/context";
import { getMonthlyReport } from "@/modules/reports/reports.service";

import { type MonthlySummary, buildSummary } from "./summary";

/**
 * Rezumatul lunii (F10-C; ADR 0025): raportul lunii cerute (implicit cea curentă) și al lunii
 * precedente, sub aceleași reguli de vizibilitate ca `/reports`; textul se construiește în cod.
 * Luna precedentă în afara intervalului acceptat (5 ani) lipsește pur și simplu din comparație.
 */
export async function getMonthlySummary(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<MonthlySummary> {
  const current = await getMonthlyReport(deps, actor, householdId, rawQuery);
  let previous = null;
  try {
    previous = await getMonthlyReport(deps, actor, householdId, {
      month: addMonths(current.month, -1),
    });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  const names = await inHousehold(deps, actor, householdId, (tx, m) =>
    categoryNames(tx, m.householdId),
  );
  return buildSummary(current, previous, names);
}
