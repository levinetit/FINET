import "server-only";

import type { Actor } from "@/lib/authz";
import { monthBounds } from "@/lib/calendar";
import { type Currency, add, money, percentOf, sub, sum, zero } from "@/lib/money";
import {
  type PlanningDeps,
  budgetStatusesIn,
  resolveMonth,
} from "@/modules/budgets/budgets.service";
import {
  type CategoryRow,
  selectExpenseByCategory,
  selectMonthlyTotals,
  selectTopMerchants,
} from "@/modules/dashboard/dashboard.repo";
import { categoryNames, sortCurrencies } from "@/modules/dashboard/dashboard.service";
import { selectGoals } from "@/modules/goals/goals.repo";
import { goalView } from "@/modules/goals/goals.service";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";

import {
  type MonthlyReport,
  type ReportCategory,
  type ReportCurrency,
  TOP_MERCHANTS,
  monthlyReportQuerySchema,
} from "./reports.schema";

/**
 * Raportul lunar (Faza 3; ADR 0007): totalurile, toate categoriile (cu subcategoriile), cei mai mari
 * comercianți, bugetele (vizibile actorului) vs. cheltuit și obiectivele. Separat pe monedă, fără
 * conversie, transferurile excluse. Aceeași tranzacție SQL pentru tot raportul (date coerente).
 */

function categoriesOf(
  rows: readonly CategoryRow[],
  currency: Currency,
  names: ReadonlyMap<string, string>,
): ReportCategory[] {
  const groups = new Map<string | null, CategoryRow[]>();
  for (const r of rows) {
    if (r.currency !== currency) continue;
    groups.set(r.rootCategoryId, [...(groups.get(r.rootCategoryId) ?? []), r]);
  }
  const total = sum(
    rows.filter((r) => r.currency === currency).map((r) => money(BigInt(r.total), currency)),
    currency,
  ).amountMinor;
  const name = (id: string | null) => (id === null ? null : (names.get(id) ?? null));
  const list = [...groups.entries()].map(([root, items]) => {
    const amount = items.reduce(
      (acc, r) => add(acc, money(BigInt(r.total), currency)),
      zero(currency),
    );
    const children = items
      .map((r) => ({
        categoryId: r.categoryId,
        name: name(r.categoryId),
        amountMinor: BigInt(r.total),
        count: r.count,
      }))
      .sort((a, b) =>
        a.amountMinor === b.amountMinor ? 0 : a.amountMinor > b.amountMinor ? -1 : 1,
      );
    return {
      categoryId: root,
      name: name(root),
      amountMinor: amount.amountMinor,
      count: items.reduce((acc, r) => acc + r.count, 0),
      percent: percentOf(amount.amountMinor, total, "half_away") ?? 0,
      children,
    };
  });
  return list.sort((a, b) => {
    if (a.amountMinor !== b.amountMinor) return a.amountMinor > b.amountMinor ? -1 : 1;
    return (a.name ?? "").localeCompare(b.name ?? "", "ro");
  });
}

export async function getMonthlyReport(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<MonthlyReport> {
  const query = parseInput(monthlyReportQuerySchema, rawQuery) ?? {};
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const month = await resolveMonth(tx, m.householdId, query.month, now);
    const { from, to } = monthBounds(month);
    const totals = await selectMonthlyTotals(tx, m.householdId, from, to);
    const cats = await selectExpenseByCategory(tx, m.householdId, from, to);
    const merchants = await selectTopMerchants(tx, m.householdId, from, to, TOP_MERCHANTS);
    const names = await categoryNames(tx, m.householdId);
    const currencies: ReportCurrency[] = sortCurrencies(totals.map((t) => t.currency)).map(
      (currency) => {
        const r = totals.find((t) => t.currency === currency)!;
        const income = money(BigInt(r.income), currency);
        const expense = money(BigInt(r.expense), currency);
        return {
          currency,
          totals: {
            incomeMinor: income.amountMinor,
            expenseMinor: expense.amountMinor,
            netMinor: sub(income, expense).amountMinor,
            transactionCount: r.count,
          },
          byCategory: categoriesOf(cats, currency, names),
          topMerchants: merchants
            .filter((x) => x.currency === currency)
            .map((x) => ({ merchant: x.merchant, amountMinor: BigInt(x.total), count: x.count })),
        };
      },
    );
    const budgets = await budgetStatusesIn(tx, m.householdId, actor.userId, month);
    const goals = (await selectGoals(tx, m.householdId))
      .filter((g) => g.status !== "abandoned")
      .map(goalView);
    return { month, currencies, budgets, goals };
  });
}
