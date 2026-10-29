import { type Month, addMonths, daysInMonth, monthBounds } from "@/lib/calendar";

/**
 * Tabelul „Acoperire extrase” (master prompt Faza 7; ADR 0018): conturi × luni, fiecare celulă
 * `complete` (fiecare zi a lunii e acoperită de perioada unui import confirmat), `partial`
 * (acoperire cu goluri sau până la o dată: `coveredUntil` = ultima zi acoperită, `fromStart` =
 * acoperirea pornește de la 1 ale lunii fără goluri până la `coveredUntil`) sau `missing`.
 * Pentru luna curentă, „complet” înseamnă acoperit până azi. Funcție pură, fără timp de proces:
 * `today` vine din apelant (data locală a gospodăriei).
 */

export type CoverageStatus = "complete" | "partial" | "missing";
export type CoverageCell = Readonly<{
  month: Month;
  status: CoverageStatus;
  coveredUntil: string | null;
  fromStart: boolean;
}>;
export type Period = Readonly<{ start: string; end: string }>;

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Intervalele unite și sortate (zilele consecutive se lipesc). */
export function mergePeriods(periods: readonly Period[]): Period[] {
  const sorted = periods
    .filter((p) => p.start <= p.end)
    .slice()
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: { start: string; end: string }[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.start <= addDays(last.end, 1)) {
      if (p.end > last.end) last.end = p.end;
    } else out.push({ start: p.start, end: p.end });
  }
  return out;
}

export function coverageForMonth(
  periods: readonly Period[],
  month: Month,
  today: string,
): CoverageCell {
  const { from, to: monthEnd } = monthBounds(month);
  const to = today < monthEnd ? today : monthEnd;
  if (to < from) return { month, status: "missing", coveredUntil: null, fromStart: false };
  const merged = mergePeriods(periods)
    .map((p) => ({ start: p.start > from ? p.start : from, end: p.end < to ? p.end : to }))
    .filter((p) => p.start <= p.end);
  if (merged.length === 0)
    return { month, status: "missing", coveredUntil: null, fromStart: false };
  const first = merged[0]!;
  const last = merged[merged.length - 1]!;
  const fromStart = first.start === from;
  if (merged.length === 1 && fromStart && first.end === to) {
    return { month, status: "complete", coveredUntil: to, fromStart: true };
  }
  return {
    month,
    status: "partial",
    coveredUntil: last.end,
    fromStart: fromStart && merged.length === 1,
  };
}

/** Lunile între `from` și `to` (inclusiv), maxim 120. */
export function monthsBetween(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  for (let m = from; m <= to && out.length < 120; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysCovered(periods: readonly Period[], month: Month): number {
  const { from, to } = monthBounds(month);
  let n = 0;
  for (const p of mergePeriods(periods)) {
    const s = p.start > from ? p.start : from;
    const e = p.end < to ? p.end : to;
    if (s <= e) n += (Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000 + 1;
  }
  return Math.min(n, daysInMonth(month));
}
