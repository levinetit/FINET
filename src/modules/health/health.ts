import type { Month } from "@/lib/calendar";
import { type Currency, MAX_PERCENT, formatMoney, money, percentOf } from "@/lib/money";
import { ro } from "@/messages/ro";

/**
 * Scorul de sănătate financiară (modernizare 2026, pasul D; ADR 0045): funcții PURE, deterministe,
 * în întregi (`bigint` pe sume, puncte de bază pe rapoarte), fără AI și fără bază de date.
 *
 * Scorul (0–100) e media ponderată a componentelor disponibile; o componentă fără date (de
 * exemplu fără bugete) e `null` și nu intră în medie (ponderile celorlalte se redistribuie).
 * Fiecare componentă are valoarea măsurată, o explicație și pragurile folosite, ca utilizatorul
 * să vadă DE CE are scorul respectiv. NU e un scor de credit și nu e sfat financiar (eticheta
 * `HEALTH_LABEL` însoțește orice afișare).
 *
 * Componentele și pragurile (decizia mea, documentate în ADR 0045):
 * - `savings_rate` (25): (venit − cheltuieli) / venit în lună; ≥ 20 % → 100, 0 % → 40, ≤ −20 % → 0;
 * - `cash_flow` (15): lunile cu venit ≥ cheltuieli din ultimele 6 cu activitate, în procente;
 * - `emergency_fund` (20): soldul lichid (cash, bancă, economii) / cheltuiala lunară medie
 *   (ultimele 3 luni cu cheltuieli); 6 luni → 100, 0 → 0, liniar;
 * - `spending_stability` (15): abaterea absolută medie a cheltuielilor lunare față de medie
 *   (ultimele 6 luni, minimum 3), în puncte de bază; ≤ 10 % → 100, 50 % → 20, ≥ 60 % → 0;
 * - `budget_adherence` (10): bugetele lunii: verde = 1, galben = 1/2, roșu = 0;
 * - `debt` (15): datoria pe carduri de credit și descoperiri de cont / venitul lunar (sau venitul
 *   mediu al ultimelor luni); 0 → 100, ≥ 50 % → 0, liniar.
 */

export const HEALTH_LABEL = ro.health.label;

export const HEALTH_MONTHS = 6;
export const EMERGENCY_MONTHS_FULL = 6;
export const EMERGENCY_AVG_MONTHS = 3;

export type HealthComponentKey =
  | "savings_rate"
  | "cash_flow"
  | "emergency_fund"
  | "spending_stability"
  | "budget_adherence"
  | "debt";

export const HEALTH_WEIGHTS: Readonly<Record<HealthComponentKey, number>> = Object.freeze({
  savings_rate: 25,
  cash_flow: 15,
  emergency_fund: 20,
  spending_stability: 15,
  budget_adherence: 10,
  debt: 15,
});

export type HealthBand = "good" | "ok" | "watch" | "fragile";
export type ComponentStatus = "good" | "ok" | "weak" | "none";

/** Unitatea valorii măsurate: puncte de bază (1/100 %), procente, sutimi de lună. */
export type MetricUnit = "bp" | "percent" | "months_x100";

export type HealthMonth = Readonly<{ month: Month; incomeMinor: bigint; expenseMinor: bigint }>;

export type HealthInputs = Readonly<{
  currency: Currency;
  month: Month;
  /** Ultimele `HEALTH_MONTHS` luni (inclusiv `month`), cronologic; lunile fără date au 0. */
  months: readonly HealthMonth[];
  /** Soldurile pozitive ale conturilor lichide active (cash, bancă, economii). */
  liquidMinor: bigint;
  /** Datoria: soldurile negative (carduri de credit, descoperiri), ca valoare pozitivă. */
  debtMinor: bigint;
  budgets: readonly Readonly<{ status: "green" | "yellow" | "red" }>[];
}>;

export type HealthComponent = Readonly<{
  key: HealthComponentKey;
  weight: number;
  /** 0–100 sau `null` când nu există date (nu intră în medie). */
  score: number | null;
  status: ComponentStatus;
  /** Valoarea măsurată (întreg) în `unit`, sau `null` fără date. */
  value: number | null;
  unit: MetricUnit;
  /** Valoarea formatată pentru afișare (ex. „12,5 %”, „2,4 luni”). */
  display: string;
  /** De ce are acest scor și ce ar schimba-l (text în română, cifrele din date). */
  explanation: string;
}>;

export type HealthScore = Readonly<{
  currency: Currency;
  month: Month;
  /** 0–100; `null` dacă nicio componentă nu are date. */
  score: number | null;
  band: HealthBand | null;
  components: readonly HealthComponent[];
  /** Eticheta obligatorie: nu e scor de credit, nu e sfat financiar. */
  label: string;
}>;

const BP = 10_000n;

const clamp = (n: bigint, lo: bigint, hi: bigint): bigint => (n < lo ? lo : n > hi ? hi : n);
const toScore = (n: bigint): number => Number(clamp(n, 0n, 100n));

/** Împărțire cu rotunjire la cel mai apropiat întreg (jumătățile departe de zero), pe bigint. */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError("împărțire la zero");
  const negative = num < 0n !== den < 0n && num !== 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  let q = a / b;
  if ((a % b) * 2n >= b) q += 1n;
  return negative ? -q : q;
}

const nf1 = new Intl.NumberFormat("ro-RO", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Puncte de bază → „12,5 %”. */
export function formatBp(bp: number): string {
  return `${nf1.format(bp / 100)} %`;
}
/** Sutimi de lună → „2,4 luni”. */
export function formatMonthsX100(v: number): string {
  const n = v / 100;
  return `${nf1.format(n)} ${n === 1 ? ro.health.monthOne : ro.health.monthMany}`;
}

export function bandOf(score: number): HealthBand {
  if (score >= 80) return "good";
  if (score >= 60) return "ok";
  if (score >= 40) return "watch";
  return "fragile";
}

export function statusOf(score: number | null): ComponentStatus {
  if (score === null) return "none";
  if (score >= 70) return "good";
  if (score >= 40) return "ok";
  return "weak";
}

const fmt = (minor: bigint, currency: Currency) => formatMoney(money(minor, currency));
const tpl = (text: string, vars: Readonly<Record<string, string>>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

function component(
  key: HealthComponentKey,
  score: number | null,
  value: number | null,
  unit: MetricUnit,
  display: string,
  explanation: string,
): HealthComponent {
  return {
    key,
    weight: HEALTH_WEIGHTS[key],
    score,
    status: statusOf(score),
    value,
    unit,
    display,
    explanation,
  };
}

/** Rata de economisire a lunii: (venit − cheltuieli) / venit, în puncte de bază. */
export function savingsRate(input: HealthInputs): HealthComponent {
  const t = ro.health.components.savings_rate;
  const m = input.months.find((x) => x.month === input.month);
  const income = m?.incomeMinor ?? 0n;
  const expense = m?.expenseMinor ?? 0n;
  if (income <= 0n) {
    return component("savings_rate", null, null, "bp", "—", t.noIncome);
  }
  const net = income - expense;
  const bp = clamp(divRound(net * BP, income), -BP * 10n, BP);
  // ≥ 20 % → 100; 0 → 40; ≤ −20 % → 0 (liniar pe fiecare ramură).
  const score = bp >= 0n ? toScore(40n + (bp * 60n) / 2000n) : toScore(40n + (bp * 40n) / 2000n);
  const c = input.currency;
  const explanation = tpl(net >= 0n ? t.saved : t.overspent, {
    net: fmt(net < 0n ? -net : net, c),
    income: fmt(income, c),
    rate: formatBp(Number(bp)),
  });
  return component("savings_rate", score, Number(bp), "bp", formatBp(Number(bp)), explanation);
}

/** Lunile cu venit ≥ cheltuieli dintre cele cu activitate, în procente. */
export function cashFlowConsistency(input: HealthInputs): HealthComponent {
  const t = ro.health.components.cash_flow;
  const active = input.months.filter((m) => m.incomeMinor > 0n || m.expenseMinor > 0n);
  if (active.length === 0) {
    return component("cash_flow", null, null, "percent", "—", t.noData);
  }
  const positive = active.filter((m) => m.incomeMinor >= m.expenseMinor).length;
  const pct = Number(divRound(BigInt(positive) * 100n, BigInt(active.length)));
  const explanation = tpl(t.text, { positive: String(positive), total: String(active.length) });
  return component("cash_flow", pct, pct, "percent", `${positive}/${active.length}`, explanation);
}

/** Cheltuiala lunară medie a ultimelor luni cu cheltuieli (cel mult `count`). */
export function averageExpense(months: readonly HealthMonth[], count: number): bigint | null {
  const withExpense = months.filter((m) => m.expenseMinor > 0n).slice(-count);
  if (withExpense.length === 0) return null;
  const total = withExpense.reduce((acc, m) => acc + m.expenseMinor, 0n);
  return divRound(total, BigInt(withExpense.length));
}

/** Acoperirea fondului de urgență: sold lichid / cheltuiala lunară medie, în sutimi de lună. */
export function emergencyFund(input: HealthInputs): HealthComponent {
  const t = ro.health.components.emergency_fund;
  const avg = averageExpense(input.months, EMERGENCY_AVG_MONTHS);
  if (avg === null) {
    return component("emergency_fund", null, null, "months_x100", "—", t.noExpenses);
  }
  const liquid = input.liquidMinor < 0n ? 0n : input.liquidMinor;
  const monthsX100 = clamp(divRound(liquid * 100n, avg), 0n, 100_000n);
  const score = toScore(divRound(monthsX100 * 100n, BigInt(EMERGENCY_MONTHS_FULL * 100)));
  const c = input.currency;
  const explanation = tpl(t.text, {
    liquid: fmt(liquid, c),
    avg: fmt(avg, c),
    months: formatMonthsX100(Number(monthsX100)),
    target: String(EMERGENCY_MONTHS_FULL),
  });
  return component(
    "emergency_fund",
    score,
    Number(monthsX100),
    "months_x100",
    formatMonthsX100(Number(monthsX100)),
    explanation,
  );
}

/** Variația cheltuielilor: abaterea absolută medie față de medie, în puncte de bază. */
export function spendingStability(input: HealthInputs): HealthComponent {
  const t = ro.health.components.spending_stability;
  const withExpense = input.months.filter((m) => m.expenseMinor > 0n);
  if (withExpense.length < 3) {
    return component("spending_stability", null, null, "bp", "—", t.notEnough);
  }
  const n = BigInt(withExpense.length);
  const mean = divRound(
    withExpense.reduce((acc, m) => acc + m.expenseMinor, 0n),
    n,
  );
  const mad = divRound(
    withExpense.reduce((acc, m) => {
      const d = m.expenseMinor - mean;
      return acc + (d < 0n ? -d : d);
    }, 0n),
    n,
  );
  const bp = mean === 0n ? 0n : clamp(divRound(mad * BP, mean), 0n, BP * 10n);
  // ≤ 10 % → 100; 50 % → 20; ≥ 60 % → 0.
  const score = toScore(120n - bp / 50n);
  const explanation = tpl(t.text, {
    mean: fmt(mean, input.currency),
    deviation: formatBp(Number(bp)),
    count: String(withExpense.length),
  });
  return component(
    "spending_stability",
    score,
    Number(bp),
    "bp",
    formatBp(Number(bp)),
    explanation,
  );
}

/** Aderența la bugete: verde = 1, galben = 1/2, roșu = 0; procente. */
export function budgetAdherence(input: HealthInputs): HealthComponent {
  const t = ro.health.components.budget_adherence;
  const total = input.budgets.length;
  if (total === 0) {
    return component("budget_adherence", null, null, "percent", "—", t.noBudgets);
  }
  const green = input.budgets.filter((b) => b.status === "green").length;
  const yellow = input.budgets.filter((b) => b.status === "yellow").length;
  const red = total - green - yellow;
  const pct = Number(divRound(BigInt(green * 2 + yellow) * 100n, BigInt(total * 2)));
  const explanation = tpl(t.text, {
    green: String(green),
    yellow: String(yellow),
    red: String(red),
    total: String(total),
  });
  return component("budget_adherence", pct, pct, "percent", `${pct} %`, explanation);
}

/** Datoria pe termen scurt față de venitul lunar, în puncte de bază. */
export function debtRatio(input: HealthInputs): HealthComponent {
  const t = ro.health.components.debt;
  const debt = input.debtMinor < 0n ? 0n : input.debtMinor;
  const c = input.currency;
  if (debt === 0n) {
    return component("debt", 100, 0, "bp", formatBp(0), t.none);
  }
  const current = input.months.find((x) => x.month === input.month);
  let income = current?.incomeMinor ?? 0n;
  if (income <= 0n) {
    const withIncome = input.months.filter((m) => m.incomeMinor > 0n);
    income =
      withIncome.length === 0
        ? 0n
        : divRound(
            withIncome.reduce((acc, m) => acc + m.incomeMinor, 0n),
            BigInt(withIncome.length),
          );
  }
  if (income <= 0n) {
    return component("debt", 0, null, "bp", "—", tpl(t.noIncome, { debt: fmt(debt, c) }));
  }
  const bp = clamp(divRound(debt * BP, income), 0n, BP * 100n);
  // 0 → 100; ≥ 50 % → 0, liniar.
  const score = toScore(100n - bp / 50n);
  const explanation = tpl(t.text, {
    debt: fmt(debt, c),
    income: fmt(income, c),
    ratio: formatBp(Number(bp)),
  });
  return component("debt", score, Number(bp), "bp", formatBp(Number(bp)), explanation);
}

/** Media ponderată a componentelor cu date; `null` fără nicio componentă. */
export function weightedScore(components: readonly HealthComponent[]): number | null {
  let num = 0n;
  let den = 0n;
  for (const c of components) {
    if (c.score === null) continue;
    num += BigInt(c.score) * BigInt(c.weight);
    den += BigInt(c.weight);
  }
  if (den === 0n) return null;
  return toScore(divRound(num, den));
}

export function computeHealth(input: HealthInputs): HealthScore {
  if (input.months.length === 0 || input.months.length > HEALTH_MONTHS) {
    throw new RangeError(`months trebuie să aibă 1–${HEALTH_MONTHS} luni`);
  }
  const components: HealthComponent[] = [
    savingsRate(input),
    cashFlowConsistency(input),
    emergencyFund(input),
    spendingStability(input),
    budgetAdherence(input),
    debtRatio(input),
  ];
  const score = weightedScore(components);
  return {
    currency: input.currency,
    month: input.month,
    score,
    band: score === null ? null : bandOf(score),
    components,
    label: HEALTH_LABEL,
  };
}

/** Procentul unei componente din totalul posibil (pentru bare), cu plafonul `MAX_PERCENT`. */
export function scorePercent(score: number | null): number {
  if (score === null) return 0;
  return Math.min(MAX_PERCENT, Math.max(0, percentOf(BigInt(score), 100n, "floor") ?? 0));
}
