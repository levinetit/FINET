import type { ForecastChartPoint } from "@/components/planning/forecast-chart";
import { percentOf } from "@/lib/money";
import type { ForecastJson } from "@/modules/forecast/forecast.schema";

/**
 * Ajutoare pure pentru pagina prognozei (ADR 0045): scalarea punctelor în coordonate întregi
 * 0–100 prin `percentOf` (fără float pe sume, regula din `ui-rules.test.ts`). Axa y e inversată
 * (0 sus); soldul maxim ajunge la y = 0 și cel minim la y = 100.
 */

export const HORIZONS = [30, 60, 90] as const;
export type HorizonChoice = (typeof HORIZONS)[number];

export function pickHorizon(raw: string | string[] | undefined): HorizonChoice {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return (HORIZONS as readonly number[]).includes(n) ? (n as HorizonChoice) : 90;
}

/** Punctele acceptate: cele ale prognozei sau orice serie (dată, sold, scadențe) — ex. averea netă. */
export type SeriesPoint = Pick<
  ForecastJson["points"][number],
  "date" | "balanceMinor" | "scheduledMinor"
>;

export function chartPoints(points: readonly SeriesPoint[]): Readonly<{
  points: ForecastChartPoint[];
  zeroY: number | null;
}> {
  if (points.length === 0) return { points: [], zeroY: null };
  let min = points[0]!.balanceMinor;
  let maxBalance = points[0]!.balanceMinor;
  for (const p of points) {
    if (p.balanceMinor < min) min = p.balanceMinor;
    if (p.balanceMinor > maxBalance) maxBalance = p.balanceMinor;
  }
  const span = BigInt(maxBalance) - BigInt(min);
  const last = points.length - 1;
  const y = (balance: number): number => {
    if (span === 0n) return 50;
    const fromTop = percentOf(BigInt(maxBalance) - BigInt(balance), span, "half_away") ?? 0;
    return Math.min(100, Math.max(0, fromTop));
  };
  const scaled = points.map((p, i) => ({
    date: p.date,
    balanceMinor: p.balanceMinor,
    scheduledMinor: p.scheduledMinor,
    x: last === 0 ? 0 : (percentOf(BigInt(i), BigInt(last), "half_away") ?? 0),
    y: y(p.balanceMinor),
  }));
  const zeroY = min < 0 && maxBalance > 0 ? y(0) : null;
  return { points: scaled, zeroY };
}
