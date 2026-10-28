import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { DEFAULT_TIME_ZONE, type Month, currentMonth, monthBounds } from "@/lib/calendar";
import { ValidationError } from "@/lib/errors";
import { add, money, percentOf, sub, zero } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { selectCategory } from "@/modules/categories/categories.repo";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput, resolvePositiveAmount } from "@/modules/ledger/input";

import {
  type BudgetRow,
  type ExpenseGroup,
  deleteBudgetRow,
  insertBudget,
  selectBudget,
  selectBudgets,
  selectExpenseGroups,
  selectHouseholdTimeZone,
  updateBudgetRow,
} from "./budgets.repo";
import {
  type BudgetStatus,
  type BudgetStatusColor,
  type BudgetView,
  DEFAULT_WARN_PCT,
  budgetCreateSchema,
  budgetListSchema,
  budgetStatusQuerySchema,
  budgetUpdateSchema,
} from "./budgets.schema";

/**
 * Bugetele lunare (Faza 3): CRUD și starea pe o lună, cu semafor (ADR 0007).
 *
 * Cheltuit (`spentMinor`) = Σ cheltuieli (`type = 'expense'`) din luna calendaristică (după
 * `occurred_on`, dată locală), în MONEDA bugetului (fără conversie):
 * - buget pe categorie: categoria și subcategoriile ei; buget general: toate cheltuielile,
 *   inclusiv cele fără categorie;
 * - buget personal: doar cheltuielile introduse de proprietar (`created_by_user_id`, decizia mea);
 * - veniturile și transferurile nu contează niciodată.
 *
 * Semaforul se decide pe comparații EXACTE în bigint (nu pe procentul rotunjit):
 * verde: spent × 100 < warn_pct × amount; galben: altfel, dacă spent ≤ amount (inclusiv exact
 * 100%); roșu: spent > amount (chiar și 100,01%, afișat ca 100).
 */

/** Dependențele planificării: ceasul e injectabil (teste, „luna curentă”). */
export type PlanningDeps = LedgerDeps & Readonly<{ now?: () => Date }>;

export function view(row: BudgetRow): BudgetView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    period: row.period,
    amountMinor: row.amountMinor,
    currency: row.currency,
    warnPct: row.warnPct,
    scope: row.scope,
    userId: row.userId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Semaforul, din sume exacte. */
export function trafficLight(
  spentMinor: bigint,
  amountMinor: bigint,
  warnPct: number,
): BudgetStatusColor {
  if (spentMinor * 100n < BigInt(warnPct) * amountMinor) return "green";
  if (spentMinor <= amountMinor) return "yellow";
  return "red";
}

/** Cheltuit pentru un buget, din grupurile de cheltuieli ale lunii. */
export function spentFor(row: BudgetRow, groups: readonly ExpenseGroup[]): bigint {
  let total = zero(row.currency);
  for (const g of groups) {
    if (g.currency !== row.currency) continue;
    if (
      row.categoryId !== null &&
      g.rootCategoryId !== row.categoryId &&
      g.categoryId !== row.categoryId
    ) {
      continue;
    }
    if (row.scope === "personal" && g.createdByUserId !== row.userId) continue;
    total = add(total, money(BigInt(g.total), row.currency));
  }
  return total.amountMinor;
}

export function statusOf(
  row: BudgetRow,
  month: Month,
  groups: readonly ExpenseGroup[],
): BudgetStatus {
  const spentMinor = spentFor(row, groups);
  const remaining = sub(money(row.amountMinor, row.currency), money(spentMinor, row.currency));
  return {
    ...view(row),
    month,
    spentMinor,
    remainingMinor: remaining.amountMinor,
    percent: percentOf(spentMinor, row.amountMinor, "floor") ?? 0,
    status: trafficLight(spentMinor, row.amountMinor, row.warnPct),
  };
}

/** Luna cerută sau luna curentă în fusul orar al gospodăriei. */
export async function resolveMonth(
  tx: Tx,
  householdId: string,
  month: Month | undefined,
  now: () => Date,
): Promise<Month> {
  if (month) return month;
  const tz = (await selectHouseholdTimeZone(tx, householdId)) ?? DEFAULT_TIME_ZONE;
  return currentMonth(now(), tz);
}

/** Stările bugetelor active vizibile actorului pentru o lună (în tranzacția apelantului). */
export async function budgetStatusesIn(
  tx: Tx,
  householdId: string,
  userId: string,
  month: Month,
): Promise<BudgetStatus[]> {
  const rows = await selectBudgets(tx, householdId, userId, false);
  if (rows.length === 0) return [];
  const { from, to } = monthBounds(month);
  const groups = await selectExpenseGroups(tx, householdId, from, to);
  return rows.map((r) => statusOf(r, month, groups));
}

async function checkCategory(tx: Tx, householdId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const category = await selectCategory(tx, householdId, categoryId);
  if (!category) throw new NotFoundError();
  if (category.kind !== "expense") {
    throw new ValidationError({ categoryId: "Bugetul se face doar pe categorii de cheltuieli." });
  }
}

export async function listBudgets(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<BudgetView[]> {
  const options = parseInput(budgetListSchema, rawOptions) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) =>
    (await selectBudgets(tx, m.householdId, actor.userId, options.includeArchived ?? false)).map(
      view,
    ),
  );
}

export async function getBudget(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  budgetId: string,
): Promise<BudgetView> {
  if (!isValidId(budgetId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const row = await selectBudget(tx, m.householdId, actor.userId, budgetId.toLowerCase());
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

export async function createBudget(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<BudgetView> {
  const input = parseInput(budgetCreateSchema, rawInput);
  const amountMinor = resolvePositiveAmount(input, input.currency);
  const scope = input.scope ?? "household";
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    await checkCategory(tx, m.householdId, input.categoryId);
    const row = await insertBudget(tx, {
      householdId: m.householdId,
      categoryId: input.categoryId ?? null,
      amountMinor,
      currency: input.currency,
      warnPct: input.warnPct ?? DEFAULT_WARN_PCT,
      scope,
      userId: scope === "personal" ? actor.userId : null,
    });
    return view(row);
  });
}

export async function updateBudget(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  budgetId: string,
  rawPatch: unknown,
): Promise<BudgetView> {
  if (!isValidId(budgetId)) throw new NotFoundError();
  const patch = parseInput(budgetUpdateSchema, rawPatch);
  const id = budgetId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectBudget(tx, m.householdId, actor.userId, id, true);
    if (!current) throw new NotFoundError();
    const amountMinor =
      patch.amountMinor !== undefined || patch.amount !== undefined
        ? resolvePositiveAmount(patch, current.currency)
        : undefined;
    const archivedAt =
      patch.archived === undefined
        ? undefined
        : patch.archived
          ? (current.archivedAt ?? new Date())
          : null;
    const row = await updateBudgetRow(tx, m.householdId, id, {
      amountMinor,
      warnPct: patch.warnPct,
      archivedAt,
    });
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

/** Ștergere definitivă (confirmarea e a API-ului), cu `audit_event` fără sume. */
export async function deleteBudget(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  budgetId: string,
): Promise<void> {
  if (!isValidId(budgetId)) throw new NotFoundError();
  const id = budgetId.toLowerCase();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectBudget(tx, m.householdId, actor.userId, id, true);
    if (!current) throw new NotFoundError();
    if (!(await deleteBudgetRow(tx, m.householdId, id))) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "budget.deleted",
      targetType: "budget",
      targetId: id,
      metadata: { scope: current.scope },
    });
  });
}

/** Starea bugetelor active pentru o lună (implicit luna curentă a gospodăriei). */
export async function getBudgetStatuses(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<BudgetStatus[]> {
  const query = parseInput(budgetStatusQuerySchema, rawQuery) ?? {};
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const month = await resolveMonth(tx, m.householdId, query.month, now);
    return budgetStatusesIn(tx, m.householdId, actor.userId, month);
  });
}

/** „Avertizările în aplicație”: bugetele galbene și roșii ale lunii CURENTE (roșii întâi). */
export async function getBudgetAlerts(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
): Promise<BudgetStatus[]> {
  const all = await getBudgetStatuses(deps, actor, householdId, {});
  const rank = (s: BudgetStatus) => (s.status === "red" ? 0 : 1);
  return all.filter((s) => s.status !== "green").sort((a, b) => rank(a) - rank(b));
}
