import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";

import { formatMinor } from "@/app/_lib/ledger-ui";
import { formatDate, formatDayShort } from "@/app/_lib/planning-ui";

import { DataTable } from "./charts";

/** Un punct al prognozei, cu coordonatele deja scalate în întregi (0–100) de apelant. */
export type ForecastChartPoint = Readonly<{
  date: string;
  balanceMinor: number;
  scheduledMinor: number;
  x: number;
  y: number;
}>;

/**
 * Soldul proiectat pe zile (ADR 0045): o linie SVG fără bibliotecă, scalată în întregi de
 * apelant (`forecast-ui.ts`, prin `percentOf`), cu linia zero marcată când soldul trece sub 0 și
 * un tabel text alternativ (zilele cu scadențe și ultima zi). Dimensiunile sunt atribute, nu
 * `style=`.
 */
export function ForecastChart({
  points,
  currency,
  zeroY,
}: Readonly<{
  points: readonly ForecastChartPoint[];
  currency: Currency;
  /** Poziția liniei de sold zero (0–100) sau `null` dacă toate soldurile au același semn. */
  zeroY: number | null;
}>) {
  const t = ro.forecast;
  const label = t.chartLabel(currency);
  if (points.length < 2) return null;
  const path = points.map((p) => `${p.x},${p.y}`).join(" ");
  const rows = points.filter((p, i) => p.scheduledMinor !== 0 || i === points.length - 1);
  return (
    <figure>
      <svg
        viewBox="-2 -4 104 112"
        preserveAspectRatio="none"
        className="h-48 w-full"
        role="img"
        aria-label={label}
        focusable="false"
        data-testid="forecast-chart"
      >
        {zeroY === null ? null : (
          <line
            x1="0"
            y1={zeroY}
            x2="100"
            y2={zeroY}
            className="stroke-bad"
            strokeWidth="0.5"
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <polyline
          points={path}
          fill="none"
          className="stroke-primary"
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {points
          .filter((p) => p.scheduledMinor !== 0)
          .map((p) => (
            <circle key={p.date} cx={p.x} cy={p.y} r="1.6" className="fill-primary" />
          ))}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground" aria-hidden="true">
        <span>{formatDayShort(points[0]!.date)}</span>
        <span>{formatDayShort(points[points.length - 1]!.date)}</span>
      </div>
      <DataTable
        caption={label}
        head={[t.tableDate, t.tableScheduled, t.tableBalance]}
        rows={rows.map((p) => [
          formatDate(p.date),
          p.scheduledMinor === 0 ? "—" : formatMinor(p.scheduledMinor, currency),
          formatMinor(p.balanceMinor, currency),
        ])}
      />
    </figure>
  );
}
