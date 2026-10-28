import "server-only";

import type { Tx } from "@/db";
import type { Actor } from "@/lib/authz";
import { type Month, addMonths, daysOfMonth, monthBounds, monthsEndingAt } from "@/lib/calendar";
import { type Currency, add, money, negate, percentOf, sub, sum, zero } from "@/lib/money";
import { type PlanningDeps, resolveMonth } from "@/modules/budgets/budgets.service";
import { selectCategories } from "@/modules/categories/categories.repo";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";

import {
  type CategoryRow,
  type MonthRow,
  selectDailyTotals,
  selectExpenseByCategory,
  selectMonthlyTotals,
  selectOnboardingFlags,
} from "./dashboard.repo";
import {
  type CategorySlice,
  type CurrencyDashboard,
  DEFAULT_TOP_CATEGORIES,
  type DashboardView,
  type Delta,
  EVOLUTION_MONTHS,
  type Onboarding,
  type Totals,
  dashboardQuerySchema,
} from "./dashboard.schema";

/**
 * Dashboard-ul unei luni pentru o gospodărie (Faza 3; ADR 0007). Totul în `bigint` prin
 * `money.ts`, SEPARAT pe monedă (fără conversie); transferurile nu sunt venituri sau cheltuieli.
 * Luna implicită = luna curentă în fusul orar al gospodăriei (ceas injectabil).
 */

const ZERO_TOTALS: Totals = {
  incomeMinor: 0n,
  expenseMinor: 0n,
  netMinor: 0n,
  transactionCount: 0,
};

/** Ordinea monedelor: alfabetic (ca totalurile conturilor). */
export function sortCurrencies(list: Iterable<Currency>): Currency[] {
  return [...new Set(list)].sort((a, b) => a.localeCompare(b));
}

function totalsOf(rows: readonly MonthRow[], currency: Currency, month: Month): Totals {
  const r = rows.find((x) => x.currency === currency && x.month === month);
  if (!r) return ZERO_TOTALS;
  const income = money(BigInt(r.income), currency);
  const expense = money(BigInt(r.expense), currency);
  return {
    incomeMinor: income.amountMinor,
    expenseMinor: expense.amountMinor,
    netMinor: sub(income, expense).amountMinor,
    transactionCount: r.count,
  };
}

/** Diferența absolută și procentul (rotunjit la întreg, 0,5 departe de zero) față de `previous`. */
export function delta(current: bigint, previous: bigint, currency: Currency): Delta {
  const diff = sub(money(current, currency), money(previous, currency)).amountMinor;
  const base = previous < 0n ? negate(money(previous, currency)).amountMinor : previous;
  return { diffMinor: diff, percent: percentOf(diff, base, "half_away") };
}

/**
 * Cheltuielile pe categorii-părinte (subcategoriile agregate la părinte), descrescător; primele
 * `top` rămân, restul se adună într-o felie „Altele” (`isOther`). Cheltuielile fără categorie au
 * felia lor (`categoryId: null`) și concurează la top ca orice categorie.
 */
export function categorySlices(
  rows: readonly CategoryRow[],
  currency: Currency,
  names: ReadonlyMap<string, string>,
  top: number,
): CategorySlice[] {
  const byRoot = new Map<string | null, bigint>();
  for (const r of rows) {
    if (r.currency !== currency) continue;
    const key = r.rootCategoryId;
    byRoot.set(
      key,
      add(money(byRoot.get(key) ?? 0n, currency), money(BigInt(r.total), currency)).amountMinor,
    );
  }
  const total = sum(
    [...byRoot.values()].map((v) => money(v, currency)),
    currency,
  ).amountMinor;
  const sorted = [...byRoot.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] > b[1] ? -1 : 1;
    const na = a[0] === null ? "" : (names.get(a[0]) ?? a[0]);
    const nb = b[0] === null ? "" : (names.get(b[0]) ?? b[0]);
    return na.localeCompare(nb, "ro");
  });
  const slice = (id: string | null, amount: bigint, isOther: boolean): CategorySlice => ({
    categoryId: id,
    name: id === null ? null : (names.get(id) ?? null),
    isOther,
    amountMinor: amount,
    percent: percentOf(amount, total, "half_away") ?? 0,
  });
  const head = sorted.slice(0, top).map(([id, amount]) => slice(id, amount, false));
  const rest = sorted.slice(top);
  if (rest.length > 0) {
    const other = rest.reduce((acc, [, v]) => add(acc, money(v, currency)), zero(currency));
    head.push(slice(null, other.amountMinor, true));
  }
  return head;
}

export async function onboardingOf(tx: Tx, householdId: string): Promise<Onboarding> {
  const flags = await selectOnboardingFlags(tx, householdId);
  // Pasul 1 „adaugă un cont sau importă” e făcut când există date (o tranzacție) — decizia mea:
  // un cont gol nu face dashboard-ul util.
  const steps = [
    { key: "import", done: flags.hasTransaction },
    { key: "budget", done: flags.hasBudget },
    { key: "goal", done: flags.hasGoal },
  ] as const;
  return { ...flags, steps: [...steps], completed: steps.every((s) => s.done) };
}

/** Numele categoriilor vizibile (pentru felii). */
export async function categoryNames(tx: Tx, householdId: string): Promise<Map<string, string>> {
  return new Map((await selectCategories(tx, householdId)).map((c) => [c.id, c.name]));
}

export async function getDashboard(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<DashboardView> {
  const query = parseInput(dashboardQuerySchema, rawQuery) ?? {};
  const top = query.topCategories ?? DEFAULT_TOP_CATEGORIES;
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const month = await resolveMonth(tx, m.householdId, query.month, now);
    const previousMonth = addMonths(month, -1);
    const months = monthsEndingAt(month, EVOLUTION_MONTHS);
    const window = { from: monthBounds(months[0]!).from, to: monthBounds(month).to };
    const { from, to } = monthBounds(month);

    const monthly = await selectMonthlyTotals(tx, m.householdId, window.from, window.to);
    const daily = await selectDailyTotals(tx, m.householdId, from, to);
    const cats = await selectExpenseByCategory(tx, m.householdId, from, to);
    const names = await categoryNames(tx, m.householdId);
    const days = daysOfMonth(month);

    const currencies: CurrencyDashboard[] = sortCurrencies(monthly.map((r) => r.currency)).map(
      (currency) => {
        const totals = totalsOf(monthly, currency, month);
        const previous = totalsOf(monthly, currency, previousMonth);
        const dayMap = new Map(daily.filter((d) => d.currency === currency).map((d) => [d.day, d]));
        return {
          currency,
          totals,
          previous,
          comparison: {
            income: delta(totals.incomeMinor, previous.incomeMinor, currency),
            expense: delta(totals.expenseMinor, previous.expenseMinor, currency),
            net: delta(totals.netMinor, previous.netMinor, currency),
          },
          byCategory: categorySlices(cats, currency, names, top),
          monthly: months.map((mo) => {
            const t = totalsOf(monthly, currency, mo);
            return {
              month: mo,
              incomeMinor: t.incomeMinor,
              expenseMinor: t.expenseMinor,
              netMinor: t.netMinor,
            };
          }),
          daily: days.map((date) => {
            const d = dayMap.get(date);
            return {
              date,
              incomeMinor: d ? BigInt(d.income) : 0n,
              expenseMinor: d ? BigInt(d.expense) : 0n,
            };
          }),
        };
      },
    );
    return { month, previousMonth, currencies, onboarding: await onboardingOf(tx, m.householdId) };
  });
}
