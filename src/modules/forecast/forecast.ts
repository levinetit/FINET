import {
  type CalendarDate,
  type Month,
  type RecurrenceSpec,
  addDays,
  daysInMonth,
  occurrenceAfter,
  occurrenceOnOrAfter,
} from "@/lib/calendar";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import { divRound } from "@/modules/health/health";

/**
 * Prognoza de cash-flow la 30/60/90 de zile (modernizare 2026, pasul E; ADR 0045): funcții PURE,
 * deterministe, în `bigint`, fără AI. Soldul proiectat pe zile pornește de la soldul de azi și
 * adună:
 * - scadențele regulilor recurente active (`calendar.ts`, aceeași grilă ca workerul), cu suma și
 *   descrierea lor („plăți viitoare”);
 * - o linie de bază: media zilnică a veniturilor și cheltuielilor NErecurente din ultimele luni
 *   cu activitate (cel mult `HISTORY_MONTHS`), ca să nu se numere de două ori ce generează regulile.
 * Indicatorul de încredere (0–100, `high|medium|low`) spune cât de mult se poate conta pe cifre:
 * cât istoric există, cât de stabile sunt cheltuielile, cât din ele e acoperit de reguli și cât de
 * lung e orizontul. Prognoza e o ESTIMARE și e etichetată ca atare (`FORECAST_LABEL`).
 */

export const FORECAST_HORIZONS = [30, 60, 90] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];
export const DEFAULT_HORIZON: ForecastHorizon = 90;
export const HISTORY_MONTHS = 3;
export const UPCOMING_LIMIT = 30;
/** Plafon de siguranță pe regulă (o regulă zilnică are cel mult 90 de scadențe în 90 de zile). */
const MAX_EVENTS_PER_RULE = 400;

export const FORECAST_LABEL = ro.forecast.label;

export type ForecastRule = Readonly<{
  id: string;
  description: string;
  type: "income" | "expense";
  amountMinor: bigint;
  spec: RecurrenceSpec;
  /** Următoarea scadență negenerată (`recurring_rules.next_run_on`). */
  nextRunOn: CalendarDate;
  endOn: CalendarDate | null;
  /** Câte scadențe mai poate genera (`max_occurrences − occurrences_count`), `null` = nelimitat. */
  remainingOccurrences: number | null;
}>;

export type ForecastHistoryMonth = Readonly<{
  month: Month;
  incomeMinor: bigint;
  expenseMinor: bigint;
  /** Partea generată de regulile recurente (`transactions.source = 'recurring'`). */
  recurringIncomeMinor: bigint;
  recurringExpenseMinor: bigint;
}>;

export type ForecastInputs = Readonly<{
  currency: Currency;
  today: CalendarDate;
  days: ForecastHorizon;
  /** Soldul de azi al conturilor active în monedă (poate fi negativ). */
  openingMinor: bigint;
  rules: readonly ForecastRule[];
  /** Lunile complete anterioare (cel mult `HISTORY_MONTHS`), cronologic; lunile fără activitate pot lipsi. */
  history: readonly ForecastHistoryMonth[];
}>;

export type ScheduledEvent = Readonly<{
  date: CalendarDate;
  ruleId: string;
  description: string;
  type: "income" | "expense";
  amountMinor: bigint;
}>;

export type ForecastPoint = Readonly<{
  date: CalendarDate;
  balanceMinor: bigint;
  /** Netul scadențelor din zi (venituri − cheltuieli recurente). */
  scheduledMinor: bigint;
  /** Netul liniei de bază din zi (venit nerecurent − cheltuială nerecurentă, medii zilnice). */
  baselineMinor: bigint;
}>;

export type HorizonSummary = Readonly<{
  days: ForecastHorizon;
  endOn: CalendarDate;
  projectedMinor: bigint;
  scheduledIncomeMinor: bigint;
  scheduledExpenseMinor: bigint;
  baselineIncomeMinor: bigint;
  baselineExpenseMinor: bigint;
  /** Cel mai mic sold proiectat din orizont și ziua lui (semnal de descoperire). */
  lowestMinor: bigint;
  lowestOn: CalendarDate;
}>;

export type ConfidenceLevel = "high" | "medium" | "low";
export type ConfidenceReasonCode =
  | "history_full"
  | "history_partial"
  | "history_none"
  | "stable_spending"
  | "variable_spending"
  | "erratic_spending"
  | "recurring_covered"
  | "recurring_partial"
  | "recurring_none"
  | "horizon_long";

export type ForecastConfidence = Readonly<{
  level: ConfidenceLevel;
  score: number;
  reasons: readonly Readonly<{ code: ConfidenceReasonCode; text: string }>[];
}>;

export type ForecastBaseline = Readonly<{
  dailyIncomeMinor: bigint;
  dailyExpenseMinor: bigint;
  historyMonths: number;
  historyDays: number;
  /** Cât din cheltuielile istorice vin din reguli recurente, în puncte de bază (`null` fără cheltuieli). */
  recurringCoverageBp: number | null;
  /** Variația cheltuielilor lunare (abaterea absolută medie / medie), în puncte de bază (`null` sub 2 luni). */
  spendingVariationBp: number | null;
}>;

export type Forecast = Readonly<{
  currency: Currency;
  today: CalendarDate;
  days: ForecastHorizon;
  openingMinor: bigint;
  points: readonly ForecastPoint[];
  horizons: readonly HorizonSummary[];
  upcoming: readonly ScheduledEvent[];
  baseline: ForecastBaseline;
  confidence: ForecastConfidence;
  label: string;
}>;

const BP = 10_000n;
const max = (a: CalendarDate, b: CalendarDate) => (a > b ? a : b);

/** Scadențele regulilor active din (`today`, `today + days`], în ordinea datei. */
export function scheduledEvents(
  rules: readonly ForecastRule[],
  today: CalendarDate,
  days: number,
): ScheduledEvent[] {
  const end = addDays(today, days);
  const out: ScheduledEvent[] = [];
  for (const rule of rules) {
    if (rule.remainingOccurrences !== null && rule.remainingOccurrences <= 0) continue;
    // Scadențele restante (sub azi) le generează workerul ca tranzacții trecute: intră în sold,
    // nu în prognoză. Prognoza începe de MÂINE.
    let date = occurrenceOnOrAfter(rule.spec, max(rule.nextRunOn, addDays(today, 1)));
    let count = 0;
    while (
      date !== null &&
      date <= end &&
      (rule.endOn === null || date <= rule.endOn) &&
      (rule.remainingOccurrences === null || count < rule.remainingOccurrences) &&
      count < MAX_EVENTS_PER_RULE
    ) {
      out.push({
        date,
        ruleId: rule.id,
        description: rule.description,
        type: rule.type,
        amountMinor: rule.amountMinor,
      });
      count += 1;
      date = occurrenceAfter(rule.spec, date);
    }
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.type.localeCompare(b.type) ||
      a.description.localeCompare(b.description, "ro") ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

/** Linia de bază din lunile cu activitate: medii zilnice ale părții NErecurente. */
export function baselineOf(history: readonly ForecastHistoryMonth[]): ForecastBaseline {
  const active = history.filter((m) => m.incomeMinor > 0n || m.expenseMinor > 0n);
  let days = 0n;
  let income = 0n;
  let expense = 0n;
  let totalExpense = 0n;
  let recurringExpense = 0n;
  for (const m of active) {
    days += BigInt(daysInMonth(m.month));
    const ni = m.incomeMinor - m.recurringIncomeMinor;
    const ne = m.expenseMinor - m.recurringExpenseMinor;
    income += ni < 0n ? 0n : ni;
    expense += ne < 0n ? 0n : ne;
    totalExpense += m.expenseMinor;
    recurringExpense += m.recurringExpenseMinor;
  }
  const expenses = active.filter((m) => m.expenseMinor > 0n).map((m) => m.expenseMinor);
  let variation: number | null = null;
  if (expenses.length >= 2) {
    const n = BigInt(expenses.length);
    const mean = divRound(
      expenses.reduce((a, b) => a + b, 0n),
      n,
    );
    const mad = divRound(
      expenses.reduce((a, b) => a + (b > mean ? b - mean : mean - b), 0n),
      n,
    );
    variation = mean === 0n ? 0 : Number(divRound(mad * BP, mean));
  }
  return {
    dailyIncomeMinor: days === 0n ? 0n : divRound(income, days),
    dailyExpenseMinor: days === 0n ? 0n : divRound(expense, days),
    historyMonths: active.length,
    historyDays: Number(days),
    recurringCoverageBp:
      totalExpense === 0n ? null : Number(divRound(recurringExpense * BP, totalExpense)),
    spendingVariationBp: variation,
  };
}

const tpl = (text: string, vars: Readonly<Record<string, string>>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

/** Încrederea: istoric (0–40) + stabilitate (0–30) + acoperire recurentă (0–30) − orizont (0–20). */
export function confidenceOf(
  baseline: ForecastBaseline,
  days: ForecastHorizon,
): ForecastConfidence {
  const t = ro.forecast.reasons;
  const reasons: { code: ConfidenceReasonCode; text: string }[] = [];
  let score = 0;
  if (baseline.historyMonths >= HISTORY_MONTHS) {
    score += 40;
    reasons.push({
      code: "history_full",
      text: tpl(t.history_full, { n: String(HISTORY_MONTHS) }),
    });
  } else if (baseline.historyMonths > 0) {
    score += baseline.historyMonths === 2 ? 25 : 10;
    reasons.push({
      code: "history_partial",
      text: tpl(t.history_partial, { n: String(baseline.historyMonths) }),
    });
  } else {
    reasons.push({ code: "history_none", text: t.history_none });
  }
  const v = baseline.spendingVariationBp;
  if (v !== null) {
    if (v <= 1000) {
      score += 30;
      reasons.push({ code: "stable_spending", text: t.stable_spending });
    } else if (v <= 3000) {
      score += 20;
      reasons.push({ code: "variable_spending", text: t.variable_spending });
    } else {
      score += 5;
      reasons.push({ code: "erratic_spending", text: t.erratic_spending });
    }
  }
  const c = baseline.recurringCoverageBp;
  if (c !== null && c >= 5000) {
    score += 30;
    reasons.push({ code: "recurring_covered", text: t.recurring_covered });
  } else if (c !== null && c > 0) {
    score += 15;
    reasons.push({ code: "recurring_partial", text: t.recurring_partial });
  } else {
    reasons.push({ code: "recurring_none", text: t.recurring_none });
  }
  if (days > 30) {
    score -= days === 60 ? 10 : 20;
    reasons.push({ code: "horizon_long", text: tpl(t.horizon_long, { days: String(days) }) });
  }
  score = Math.max(0, Math.min(100, score));
  const level: ConfidenceLevel = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { level, score, reasons };
}

export function computeForecast(input: ForecastInputs): Forecast {
  if (!FORECAST_HORIZONS.includes(input.days)) {
    throw new RangeError("Orizontul trebuie să fie 30, 60 sau 90 de zile.");
  }
  const events = scheduledEvents(input.rules, input.today, input.days);
  const baseline = baselineOf(input.history);
  const dailyNet = baseline.dailyIncomeMinor - baseline.dailyExpenseMinor;

  const byDate = new Map<CalendarDate, bigint>();
  for (const e of events) {
    const signed = e.type === "income" ? e.amountMinor : -e.amountMinor;
    byDate.set(e.date, (byDate.get(e.date) ?? 0n) + signed);
  }
  const points: ForecastPoint[] = [
    { date: input.today, balanceMinor: input.openingMinor, scheduledMinor: 0n, baselineMinor: 0n },
  ];
  let balance = input.openingMinor;
  for (let i = 1; i <= input.days; i++) {
    const date = addDays(input.today, i);
    const scheduled = byDate.get(date) ?? 0n;
    balance += scheduled + dailyNet;
    points.push({
      date,
      balanceMinor: balance,
      scheduledMinor: scheduled,
      baselineMinor: dailyNet,
    });
  }

  const horizons: HorizonSummary[] = [];
  for (const h of FORECAST_HORIZONS) {
    if (h > input.days) break;
    const endOn = addDays(input.today, h);
    let scheduledIncome = 0n;
    let scheduledExpense = 0n;
    for (const e of events) {
      if (e.date > endOn) break;
      if (e.type === "income") scheduledIncome += e.amountMinor;
      else scheduledExpense += e.amountMinor;
    }
    let lowest = points[1] ?? points[0]!;
    for (const p of points.slice(1, h + 1)) if (p.balanceMinor < lowest.balanceMinor) lowest = p;
    horizons.push({
      days: h,
      endOn,
      projectedMinor: points[h]!.balanceMinor,
      scheduledIncomeMinor: scheduledIncome,
      scheduledExpenseMinor: scheduledExpense,
      baselineIncomeMinor: baseline.dailyIncomeMinor * BigInt(h),
      baselineExpenseMinor: baseline.dailyExpenseMinor * BigInt(h),
      lowestMinor: lowest.balanceMinor,
      lowestOn: lowest.date,
    });
  }

  return {
    currency: input.currency,
    today: input.today,
    days: input.days,
    openingMinor: input.openingMinor,
    points,
    horizons,
    upcoming: events.slice(0, UPCOMING_LIMIT),
    baseline,
    confidence: confidenceOf(baseline, input.days),
    label: FORECAST_LABEL,
  };
}
