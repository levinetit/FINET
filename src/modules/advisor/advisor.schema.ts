import { z } from "zod";

import { type Currency, money, toJson } from "@/lib/money";
import { monthSchema } from "@/modules/budgets/budgets.schema";

import type { Advice } from "./advisor";

/** Consilierul (modernizare 2026, pasul F; ADR 0045): interogarea și forma JSON. */

export const advisorQuerySchema = z.strictObject({ month: monthSchema.optional() }).optional();

export type AdviceView = Readonly<{ month: string; currencies: readonly Advice[] }>;

const j = (v: bigint, c: Currency) => toJson(money(v, c)).amountMinor;
const jn = (v: bigint | null, c: Currency) => (v === null ? null : j(v, c));

export function adviceToJson(a: Advice) {
  const c = a.currency;
  return {
    currency: c,
    month: a.month,
    expenseTotalMinor: j(a.expenseTotalMinor, c),
    unusual: a.unusual.map((u) => ({
      transactionId: u.transactionId,
      occurredOn: u.occurredOn,
      merchant: u.merchant,
      description: u.description,
      categoryId: u.categoryId,
      categoryName: u.categoryName,
      amountMinor: j(u.amountMinor, c),
      baselineMinor: j(u.baselineMinor, c),
      basis: u.basis,
      ratioBp: u.ratioBp,
      explanation: u.explanation,
    })),
    patterns: a.patterns.map((p) => ({
      code: p.code,
      categoryId: p.categoryId,
      categoryName: p.categoryName,
      merchant: p.merchant,
      currentMinor: j(p.currentMinor, c),
      baselineMinor: jn(p.baselineMinor, c),
      changeBp: p.changeBp,
      explanation: p.explanation,
    })),
    suggestions: a.suggestions.map((s) => ({
      code: s.code,
      priority: s.priority,
      title: s.title,
      text: s.text,
      amountMinor: jn(s.amountMinor, c),
    })),
    health: a.health ? { score: a.health.score, band: a.health.band } : null,
    forecast: a.forecast
      ? {
          days: a.forecast.days,
          lowestMinor: j(a.forecast.lowestMinor, c),
          lowestOn: a.forecast.lowestOn,
        }
      : null,
    label: a.label,
  };
}

export type AdviceJson = ReturnType<typeof adviceToJson>;

export function adviceViewToJson(v: AdviceView) {
  return { month: v.month, currencies: v.currencies.map(adviceToJson) };
}

export type AdviceViewJson = ReturnType<typeof adviceViewToJson>;
