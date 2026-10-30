import type { ReactNode } from "react";

import { formatMinor } from "@/app/_lib/ledger-ui";
import {
  barLength,
  formatDate,
  formatDayShort,
  formatMonth,
  formatMonthAbbr,
  maxAbs,
  progressLength,
} from "@/app/_lib/planning-ui";
import type { Currency } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";

/**
 * Graficele Fazei 3, fără bibliotecă (ADR 0008): SVG cu dimensiuni din ATRIBUTE (`width`,
 * `height`, `x`, `y` pe `<rect>`), deci fără `style=` (CSP cu nonce). Scara e 0–100 în `viewBox`,
 * calculată în întregi (`barLength` → `percentOf`, bigint). Culorile vin din tokeni (`fill-ok`,
 * `fill-bad`, `fill-primary`, `fill-surface-2`), deci urmează tema luminoasă/întunecată. Fiecare
 * grafic are un titlu, `role="img"` cu etichetă și un tabel text cu aceleași date (`<details>`),
 * pentru cititoarele de ecran și pentru cine preferă cifrele.
 */

export function DataTable({
  caption,
  head,
  rows,
  testId,
}: Readonly<{
  caption: string;
  head: readonly string[];
  rows: readonly (readonly ReactNode[])[];
  testId?: string;
}>) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer font-medium text-primary">
        {ro.dashboard.showTable}
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left" data-testid={testId}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              {head.map((h, i) => (
                <th key={h} scope="col" className={cn("py-1.5 pr-3", i > 0 && "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b border-border last:border-b-0">
                {row.map((cell, i) =>
                  i === 0 ? (
                    <th key={i} scope="row" className="py-1.5 pr-3 font-normal">
                      {cell}
                    </th>
                  ) : (
                    <td key={i} className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {cell}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** O bară orizontală 0–100 (cheltuieli pe categorie, buget, obiectiv). */
export function Bar({
  length,
  tone = "primary",
  marker,
  label,
  className,
}: Readonly<{
  length: number;
  tone?: "primary" | "ok" | "warn" | "bad";
  /** O linie verticală (de exemplu pragul de avertizare al bugetului), 0–100. */
  marker?: number;
  /** Eticheta pentru cititoarele de ecran; fără ea bara e decorativă. */
  label?: string;
  className?: string;
}>) {
  const fill = {
    primary: "fill-primary",
    ok: "fill-ok",
    warn: "fill-warn",
    bad: "fill-bad",
  }[tone];
  return (
    <svg
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      className={cn("h-2.5 w-full overflow-visible rounded-full", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      focusable="false"
    >
      <rect x="0" y="0" width="100" height="8" rx="4" className="fill-surface-2" />
      {length > 0 ? <rect x="0" y="0" width={length} height="8" rx="4" className={fill} /> : null}
      {marker !== undefined && marker > 0 && marker < 100 ? (
        <rect x={marker} y="-1" width="0.6" height="10" className="fill-fg" />
      ) : null}
    </svg>
  );
}

export type CategorySliceJson = Readonly<{
  categoryId: string | null;
  name: string | null;
  isOther: boolean;
  amountMinor: number;
  percent: number;
}>;

function sliceName(s: CategorySliceJson): string {
  if (s.isOther) return ro.dashboard.other;
  return s.name ?? ro.dashboard.uncategorized;
}

/** Cheltuielile pe categorii: bare orizontale proporționale cu cea mai mare felie. */
export function CategoryChart({
  slices,
  currency,
  id,
}: Readonly<{ slices: readonly CategorySliceJson[]; currency: Currency; id: string }>) {
  const t = ro.dashboard;
  if (slices.length === 0) {
    return <p className="text-muted-foreground">{t.byCategoryEmpty}</p>;
  }
  const max = maxAbs(slices.map((s) => s.amountMinor));
  return (
    <figure aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`} className="sr-only">
        {t.chartLabel(t.byCategoryTitle, currency)}
      </figcaption>
      <ul className="flex flex-col gap-3" data-testid="category-chart">
        {slices.map((s) => (
          <li key={`${s.categoryId ?? "none"}-${s.isOther}`} className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate font-medium">{sliceName(s)}</span>
              <span className="font-mono whitespace-nowrap tabular-nums">
                {formatMinor(s.amountMinor, currency)}
                <span className="ml-2 text-muted-foreground">{s.percent}%</span>
              </span>
            </span>
            <Bar length={barLength(s.amountMinor, max)} tone="bad" />
          </li>
        ))}
      </ul>
      <DataTable
        caption={t.chartLabel(t.byCategoryTitle, currency)}
        head={[t.tableCategory, t.tableAmount, t.tableShare]}
        rows={slices.map((s) => [
          sliceName(s),
          formatMinor(s.amountMinor, currency),
          `${s.percent}%`,
        ])}
      />
    </figure>
  );
}

type PairPoint = Readonly<{ key: string; incomeMinor: number; expenseMinor: number }>;

/** Bare verticale pereche (venit/cheltuială) pe o scară comună; înălțimea din `viewBox` 0–100. */
function PairBars({
  points,
  label,
  axis,
  testId,
}: Readonly<{
  points: readonly PairPoint[];
  label: string;
  axis: (key: string, index: number) => string | null;
  testId: string;
}>) {
  const max = maxAbs(points.flatMap((p) => [p.incomeMinor, p.expenseMinor]));
  const slot = 10;
  const width = points.length * slot;
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        focusable="false"
        className="h-36 w-full"
        data-testid={testId}
      >
        <rect x="0" y="99.5" width={width} height="0.5" className="fill-line" />
        {points.map((p, i) => {
          const income = barLength(p.incomeMinor, max);
          const expense = barLength(p.expenseMinor, max);
          return (
            <g key={p.key}>
              {income > 0 ? (
                <rect
                  x={i * slot + 1}
                  y={100 - income}
                  width="3.8"
                  height={income}
                  className="fill-ok"
                />
              ) : null}
              {expense > 0 ? (
                <rect
                  x={i * slot + 5.2}
                  y={100 - expense}
                  width="3.8"
                  height={expense}
                  className="fill-bad"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <div
        className="mt-1 flex justify-between gap-1 text-[0.65rem] text-muted-foreground"
        aria-hidden
      >
        {points.map((p, i) => {
          const text = axis(p.key, i);
          return text === null ? null : <span key={p.key}>{text}</span>;
        })}
      </div>
      <p className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground" aria-hidden>
        <span className="flex items-center gap-1.5">
          <svg viewBox="0 0 10 10" className="size-2.5" focusable="false">
            <rect width="10" height="10" rx="2" className="fill-ok" />
          </svg>
          {ro.dashboard.income}
        </span>
        <span className="flex items-center gap-1.5">
          <svg viewBox="0 0 10 10" className="size-2.5" focusable="false">
            <rect width="10" height="10" rx="2" className="fill-bad" />
          </svg>
          {ro.dashboard.expense}
        </span>
      </p>
    </div>
  );
}

export type MonthPointJson = Readonly<{
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}>;

/** Evoluția pe ultimele 12 luni (venituri și cheltuieli), cu tabel (inclusiv soldul net). */
export function MonthlyChart({
  points,
  currency,
}: Readonly<{ points: readonly MonthPointJson[]; currency: Currency }>) {
  const t = ro.dashboard;
  const label = t.chartLabel(t.monthlyTitle, currency);
  return (
    <figure>
      <PairBars
        points={points.map((p) => ({ ...p, key: p.month }))}
        label={label}
        axis={(key) => formatMonthAbbr(key)}
        testId="monthly-chart"
      />
      <DataTable
        caption={label}
        head={[t.tableMonth, t.income, t.expense, t.net]}
        rows={points.map((p) => [
          formatMonth(p.month),
          formatMinor(p.incomeMinor, currency),
          formatMinor(p.expenseMinor, currency),
          formatMinor(p.netMinor, currency),
        ])}
        testId="monthly-table"
      />
    </figure>
  );
}

export type DayPointJson = Readonly<{ date: string; incomeMinor: number; expenseMinor: number }>;

/** Trendul zilnic al lunii; tabelul conține doar zilele cu tranzacții. */
export function DailyChart({
  points,
  currency,
}: Readonly<{ points: readonly DayPointJson[]; currency: Currency }>) {
  const t = ro.dashboard;
  const label = t.chartLabel(t.dailyTitle, currency);
  const active = points.filter((p) => p.incomeMinor !== 0 || p.expenseMinor !== 0);
  if (active.length === 0) return <p className="text-muted-foreground">{t.dailyEmpty}</p>;
  return (
    <figure>
      <PairBars
        points={points.map((p) => ({ ...p, key: p.date }))}
        label={label}
        axis={(key, i) => (i % 7 === 0 ? formatDayShort(key) : null)}
        testId="daily-chart"
      />
      <DataTable
        caption={label}
        head={[t.tableDay, t.income, t.expense]}
        rows={active.map((p) => [
          formatDate(p.date),
          formatMinor(p.incomeMinor, currency),
          formatMinor(p.expenseMinor, currency),
        ])}
      />
    </figure>
  );
}

export type BudgetTone = "green" | "yellow" | "red";

const STATUS_CLASSES: Record<BudgetTone, string> = {
  green: "border-ok bg-ok-soft",
  yellow: "border-warn bg-warn-soft",
  red: "border-bad bg-bad-soft",
};

/** Insigna semaforului: culoare ȘI text (culoarea singură nu e accesibilă). */
export function StatusBadge({ status }: Readonly<{ status: BudgetTone }>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs font-semibold text-fg",
        STATUS_CLASSES[status],
      )}
      data-testid="budget-status"
      data-status={status}
    >
      <svg viewBox="0 0 10 10" className="size-2" aria-hidden focusable="false">
        <circle
          cx="5"
          cy="5"
          r="5"
          className={{ green: "fill-ok", yellow: "fill-warn", red: "fill-bad" }[status]}
        />
      </svg>
      {ro.planning.status[status]}
    </span>
  );
}

/** Tonul barei după semafor. */
export function toneOf(status: BudgetTone): "ok" | "warn" | "bad" {
  return status === "green" ? "ok" : status === "yellow" ? "warn" : "bad";
}

export { progressLength };
