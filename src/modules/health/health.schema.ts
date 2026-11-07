import { z } from "zod";

import { monthSchema } from "@/modules/budgets/budgets.schema";

import type { HealthComponent, HealthScore } from "./health";

/** Scorul de sănătate financiară (modernizare 2026, pasul D; ADR 0045): interogarea și forma JSON. */

export const healthQuerySchema = z.strictObject({ month: monthSchema.optional() }).optional();

export type HealthComponentJson = HealthComponent;

export type HealthScoreJson = Readonly<{
  currency: HealthScore["currency"];
  month: string;
  score: number | null;
  band: HealthScore["band"];
  components: readonly HealthComponentJson[];
  label: string;
}>;

export type HealthView = Readonly<{
  month: string;
  /** Câte un scor pe monedă (fără conversie), în ordinea alfabetică a monedelor. */
  currencies: readonly HealthScore[];
}>;

export type HealthViewJson = Readonly<{ month: string; currencies: readonly HealthScoreJson[] }>;

/** Componentele nu conțin `bigint`: sumele apar doar formatate, în `display`/`explanation`. */
export function healthScoreToJson(h: HealthScore): HealthScoreJson {
  return {
    currency: h.currency,
    month: h.month,
    score: h.score,
    band: h.band,
    components: h.components.map((c) => ({ ...c })),
    label: h.label,
  };
}

export function healthViewToJson(v: HealthView): HealthViewJson {
  return { month: v.month, currencies: v.currencies.map(healthScoreToJson) };
}
