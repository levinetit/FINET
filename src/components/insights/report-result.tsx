import Link from "next/link";

import { formatPieces, formatUnitPrice } from "@/app/_lib/insights-ui";
import { formatMinor } from "@/app/_lib/ledger-ui";
import { formatDate } from "@/app/_lib/planning-ui";
import type { Currency } from "@/lib/money";
import { ro } from "@/messages/ro";
import { quantityMilli } from "@/modules/prices/units";
import type { RunJson } from "@/modules/report-definitions/report-definitions.schema";

import { MonthBars } from "./charts";

/**
 * Rezultatul unui raport de micro-cheltuieli (rulare sau previzualizare): total, cantitate, preț
 * mediu pe unitate, proiecția anuală (ESTIMARE, cu motivul când lipsește), totalul pe luni și
 * istoricul liniilor cu legătură la bon. Componentă de prezentare, fără stare: folosită și pe
 * server (raportul ales), și în browser (previzualizarea generatorului).
 */

export function ReportResult({ result, testId }: Readonly<{ result: RunJson; testId: string }>) {
  const t = ro.insights.report;
  if (result.currencies.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid={`${testId}-empty`}>
        {result.coverage.receipts === 0 ? t.noReceipts : t.empty}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6" data-testid={testId}>
      {result.currencies.map((c) => {
        const currency = c.currency as Currency;
        const savings = c.mode === "savings";
        const tiles: ReadonlyArray<readonly [string, string, string]> = [
          [savings ? t.totalSavings : t.total, formatMinor(c.totalMinor, currency), "total"],
          ...(savings
            ? []
            : ([
                [t.charged, formatMinor(c.chargedMinor, currency), "charged"],
                ...(c.creditMinor > 0
                  ? ([[t.credit, formatMinor(c.creditMinor, currency), "credit"]] as const)
                  : []),
                [t.pieces, formatPieces(c.piecesMilli), "pieces"],
                ...(c.avgUnitMinor === null
                  ? []
                  : ([
                      [t.avgUnit, formatUnitPrice(c.avgUnitMinor, currency, "unit"), "avg"],
                    ] as const)),
              ] as const)),
          [t.lines, String(c.lineCount), "lines"],
          [t.receipts, String(c.receiptCount), "receipts"],
        ];
        return (
          <section
            key={c.currency}
            aria-label={`${t.total} (${c.currency})`}
            className="flex flex-col gap-4"
            data-testid={`${testId}-${c.currency}`}
          >
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {tiles.map(([label, value, key]) => (
                <div
                  key={key}
                  className="rounded-md bg-surface-2 px-4 py-3"
                  data-testid={`${testId}-${key}`}
                >
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <div
              className="rounded-md border border-border px-4 py-3"
              data-testid={`${testId}-projection`}
              data-status={c.projection.status}
            >
              <p className="text-sm text-muted-foreground">
                {t.projection} · {ro.insights.estimate}
              </p>
              {c.projection.status === "ok" && c.projection.yearlyMinor !== null ? (
                <>
                  <p className="font-mono text-lg font-semibold tabular-nums">
                    {formatMinor(c.projection.yearlyMinor, currency)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t.projectionNote(c.projection.coverageDays, c.projection.receipts)}
                  </p>
                </>
              ) : (
                <p className="text-sm">{t.projectionInsufficient}</p>
              )}
            </div>
            {c.byMonth.length > 1 ? (
              <div>
                <h4 className="mb-2 font-bold">{t.byMonth}</h4>
                <MonthBars
                  points={c.byMonth}
                  currency={currency}
                  label={t.byMonthLabel(c.currency)}
                  testId={`${testId}-months-${c.currency}`}
                />
              </div>
            ) : null}
          </section>
        );
      })}
      {result.currencies.length > 1 ? (
        <p className="text-sm text-muted-foreground">{t.moreThanOneCurrency}</p>
      ) : null}
      <section aria-label={t.history}>
        <h4 className="mb-2 font-bold">{t.history}</h4>
        <div className="overflow-x-auto">
          <table
            className="w-full border-collapse text-left text-sm"
            data-testid={`${testId}-lines`}
          >
            <caption className="sr-only">{t.history}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-1.5 pr-3">
                  {t.colDate}
                </th>
                <th scope="col" className="py-1.5 pr-3">
                  {t.colMerchant}
                </th>
                <th scope="col" className="py-1.5 pr-3">
                  {t.colProduct}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right">
                  {t.colQuantity}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right">
                  {t.colAmount}
                </th>
                <th scope="col" className="py-1.5">
                  <span className="sr-only">{t.openReceipt}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(l.occurredOn)}</td>
                  <td className="py-1.5 pr-3">{l.merchantName ?? "—"}</td>
                  <td className="py-1.5 pr-3">
                    {l.name}
                    {l.kind === "discount" ? (
                      <span className="ml-2 rounded bg-ok-soft px-1.5 py-0.5 text-xs">
                        {t.kinds.discount}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                    {l.quantity === null ? "—" : formatPieces(Number(quantityMilli(l.quantity)))}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                    {l.kind === "discount" ? "−" : ""}
                    {formatMinor(l.lineTotalMinor, l.currency as Currency)}
                  </td>
                  <td className="py-1.5">
                    <Link
                      href={`/receipts/${l.receiptId}`}
                      className="text-primary underline-offset-4 hover:underline"
                      aria-label={`${t.openReceipt}: ${l.name}, ${formatDate(l.occurredOn)}`}
                    >
                      {t.openReceipt}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.linesTruncated ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t.historyTruncated(result.lines.length)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
