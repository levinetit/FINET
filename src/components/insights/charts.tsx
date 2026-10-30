import { formatMonth, formatMonthAbbr, barLength, maxAbs } from "@/app/_lib/planning-ui";
import { formatMinor } from "@/app/_lib/ledger-ui";
import { DataTable } from "@/components/planning/charts";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";

/**
 * Graficele paginii «Rapoarte inteligente» (Faza 10, F10-B), fără bibliotecă (ADR 0008): SVG cu
 * dimensiuni din ATRIBUTE (fără `style=`, CSP cu nonce), scara 0–100 în `viewBox` calculată în
 * întregi (`barLength` → `percentOf`, bigint). Fiecare grafic are `role="img"` cu etichetă și un
 * tabel text cu aceleași date.
 */

export type MonthTotalJson = Readonly<{ month: string; totalMinor: number }>;

/** Total pe luni: bare verticale; luna cu total negativ (recuperat > plătit) are altă culoare. */
export function MonthBars({
  points,
  currency,
  label,
  testId,
}: Readonly<{
  points: readonly MonthTotalJson[];
  currency: Currency;
  label: string;
  testId: string;
}>) {
  if (points.length === 0) return null;
  const max = maxAbs(points.map((p) => p.totalMinor));
  const slot = 10;
  const width = points.length * slot;
  return (
    <figure>
      <svg
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        focusable="false"
        className="h-32 w-full"
        data-testid={testId}
      >
        <rect x="0" y="99.5" width={width} height="0.5" className="fill-line" />
        {points.map((p, i) => {
          const h = barLength(p.totalMinor, max);
          return h > 0 ? (
            <rect
              key={p.month}
              x={i * slot + 1.5}
              y={100 - h}
              width="7"
              height={h}
              className={p.totalMinor < 0 ? "fill-ok" : "fill-primary"}
            />
          ) : null;
        })}
      </svg>
      <div
        className="mt-1 flex justify-between gap-1 text-[0.65rem] text-muted-foreground"
        aria-hidden
      >
        {points.map((p, i) =>
          points.length <= 12 || i % 3 === 0 ? (
            <span key={p.month}>{formatMonthAbbr(p.month)}</span>
          ) : null,
        )}
      </div>
      <DataTable
        caption={label}
        head={[ro.insights.report.tableMonth, ro.insights.report.tableTotal]}
        rows={points.map((p) => [formatMonth(p.month), formatMinor(p.totalMinor, currency)])}
      />
    </figure>
  );
}

export type SeriesPointJson = Readonly<{
  bucket: string;
  priceMinor: number;
  observations: number;
}>;
export type SeriesLineJson = Readonly<{
  key: string;
  name: string;
  points: readonly SeriesPointJson[];
}>;

const LINE_CLASSES = ["stroke-primary", "stroke-ok", "stroke-warn", "stroke-bad"] as const;
const SWATCH_CLASSES = ["fill-primary", "fill-ok", "fill-warn", "fill-bad"] as const;

/**
 * Evoluția prețului: o linie pentru toate magazinele (groasă) și câte una pe comerciant, pe o
 * scară comună de la minim la maxim. Axa orizontală = lunile (sau săptămânile) prezente în date.
 */
export function PriceChart({
  lines,
  buckets,
  currency,
  label,
  testId,
  formatBucket,
}: Readonly<{
  lines: readonly SeriesLineJson[];
  buckets: readonly string[];
  currency: Currency;
  label: string;
  testId: string;
  formatBucket: (bucket: string) => string;
}>) {
  const values = lines.flatMap((l) => l.points.map((p) => p.priceMinor));
  if (values.length === 0 || buckets.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = 100 / Math.max(buckets.length - 1, 1);
  const x = (bucket: string) => buckets.indexOf(bucket) * step;
  // 5–95: o margine în care să încapă grosimea liniei. Scara pe întregi (`barLength`).
  const y = (price: number) => (span === 0 ? 50 : 95 - barLength(price - min, span) * 0.9);
  return (
    <figure>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        focusable="false"
        className="h-40 w-full"
        data-testid={testId}
      >
        <rect x="0" y="99.5" width="100" height="0.5" className="fill-line" />
        {lines.map((l, i) => (
          <polyline
            key={l.key}
            fill="none"
            strokeWidth={i === 0 ? 2.5 : 1.5}
            vectorEffect="non-scaling-stroke"
            className={LINE_CLASSES[i % LINE_CLASSES.length]}
            points={l.points.map((p) => `${x(p.bucket)},${y(p.priceMinor)}`).join(" ")}
          />
        ))}
      </svg>
      <p className="mt-1 flex justify-between text-[0.65rem] text-muted-foreground" aria-hidden>
        <span>{formatBucket(buckets[0]!)}</span>
        <span>{formatBucket(buckets[buckets.length - 1]!)}</span>
      </p>
      <ul className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-hidden>
        {lines.map((l, i) => (
          <li key={l.key} className="flex items-center gap-1.5">
            <svg viewBox="0 0 10 10" className="size-2.5" focusable="false">
              <rect
                width="10"
                height="10"
                rx="2"
                className={SWATCH_CLASSES[i % SWATCH_CLASSES.length]}
              />
            </svg>
            {l.name}
          </li>
        ))}
      </ul>
      <DataTable
        caption={label}
        head={[ro.insights.prices.colMonth, ...lines.map((l) => l.name)]}
        rows={buckets.map((b) => [
          formatBucket(b),
          ...lines.map((l) => {
            const p = l.points.find((q) => q.bucket === b);
            return p ? formatMinor(p.priceMinor, currency) : "—";
          }),
        ])}
      />
    </figure>
  );
}
