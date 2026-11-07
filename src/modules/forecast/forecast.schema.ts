import { z } from "zod";

import { type Currency, money, toJson } from "@/lib/money";

import {
  DEFAULT_HORIZON,
  FORECAST_HORIZONS,
  type Forecast,
  type ForecastHorizon,
} from "./forecast";

/** Prognoza de cash-flow (modernizare 2026, pasul E; ADR 0045): interogarea și forma JSON. */

export const forecastQuerySchema = z
  .strictObject({
    days: z
      .number()
      .int()
      .refine((d): d is ForecastHorizon => (FORECAST_HORIZONS as readonly number[]).includes(d), {
        message: "Orizontul trebuie să fie 30, 60 sau 90 de zile.",
      })
      .optional(),
  })
  .optional();

export type ForecastView = Readonly<{
  today: string;
  days: ForecastHorizon;
  currencies: readonly Forecast[];
}>;

const j = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;

export function forecastToJson(f: Forecast) {
  const c = f.currency;
  return {
    currency: c,
    today: f.today,
    days: f.days,
    openingMinor: j(f.openingMinor, c),
    points: f.points.map((p) => ({
      date: p.date,
      balanceMinor: j(p.balanceMinor, c),
      scheduledMinor: j(p.scheduledMinor, c),
      baselineMinor: j(p.baselineMinor, c),
    })),
    horizons: f.horizons.map((h) => ({
      days: h.days,
      endOn: h.endOn,
      projectedMinor: j(h.projectedMinor, c),
      scheduledIncomeMinor: j(h.scheduledIncomeMinor, c),
      scheduledExpenseMinor: j(h.scheduledExpenseMinor, c),
      baselineIncomeMinor: j(h.baselineIncomeMinor, c),
      baselineExpenseMinor: j(h.baselineExpenseMinor, c),
      lowestMinor: j(h.lowestMinor, c),
      lowestOn: h.lowestOn,
    })),
    upcoming: f.upcoming.map((e) => ({
      date: e.date,
      ruleId: e.ruleId,
      description: e.description,
      type: e.type,
      amountMinor: j(e.amountMinor, c),
    })),
    baseline: {
      dailyIncomeMinor: j(f.baseline.dailyIncomeMinor, c),
      dailyExpenseMinor: j(f.baseline.dailyExpenseMinor, c),
      historyMonths: f.baseline.historyMonths,
      historyDays: f.baseline.historyDays,
      recurringCoverageBp: f.baseline.recurringCoverageBp,
      spendingVariationBp: f.baseline.spendingVariationBp,
    },
    confidence: {
      level: f.confidence.level,
      score: f.confidence.score,
      reasons: f.confidence.reasons.map((r) => ({ ...r })),
    },
    label: f.label,
  };
}

export type ForecastJson = ReturnType<typeof forecastToJson>;

export function forecastViewToJson(v: ForecastView) {
  return { today: v.today, days: v.days, currencies: v.currencies.map(forecastToJson) };
}

export type ForecastViewJson = ReturnType<typeof forecastViewToJson>;

export { DEFAULT_HORIZON };
