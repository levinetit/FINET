import type { Month } from "@/lib/calendar";
import { type Currency, formatMoney, money } from "@/lib/money";
import { ro } from "@/messages/ro";
import type { Forecast } from "@/modules/forecast/forecast";
import { type HealthScore, divRound, formatBp } from "@/modules/health/health";

/**
 * Consilierul financiar (modernizare 2026, pasul F; ADR 0045): analize DETERMINISTE, în întregi,
 * peste cheltuielile lunii și istoricul ultimelor 6 luni. Fără AI: fiecare constatare are cifrele
 * din date și regula care a produs-o. Textele sunt în `ro.advisor`; aici se completează doar
 * valorile. Nicio recomandare nu execută nimic: sunt propuneri explicate, etichetate „nu e sfat
 * financiar”.
 *
 * - **Tranzacții neobișnuite:** o cheltuială a lunii față de mediana cheltuielilor anterioare la
 *   același comerciant (minimum 3) sau, altfel, din aceeași categorie-părinte (minimum 5): raport
 *   ≥ 2× și cel puțin 1 % din cheltuielile lunii. Cele generate de reguli recurente sunt excluse
 *   (sunt așteptate).
 * - **Tipare:** categorii cu luna ≥ +25 % / ≤ −25 % față de media lunilor anterioare cu date
 *   (minimum 2) și cu pondere ≥ 2 % din lună; comercianți noi cu ≥ 2 cheltuieli; concentrarea
 *   (un comerciant ≥ 30 % din lună).
 * - **Sugestii:** derivate din scor, prognoză, bugete și tipare, cu suma calculată unde există
 *   (fond de urgență, reducerea unei categorii cu 10 %, cardul de credit), ordonate pe prioritate.
 */

export const HISTORY_MONTHS = 6;
export const UNUSUAL_LIMIT = 10;
export const PATTERNS_LIMIT = 8;
export const UNUSUAL_RATIO_BP = 20_000n;
export const UNUSUAL_MIN_SHARE_BP = 100n;
export const MIN_MERCHANT_HISTORY = 3;
export const MIN_CATEGORY_HISTORY = 5;
export const PATTERN_CHANGE_BP = 2500;
export const PATTERN_MIN_SHARE_BP = 200n;
export const NEW_MERCHANT_MIN_COUNT = 2;
export const CONCENTRATION_BP = 3000;
export const EMERGENCY_TARGET_MONTHS = 3n;

export const ADVISOR_LABEL = ro.advisor.label;

const BP = 10_000n;

export type MonthExpense = Readonly<{
  id: string;
  occurredOn: string;
  amountMinor: bigint;
  merchant: string | null;
  merchantKey: string | null;
  rootCategoryId: string | null;
  description: string | null;
  source: string;
}>;

export type MerchantStat = Readonly<{
  merchantKey: string;
  merchant: string;
  count: number;
  medianMinor: bigint;
}>;

export type CategoryStat = Readonly<{
  rootCategoryId: string | null;
  count: number;
  medianMinor: bigint;
}>;

export type CategoryMonth = Readonly<{
  month: Month;
  rootCategoryId: string | null;
  totalMinor: bigint;
}>;

export type UnusualTransaction = Readonly<{
  transactionId: string;
  occurredOn: string;
  merchant: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  amountMinor: bigint;
  /** Mediana față de care s-a comparat și baza ei. */
  baselineMinor: bigint;
  basis: "merchant" | "category";
  /** `amount / baseline` în puncte de bază (20.000 = de două ori). */
  ratioBp: number;
  explanation: string;
}>;

export type PatternCode =
  "category_up" | "category_down" | "new_merchant" | "merchant_concentration";

export type Pattern = Readonly<{
  code: PatternCode;
  categoryId: string | null;
  categoryName: string | null;
  merchant: string | null;
  currentMinor: bigint;
  baselineMinor: bigint | null;
  /** Variația față de bază sau ponderea din lună, în puncte de bază. */
  changeBp: number | null;
  explanation: string;
}>;

export type SuggestionCode =
  | "overdraft_ahead"
  | "pay_down_card"
  | "review_budgets"
  | "emergency_fund"
  | "trim_category"
  | "check_unusual"
  | "automate_recurring"
  | "keep_going";

export type Suggestion = Readonly<{
  code: SuggestionCode;
  priority: "high" | "medium" | "low";
  title: string;
  text: string;
  amountMinor: bigint | null;
}>;

export type Advice = Readonly<{
  currency: Currency;
  month: Month;
  expenseTotalMinor: bigint;
  unusual: readonly UnusualTransaction[];
  patterns: readonly Pattern[];
  suggestions: readonly Suggestion[];
  health: Readonly<{ score: number | null; band: HealthScore["band"] }> | null;
  forecast: Readonly<{ days: number; lowestMinor: bigint; lowestOn: string }> | null;
  label: string;
}>;

const fmt = (minor: bigint, c: Currency) => formatMoney(money(minor, c));
const tpl = (text: string, vars: Readonly<Record<string, string>>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
const ratioText = (bp: number) => {
  const n = new Intl.NumberFormat("ro-RO", { maximumFractionDigits: 1 });
  return `${n.format(bp / 10_000)}×`;
};

export function findUnusual(
  currency: Currency,
  expenses: readonly MonthExpense[],
  merchantStats: readonly MerchantStat[],
  categoryStats: readonly CategoryStat[],
  monthTotal: bigint,
  names: ReadonlyMap<string, string>,
): UnusualTransaction[] {
  const t = ro.advisor.unusual;
  if (monthTotal <= 0n) return [];
  const byMerchant = new Map(merchantStats.map((m) => [m.merchantKey, m]));
  const byCategory = new Map(categoryStats.map((c) => [c.rootCategoryId, c]));
  const minAmount = divRound(monthTotal * UNUSUAL_MIN_SHARE_BP, BP);
  const out: UnusualTransaction[] = [];
  for (const e of expenses) {
    if (e.source === "recurring" || e.amountMinor < minAmount) continue;
    let basis: "merchant" | "category" | null = null;
    let baseline = 0n;
    const m = e.merchantKey ? byMerchant.get(e.merchantKey) : undefined;
    if (m && m.count >= MIN_MERCHANT_HISTORY && m.medianMinor > 0n) {
      basis = "merchant";
      baseline = m.medianMinor;
    } else {
      const c = byCategory.get(e.rootCategoryId);
      if (c && c.count >= MIN_CATEGORY_HISTORY && c.medianMinor > 0n) {
        basis = "category";
        baseline = c.medianMinor;
      }
    }
    if (basis === null) continue;
    const ratio = divRound(e.amountMinor * BP, baseline);
    if (ratio < UNUSUAL_RATIO_BP) continue;
    const categoryName = e.rootCategoryId ? (names.get(e.rootCategoryId) ?? null) : null;
    const vars = {
      amount: fmt(e.amountMinor, currency),
      baseline: fmt(baseline, currency),
      ratio: ratioText(Number(ratio)),
      merchant: e.merchant ?? "",
      category: categoryName ?? t.uncategorized,
    };
    out.push({
      transactionId: e.id,
      occurredOn: e.occurredOn,
      merchant: e.merchant,
      description: e.description,
      categoryId: e.rootCategoryId,
      categoryName,
      amountMinor: e.amountMinor,
      baselineMinor: baseline,
      basis,
      ratioBp: Number(ratio),
      explanation: tpl(basis === "merchant" ? t.byMerchant : t.byCategory, vars),
    });
  }
  return out
    .sort((a, b) => b.ratioBp - a.ratioBp || a.occurredOn.localeCompare(b.occurredOn))
    .slice(0, UNUSUAL_LIMIT);
}

export function findPatterns(
  currency: Currency,
  month: Month,
  categoryMonths: readonly CategoryMonth[],
  expenses: readonly MonthExpense[],
  knownMerchantKeys: ReadonlySet<string>,
  monthTotal: bigint,
  names: ReadonlyMap<string, string>,
): Pattern[] {
  const t = ro.advisor.patterns;
  const out: Pattern[] = [];
  if (monthTotal <= 0n) return out;
  const minShare = divRound(monthTotal * PATTERN_MIN_SHARE_BP, BP);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);
  const label = (id: string | null) => nameOf(id) ?? t.uncategorized;

  // Categorii în creștere / scădere față de media lunilor anterioare cu date.
  const roots = new Set(categoryMonths.map((c) => c.rootCategoryId));
  for (const id of roots) {
    const current = categoryMonths.find((c) => c.month === month && c.rootCategoryId === id);
    const previous = categoryMonths.filter(
      (c) => c.month !== month && c.rootCategoryId === id && c.totalMinor > 0n,
    );
    if (previous.length < 2) continue;
    const baseline = divRound(
      previous.reduce((a, c) => a + c.totalMinor, 0n),
      BigInt(previous.length),
    );
    if (baseline <= 0n) continue;
    const cur = current?.totalMinor ?? 0n;
    const change = Number(divRound((cur - baseline) * BP, baseline));
    const vars = {
      category: label(id),
      current: fmt(cur, currency),
      baseline: fmt(baseline, currency),
      change: formatBp(Math.abs(change)),
      months: String(previous.length),
    };
    if (change >= PATTERN_CHANGE_BP && cur >= minShare) {
      out.push({
        code: "category_up",
        categoryId: id,
        categoryName: nameOf(id),
        merchant: null,
        currentMinor: cur,
        baselineMinor: baseline,
        changeBp: change,
        explanation: tpl(t.category_up, vars),
      });
    } else if (change <= -PATTERN_CHANGE_BP && baseline >= minShare) {
      out.push({
        code: "category_down",
        categoryId: id,
        categoryName: nameOf(id),
        merchant: null,
        currentMinor: cur,
        baselineMinor: baseline,
        changeBp: change,
        explanation: tpl(t.category_down, vars),
      });
    }
  }

  // Comercianții lunii: noi (≥ 2 cheltuieli, nevăzuți înainte) și concentrarea.
  const byMerchant = new Map<string, { merchant: string; count: number; total: bigint }>();
  for (const e of expenses) {
    if (!e.merchantKey) continue;
    const acc = byMerchant.get(e.merchantKey) ?? {
      merchant: e.merchant ?? "",
      count: 0,
      total: 0n,
    };
    acc.count += 1;
    acc.total += e.amountMinor;
    byMerchant.set(e.merchantKey, acc);
  }
  for (const [key, m] of byMerchant) {
    if (m.count < NEW_MERCHANT_MIN_COUNT || knownMerchantKeys.has(key)) continue;
    out.push({
      code: "new_merchant",
      categoryId: null,
      categoryName: null,
      merchant: m.merchant,
      currentMinor: m.total,
      baselineMinor: null,
      changeBp: null,
      explanation: tpl(t.new_merchant, {
        merchant: m.merchant,
        count: String(m.count),
        total: fmt(m.total, currency),
      }),
    });
  }
  let top: { merchant: string; total: bigint } | null = null;
  for (const m of byMerchant.values()) if (!top || m.total > top.total) top = m;
  if (top) {
    const share = Number(divRound(top.total * BP, monthTotal));
    if (share >= CONCENTRATION_BP) {
      out.push({
        code: "merchant_concentration",
        categoryId: null,
        categoryName: null,
        merchant: top.merchant,
        currentMinor: top.total,
        baselineMinor: null,
        changeBp: share,
        explanation: tpl(t.merchant_concentration, {
          merchant: top.merchant,
          share: formatBp(share),
          total: fmt(top.total, currency),
        }),
      });
    }
  }
  const order: Record<PatternCode, number> = {
    category_up: 0,
    merchant_concentration: 1,
    new_merchant: 2,
    category_down: 3,
  };
  return out
    .sort(
      (a, b) =>
        order[a.code] - order[b.code] ||
        (b.currentMinor > a.currentMinor ? 1 : b.currentMinor < a.currentMinor ? -1 : 0),
    )
    .slice(0, PATTERNS_LIMIT);
}

export type SuggestionContext = Readonly<{
  currency: Currency;
  health: HealthScore | null;
  forecast: Forecast | null;
  patterns: readonly Pattern[];
  unusual: readonly UnusualTransaction[];
  redBudgets: readonly string[];
  /** Soldul lichid și datoria pe termen scurt (ca la scor). */
  liquidMinor: bigint;
  debtMinor: bigint;
  /** Cheltuiala lunară medie (ultimele 3 luni cu cheltuieli), `null` fără date. */
  averageExpenseMinor: bigint | null;
  hasRecurringRules: boolean;
}>;

export function suggest(ctx: SuggestionContext): Suggestion[] {
  const t = ro.advisor.suggestions;
  const c = ctx.currency;
  const out: Suggestion[] = [];
  const push = (
    code: SuggestionCode,
    priority: Suggestion["priority"],
    vars: Readonly<Record<string, string>> = {},
    amountMinor: bigint | null = null,
  ) =>
    out.push({ code, priority, title: t[code].title, text: tpl(t[code].text, vars), amountMinor });

  const lowest = ctx.forecast?.horizons.find((h) => h.lowestMinor < 0n);
  if (lowest) {
    push(
      "overdraft_ahead",
      "high",
      { amount: fmt(-lowest.lowestMinor, c), date: lowest.lowestOn, days: String(lowest.days) },
      -lowest.lowestMinor,
    );
  }
  if (ctx.debtMinor > 0n) {
    push("pay_down_card", "high", { amount: fmt(ctx.debtMinor, c) }, ctx.debtMinor);
  }
  if (ctx.redBudgets.length > 0) {
    push("review_budgets", "high", { budgets: ctx.redBudgets.join(", ") });
  }
  if (ctx.averageExpenseMinor !== null && ctx.averageExpenseMinor > 0n) {
    const target = ctx.averageExpenseMinor * EMERGENCY_TARGET_MONTHS;
    const liquid = ctx.liquidMinor < 0n ? 0n : ctx.liquidMinor;
    if (liquid < target) {
      const monthly = divRound(target - liquid, 12n);
      push(
        "emergency_fund",
        "medium",
        {
          target: fmt(target, c),
          liquid: fmt(liquid, c),
          monthly: fmt(monthly, c),
          months: String(EMERGENCY_TARGET_MONTHS),
        },
        monthly,
      );
    }
  }
  const savings = ctx.health?.components.find((x) => x.key === "savings_rate");
  const up = ctx.patterns.find((p) => p.code === "category_up");
  if (up && savings && savings.value !== null && savings.value < 1000) {
    const trim = divRound(up.currentMinor, 10n);
    push(
      "trim_category",
      "medium",
      {
        category: up.categoryName ?? ro.advisor.patterns.uncategorized,
        current: fmt(up.currentMinor, c),
        trim: fmt(trim, c),
      },
      trim,
    );
  }
  if (ctx.unusual.length > 0) {
    push("check_unusual", "low", { count: String(ctx.unusual.length) });
  }
  if (!ctx.hasRecurringRules) {
    push("automate_recurring", "low");
  }
  if (out.length === 0) push("keep_going", "low");
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}
