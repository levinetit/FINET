import { z } from "zod";

import { type Currency, money, toJson } from "@/lib/money";
import { monthSchema } from "@/modules/budgets/budgets.schema";

/** Dashboard-ul lunar (Faza 3, master prompt 7 → Faza 3). */

export const DEFAULT_TOP_CATEGORIES = 5;
export const MAX_TOP_CATEGORIES = 20;
/** Lunile din evoluția lunară (inclusiv luna aleasă). */
export const EVOLUTION_MONTHS = 12;

export const dashboardQuerySchema = z
  .strictObject({
    month: monthSchema.optional(),
    topCategories: z.number().int().min(1).max(MAX_TOP_CATEGORIES).optional(),
  })
  .optional();

export type Totals = Readonly<{
  incomeMinor: bigint;
  expenseMinor: bigint;
  /** venituri − cheltuieli (poate fi negativ). */
  netMinor: bigint;
  /** Venituri + cheltuieli (transferurile nu se numără). */
  transactionCount: number;
}>;

/** Diferența față de luna anterioară; `percent` e `null` dacă luna anterioară are 0. */
export type Delta = Readonly<{ diffMinor: bigint; percent: number | null }>;

export type CategorySlice = Readonly<{
  /** Categoria-părinte; `null` cu `isOther: false` = fără categorie; `isOther: true` = „Altele”. */
  categoryId: string | null;
  name: string | null;
  isOther: boolean;
  amountMinor: bigint;
  /** Procentul din totalul cheltuielilor (rotunjit, informativ: suma procentelor poate fi ≠ 100). */
  percent: number;
}>;

export type MonthPoint = Readonly<{
  month: string;
  incomeMinor: bigint;
  expenseMinor: bigint;
  netMinor: bigint;
}>;
export type DayPoint = Readonly<{ date: string; incomeMinor: bigint; expenseMinor: bigint }>;

export type CurrencyDashboard = Readonly<{
  currency: Currency;
  totals: Totals;
  previous: Totals;
  comparison: Readonly<{ income: Delta; expense: Delta; net: Delta }>;
  byCategory: CategorySlice[];
  monthly: MonthPoint[];
  daily: DayPoint[];
}>;

export type OnboardingStep = Readonly<{ key: "import" | "budget" | "goal"; done: boolean }>;

export type Onboarding = Readonly<{
  hasAccount: boolean;
  hasTransaction: boolean;
  hasBudget: boolean;
  hasGoal: boolean;
  steps: OnboardingStep[];
  completed: boolean;
}>;

export type DashboardView = Readonly<{
  month: string;
  previousMonth: string;
  /** Câte o intrare pe monedă cu venituri/cheltuieli în ultimele 12 luni (fără conversie). */
  currencies: CurrencyDashboard[];
  onboarding: Onboarding;
}>;

// ---------------------------------------------------------------------------------------------
// JSON (6.4): sumele ca întregi prin `toJson` (peste 2^53 − 1 → MoneyOverflowError → 422).
// ---------------------------------------------------------------------------------------------

const j = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;

function totalsJson(t: Totals, c: Currency) {
  return {
    incomeMinor: j(t.incomeMinor, c),
    expenseMinor: j(t.expenseMinor, c),
    netMinor: j(t.netMinor, c),
    transactionCount: t.transactionCount,
  };
}
const deltaJson = (d: Delta, c: Currency) => ({ diffMinor: j(d.diffMinor, c), percent: d.percent });

export function dashboardToJson(d: DashboardView) {
  return {
    month: d.month,
    previousMonth: d.previousMonth,
    onboarding: d.onboarding,
    currencies: d.currencies.map((x) => ({
      currency: x.currency,
      totals: totalsJson(x.totals, x.currency),
      previous: totalsJson(x.previous, x.currency),
      comparison: {
        income: deltaJson(x.comparison.income, x.currency),
        expense: deltaJson(x.comparison.expense, x.currency),
        net: deltaJson(x.comparison.net, x.currency),
      },
      byCategory: x.byCategory.map((s) => ({ ...s, amountMinor: j(s.amountMinor, x.currency) })),
      monthly: x.monthly.map((p) => ({
        month: p.month,
        incomeMinor: j(p.incomeMinor, x.currency),
        expenseMinor: j(p.expenseMinor, x.currency),
        netMinor: j(p.netMinor, x.currency),
      })),
      daily: x.daily.map((p) => ({
        date: p.date,
        incomeMinor: j(p.incomeMinor, x.currency),
        expenseMinor: j(p.expenseMinor, x.currency),
      })),
    })),
  };
}
