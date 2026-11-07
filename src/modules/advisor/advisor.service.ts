import "server-only";

import type { Actor } from "@/lib/authz";
import {
  DEFAULT_TIME_ZONE,
  type Month,
  addMonths,
  currentMonth,
  monthBounds,
} from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import {
  type PlanningDeps,
  budgetStatusesIn,
  resolveMonth,
} from "@/modules/budgets/budgets.service";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import { categoryNames, sortCurrencies } from "@/modules/dashboard/dashboard.service";
import { getForecast } from "@/modules/forecast/forecast.service";
import type { Forecast } from "@/modules/forecast/forecast";
import { HEALTH_MONTHS, averageExpense, type HealthScore } from "@/modules/health/health";
import { balancesByCurrency, getHealthScore } from "@/modules/health/health.service";
import { selectMonthlyTotals } from "@/modules/dashboard/dashboard.repo";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";
import { selectRules } from "@/modules/recurring/recurring.repo";

import {
  ADVISOR_LABEL,
  type Advice,
  type CategoryMonth,
  type CategoryStat,
  HISTORY_MONTHS,
  type MerchantStat,
  type MonthExpense,
  findPatterns,
  findUnusual,
  suggest,
} from "./advisor";
import {
  selectCategoryStats,
  selectMerchantStats,
  selectMonthExpenses,
  selectMonthlyByRootCategory,
} from "./advisor.repo";
import { type AdviceView, advisorQuerySchema } from "./advisor.schema";

/**
 * Consilierul financiar al unei luni (ADR 0045), separat pe monedă. Compune scorul de sănătate
 * (pasul D), prognoza (pasul E, doar pentru luna curentă) și analizele deterministe (`advisor.ts`)
 * peste cheltuielile lunii și istoricul ultimelor 6 luni, toate citite sub `withMember` + RLS.
 * Nicio scriere, niciun apel extern.
 */

const EXPENSES_LIMIT = 500;

export async function getAdvice(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown = {},
): Promise<AdviceView> {
  const input = parseInput(advisorQuerySchema, rawInput) ?? {};
  const now = deps.now ?? (() => new Date());

  const data = await inHousehold(deps, actor, householdId, async (tx, m) => {
    const month: Month = await resolveMonth(tx, m.householdId, input.month, now);
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const isCurrent = month === currentMonth(now(), tz);
    const { from, to } = monthBounds(month);
    const histFrom = monthBounds(addMonths(month, -HISTORY_MONTHS)).from;
    const histTo = monthBounds(addMonths(month, -1)).to;
    const healthFrom = monthBounds(addMonths(month, -(HEALTH_MONTHS - 1))).from;
    const [
      expenses,
      merchantStats,
      categoryStats,
      categoryMonths,
      names,
      budgets,
      balances,
      rules,
      totals,
    ] = await Promise.all([
      selectMonthExpenses(tx, m.householdId, from, to, EXPENSES_LIMIT),
      selectMerchantStats(tx, m.householdId, histFrom, histTo),
      selectCategoryStats(tx, m.householdId, histFrom, histTo),
      selectMonthlyByRootCategory(tx, m.householdId, histFrom, to),
      categoryNames(tx, m.householdId),
      budgetStatusesIn(tx, m.householdId, actor.userId, month),
      balancesByCurrency(tx, m.householdId),
      selectRules(tx, m.householdId, "active"),
      selectMonthlyTotals(tx, m.householdId, healthFrom, to),
    ]);
    return {
      month,
      isCurrent,
      expenses,
      merchantStats,
      categoryStats,
      categoryMonths,
      names,
      budgets,
      balances,
      hasRules: rules.length > 0,
      totals,
    };
  });

  const [health, forecast] = await Promise.all([
    getHealthScore(deps, actor, householdId, { month: data.month }),
    data.isCurrent ? getForecast(deps, actor, householdId, {}) : Promise.resolve(null),
  ]);

  const currencies = sortCurrencies([
    ...data.totals.map((r) => r.currency),
    ...data.balances.keys(),
    ...health.currencies.map((h) => h.currency),
  ]);

  const advices: Advice[] = currencies.map((currency) => {
    const monthTotal = data.totals
      .filter((r) => r.currency === currency && r.month === data.month)
      .reduce((acc, r) => acc + BigInt(r.expense), 0n);
    const expenses: MonthExpense[] = data.expenses
      .filter((e) => e.currency === currency)
      .map((e) => ({
        id: e.id,
        occurredOn: e.occurredOn,
        amountMinor: e.amountMinor,
        merchant: e.merchant,
        merchantKey: e.merchantKey,
        rootCategoryId: e.rootCategoryId,
        description: e.description,
        source: e.source,
      }));
    const merchantStats: MerchantStat[] = data.merchantStats
      .filter((s) => s.currency === currency)
      .map((s) => ({
        merchantKey: s.merchantKey,
        merchant: s.merchant,
        count: s.count,
        medianMinor: BigInt(s.median),
      }));
    const categoryStats: CategoryStat[] = data.categoryStats
      .filter((s) => s.currency === currency)
      .map((s) => ({
        rootCategoryId: s.rootCategoryId,
        count: s.count,
        medianMinor: BigInt(s.median),
      }));
    const categoryMonths: CategoryMonth[] = data.categoryMonths
      .filter((c) => c.currency === currency)
      .map((c) => ({
        month: c.month,
        rootCategoryId: c.rootCategoryId,
        totalMinor: BigInt(c.total),
      }));
    const known = new Set(merchantStats.map((s) => s.merchantKey));
    const unusual = findUnusual(
      currency,
      expenses,
      merchantStats,
      categoryStats,
      monthTotal,
      data.names,
    );
    const patterns = findPatterns(
      currency,
      data.month,
      categoryMonths,
      expenses,
      known,
      monthTotal,
      data.names,
    );
    const h: HealthScore | null = health.currencies.find((x) => x.currency === currency) ?? null;
    const f: Forecast | null = forecast?.currencies.find((x) => x.currency === currency) ?? null;
    const months = data.totals
      .filter((r) => r.currency === currency)
      .map((r) => ({
        month: r.month,
        incomeMinor: BigInt(r.income),
        expenseMinor: BigInt(r.expense),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
    const b = data.balances.get(currency) ?? { liquidMinor: 0n, debtMinor: 0n };
    const suggestions = suggest({
      currency,
      health: h,
      forecast: f,
      patterns,
      unusual,
      redBudgets: data.budgets
        .filter((x) => x.currency === currency && x.status === "red")
        .map((x) =>
          x.categoryId ? (data.names.get(x.categoryId) ?? "—") : ro.budgets.generalShort,
        ),
      liquidMinor: b.liquidMinor,
      debtMinor: b.debtMinor,
      averageExpenseMinor: averageExpense(months, 3),
      hasRecurringRules: data.hasRules,
    });
    const lowest = f?.horizons.at(-1) ?? null;
    return {
      currency,
      month: data.month,
      expenseTotalMinor: monthTotal,
      unusual,
      patterns,
      suggestions,
      health: h ? { score: h.score, band: h.band } : null,
      forecast: lowest
        ? { days: lowest.days, lowestMinor: lowest.lowestMinor, lowestOn: lowest.lowestOn }
        : null,
      label: ADVISOR_LABEL,
    };
  });
  return { month: data.month, currencies: advices };
}

export type { Currency };
