import {
  type CalendarDate,
  type Month,
  addDays,
  addMonths,
  dayNumber,
  monthBounds,
} from "./calendar";

/**
 * Perioadele rapoartelor de micro-cheltuieli și ferestrele prețurilor/inflației (Faza 10, F10-B;
 * ADR 0023). Funcții PURE peste `calendar.ts`: datele sunt locale (`YYYY-MM-DD`), iar „azi” vine
 * din fusul orar al gospodăriei (`localDateOf`), exact ca în rapoartele existente.
 *
 * - `all`: toată arhiva (fără limite);
 * - `this_month`: de la 1 al lunii curente până azi;
 * - `last_month`: luna calendaristică precedentă, întreagă;
 * - `last_3_months`: luna curentă (până azi) și cele două dinaintea ei, întregi;
 * - `this_year`: de la 1 ianuarie până azi.
 */

export const REPORT_PERIODS = [
  "all",
  "this_month",
  "last_month",
  "last_3_months",
  "this_year",
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** Interval închis de zile locale; `null` = fără limită. */
export type DateRange = Readonly<{ from: CalendarDate | null; to: CalendarDate | null }>;
/** Interval închis, cu ambele capete. */
export type ClosedRange = Readonly<{ from: CalendarDate; to: CalendarDate }>;

export function periodRange(period: ReportPeriod, today: CalendarDate): DateRange {
  const month: Month = today.slice(0, 7);
  switch (period) {
    case "all":
      return { from: null, to: null };
    case "this_month":
      return { from: monthBounds(month).from, to: today };
    case "last_month": {
      const prev = addMonths(month, -1);
      return monthBounds(prev);
    }
    case "last_3_months":
      return { from: monthBounds(addMonths(month, -2)).from, to: today };
    case "this_year":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** Numărul de zile dintre două date locale, ambele incluse (≥ 1 când `from <= to`). */
export function daysInclusive(from: CalendarDate, to: CalendarDate): number {
  return dayNumber(to) - dayNumber(from) + 1;
}

/** Ultimele `months` luni calendaristice, inclusiv luna curentă (până azi). */
export function lastMonthsRange(months: number, today: CalendarDate): DateRange {
  const month: Month = today.slice(0, 7);
  return { from: monthBounds(addMonths(month, -(months - 1))).from, to: today };
}

/**
 * Ferestrele inflației: fereastra CURENTĂ = ultimele `months` luni (inclusiv luna curentă, până
 * azi); fereastra de BAZĂ = fie cele `months` luni imediat dinainte (`previous`), fie aceeași
 * fereastră cu un an în urmă (`year_ago`, aceleași limite, 29 februarie → 28).
 */
export const INFLATION_BASELINES = ["previous", "year_ago"] as const;
export type InflationBaseline = (typeof INFLATION_BASELINES)[number];

export function inflationWindows(
  months: number,
  baseline: InflationBaseline,
  today: CalendarDate,
): Readonly<{ base: ClosedRange; current: ClosedRange }> {
  const month: Month = today.slice(0, 7);
  const current = {
    from: monthBounds(addMonths(month, -(months - 1))).from,
    to: today,
  };
  if (baseline === "previous") {
    return {
      current,
      base: {
        from: monthBounds(addMonths(month, -(2 * months - 1))).from,
        to: monthBounds(addMonths(month, -months)).to,
      },
    };
  }
  const shift = (d: CalendarDate): CalendarDate => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    const lastDay = Number(
      monthBounds(`${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}`).to.slice(8),
    );
    return `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  };
  return { current, base: { from: shift(current.from), to: shift(current.to) } };
}

/** Începutul săptămânii ISO (luni) pentru o dată locală. */
export function weekStart(date: CalendarDate): CalendarDate {
  const n = dayNumber(date);
  // 1970-01-01 a fost joi: (n + 3) % 7 = 0 pentru luni.
  const offset = (((n + 3) % 7) + 7) % 7;
  return addDays(date, -offset);
}
