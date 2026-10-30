import { z } from "zod";

import { addDays, addMonths, monthBounds } from "@/lib/calendar";

/**
 * Perioadele „Întreabă FINET” (F10-C; ADR 0025, 0026): o perioadă ca SPECIFICAȚIE (un set închis de
 * forme), rezolvată în cod în zile calendaristice. Parserul din cod și traducerea cu LLM produc
 * aceleași specificații; un model nu face aritmetică de date (nu scrie `from`/`to`).
 */

const MONTH_NAMES_RO = [
  "ianuarie",
  "februarie",
  "martie",
  "aprilie",
  "mai",
  "iunie",
  "iulie",
  "august",
  "septembrie",
  "octombrie",
  "noiembrie",
  "decembrie",
] as const;

export const periodSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum([
      "today",
      "yesterday",
      "this_week",
      "last_week",
      "this_month",
      "last_month",
      "this_year",
      "last_year",
    ]),
  }),
  z.strictObject({ kind: z.literal("last_n_months"), n: z.number().int().min(1).max(24) }),
  z.strictObject({ kind: z.literal("last_n_days"), n: z.number().int().min(1).max(366) }),
  z.strictObject({ kind: z.literal("month"), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
  z.strictObject({ kind: z.literal("year"), year: z.number().int().min(2000).max(2999) }),
]);
export type PeriodSpec = z.infer<typeof periodSpecSchema>;

export type ResolvedPeriod = Readonly<{ from: string; to: string; label: string }>;

export function monthLabel(month: string): string {
  return `${MONTH_NAMES_RO[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
}

/** Luni (data) a săptămânii care conține `date`. */
function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = duminică
  return addDays(date, -((dow + 6) % 7));
}

/**
 * Specificația → interval. `null` pentru o perioadă în viitor sau în afara intervalului acceptat
 * (anii 2000–azi). Luna curentă și anul curent se opresc la azi.
 */
export function resolvePeriod(spec: PeriodSpec, today: string): ResolvedPeriod | null {
  const thisMonth = today.slice(0, 7);
  const thisYear = Number(today.slice(0, 4));
  switch (spec.kind) {
    case "today":
      return { from: today, to: today, label: "azi" };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y, label: "ieri" };
    }
    case "this_week":
      return { from: weekStart(today), to: today, label: "săptămâna aceasta" };
    case "last_week": {
      const start = addDays(weekStart(today), -7);
      return { from: start, to: addDays(start, 6), label: "săptămâna trecută" };
    }
    case "this_month":
      return { from: monthBounds(thisMonth).from, to: today, label: "luna curentă" };
    case "last_month": {
      const month = addMonths(thisMonth, -1);
      return { ...monthBounds(month), label: monthLabel(month) };
    }
    case "this_year":
      return { from: `${thisYear}-01-01`, to: today, label: `anul ${thisYear}` };
    case "last_year":
      return {
        from: `${thisYear - 1}-01-01`,
        to: `${thisYear - 1}-12-31`,
        label: String(thisYear - 1),
      };
    case "last_n_months":
      return {
        from: monthBounds(addMonths(thisMonth, -(spec.n - 1))).from,
        to: today,
        label: spec.n === 1 ? "luna curentă" : `ultimele ${spec.n} luni`,
      };
    case "last_n_days":
      return { from: addDays(today, -(spec.n - 1)), to: today, label: `ultimele ${spec.n} zile` };
    case "month": {
      if (spec.month > thisMonth || Number(spec.month.slice(0, 4)) < 2000) return null;
      const { from, to } = monthBounds(spec.month);
      return { from, to: spec.month === thisMonth ? today : to, label: monthLabel(spec.month) };
    }
    case "year":
      if (spec.year > thisYear || spec.year < 2000) return null;
      return {
        from: `${spec.year}-01-01`,
        to: spec.year === thisYear ? today : `${spec.year}-12-31`,
        label: String(spec.year),
      };
  }
}
