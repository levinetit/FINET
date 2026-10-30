import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PriceChart } from "@/components/insights/charts";
import { ReportResult } from "@/components/insights/report-result";
import { ExportButton } from "@/components/planning/export-button";
import { ConflictError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { listCategories } from "@/modules/categories/categories.service";
import { inflationToJson, productsToJson, seriesToJson } from "@/modules/prices/prices.schema";
import { getInflation, getSeries, listProducts } from "@/modules/prices/prices.service";
import {
  definitionToJson,
  runToJson,
} from "@/modules/report-definitions/report-definitions.schema";
import {
  listDefinitions,
  runDefinition,
} from "@/modules/report-definitions/report-definitions.service";
import { listTags } from "@/modules/tags/tags.service";

import {
  formatBps,
  formatUnitPrice,
  insightsHref,
  pickCurrency,
  pickId,
  pickPeriod,
  pickText,
  reportExportPath,
  type PriceUnit,
} from "../../_lib/insights-ui";
import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatMonth } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

import { OwnReportActions } from "./report-actions";
import { ReportGenerator } from "./report-generator";

export const metadata: Metadata = { title: ro.insights.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const INFLATION_MONTHS = [3, 6, 12] as const;

/**
 * «Rapoarte inteligente și micro-cheltuieli» (Faza 10, F10-B; ADR 0023): trei secțiuni peste
 * bonurile CONFIRMATE vizibile utilizatorului: (1) rapoarte predefinite și proprii, (2) generatorul
 * pe articole, (3) prețuri pe magazin, evoluție și inflație personală. Starea (raportul, perioada,
 * produsul) e în URL, deci pagina e randată pe server și funcționează și fără JavaScript; doar
 * generatorul, exportul CSV și acțiunile pe un raport propriu sunt componente de client.
 * Toate valorile sunt ESTIMĂRI din bonurile utilizatorului; sub pragul de date nu se arată nimic.
 */
export default async function InsightsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/insights");
  const t = ro.insights;
  const header = <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />;
  if (!page.householdId) {
    return (
      <>
        {header}
        <Card>
          <p className="text-muted-foreground">{t.noHousehold}</p>
        </Card>
      </>
    );
  }
  const householdId = page.householdId;
  const sp = await searchParams;
  const now = () => new Date();
  const deps = { db: page.session.runtime.db, now };
  const period = pickPeriod(sp.period);
  const q = pickText(sp.q, 80);
  const productKey = pickText(sp.product, 320);
  const currency = pickCurrency(sp.cur);
  const inflationMonths = Number(pickText(sp.im, 2));
  const months = (INFLATION_MONTHS as readonly number[]).includes(inflationMonths)
    ? inflationMonths
    : 3;
  const baseline = pickText(sp.ib, 10) === "previous" ? "previous" : "year_ago";

  const defsResult = await load(() => listDefinitions(deps, page.actor, householdId));
  const defs = defsResult.ok ? defsResult.value.map(definitionToJson) : [];
  const wanted = pickId(sp.report);
  const selected = defs.find((d) => d.id === wanted) ?? defs[0] ?? null;
  const copyId = pickId(sp.copy);
  const copyOf = defs.find((d) => d.id === copyId) ?? null;

  // Rularea raportului ales: o depășire a plafonului de linii are mesaj propriu.
  let run: ReturnType<typeof runToJson> | null = null;
  let runProblem: "error" | "too_many" | null = null;
  if (selected) {
    try {
      run = runToJson(await runDefinition(deps, page.actor, householdId, selected.id, { period }));
    } catch (error) {
      runProblem =
        error instanceof ConflictError && error.reason === "too_many_lines" ? "too_many" : "error";
      if (runProblem === "error") console.error("[ui] raportul nu a putut fi rulat");
    }
  }

  const [categories, tags, productsResult, inflationResult] = await Promise.all([
    load(() => listCategories(deps, page.actor, householdId, { includeHidden: false })),
    load(() => listTags(deps, page.actor, householdId, {})),
    load(() =>
      listProducts(deps, page.actor, householdId, { ...(q ? { search: q } : {}), limit: 30 }),
    ),
    load(() => getInflation(deps, page.actor, householdId, { months, baseline })),
  ]);
  const seriesResult = productKey
    ? await load(() =>
        getSeries(deps, page.actor, householdId, { product: productKey, currency, months: 12 }),
      ).catch(() => null)
    : null;

  const section = "grid gap-4";
  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        <p className="text-muted-foreground">{t.intro}</p>
        <p className="text-sm text-muted-foreground">{t.dataNote}</p>
        <nav aria-label={t.nav} className="flex flex-wrap gap-2 text-sm">
          {(
            [
              ["rapoarte", t.reportsTitle],
              ["generator", t.generatorTitle],
              ["preturi", t.pricesTitle],
            ] as const
          ).map(([id, label]) => (
            <a key={id} href={`#${id}`} className={buttonClasses("outline", "sm")}>
              {label}
            </a>
          ))}
        </nav>

        {/* 1. Rapoarte predefinite și proprii */}
        <Card id="rapoarte" aria-labelledby="rapoarte-title" data-testid="reports-section">
          <CardHeader>
            <CardTitle id="rapoarte-title">{t.reportsTitle}</CardTitle>
          </CardHeader>
          {!defsResult.ok ? <Alert>{t.loadError}</Alert> : null}
          <div className={section}>
            <ul
              aria-label={t.report.listLabel}
              className="flex flex-wrap gap-2"
              data-testid="report-list"
            >
              {defs.map((d) => (
                <li key={d.id}>
                  <Link
                    href={insightsHref({ report: d.id, period }, "rapoarte")}
                    aria-current={selected?.id === d.id ? "true" : undefined}
                    className={cn(
                      buttonClasses(selected?.id === d.id ? "default" : "outline", "sm"),
                      "whitespace-normal",
                    )}
                    data-testid="report-link"
                    data-report-name={d.name}
                  >
                    {d.name}
                    <span className="ml-1 text-xs opacity-80">
                      ({d.isSystem ? t.report.system : t.report.own})
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {selected ? (
              <div
                className="flex flex-col gap-4"
                data-testid="report-selected"
                data-report-id={selected.id}
              >
                <div>
                  <h3 className="text-xl font-bold">{selected.name}</h3>
                  {selected.description ? (
                    <p className="text-sm text-muted-foreground">{selected.description}</p>
                  ) : null}
                </div>
                <div role="group" aria-label={t.periodLabel} className="flex flex-wrap gap-2">
                  {(Object.keys(t.periods) as Array<keyof typeof t.periods>).map((p) => (
                    <Link
                      key={p}
                      href={insightsHref({ report: selected.id, period: p }, "rapoarte")}
                      aria-current={period === p ? "true" : undefined}
                      className={buttonClasses(period === p ? "default" : "outline", "sm")}
                      data-testid={`period-${p}`}
                    >
                      {t.periods[p]}
                    </Link>
                  ))}
                </div>
                {runProblem === "too_many" ? <Alert>{t.report.tooMany}</Alert> : null}
                {runProblem === "error" ? <Alert>{t.loadError}</Alert> : null}
                {run ? <ReportResult result={run} testId="report" /> : null}
                {selected.advice ? (
                  <aside className="rounded-md bg-surface-2 px-4 py-3" data-testid="report-advice">
                    <p className="text-sm font-semibold">{t.report.advice}</p>
                    <p className="text-sm">{selected.advice}</p>
                  </aside>
                ) : null}
                <div className="flex flex-wrap items-start gap-3">
                  <ExportButton
                    path={reportExportPath(selected.id, period)}
                    label={t.report.exportCsv}
                    filename="finet-raport.csv"
                    testId="report-export"
                  />
                  <Link
                    href={insightsHref(
                      { report: selected.id, period, copy: selected.id },
                      "generator",
                    )}
                    className={buttonClasses("outline")}
                    data-testid="report-copy"
                  >
                    {t.report.copy}
                  </Link>
                  {selected.isSystem ? null : <OwnReportActions id={selected.id} />}
                </div>
              </div>
            ) : null}
          </div>
        </Card>

        {/* 2. Generatorul pe articole */}
        <Card id="generator" aria-labelledby="generator-title" data-testid="generator-section">
          <CardHeader>
            <CardTitle id="generator-title">{t.generatorTitle}</CardTitle>
          </CardHeader>
          <ReportGenerator
            key={copyOf?.id ?? "nou"}
            initial={copyOf}
            categories={
              categories.ok ? categories.value.map((c) => ({ id: c.id, name: c.name })) : []
            }
            tags={tags.ok ? tags.value.map((x) => ({ id: x.id, name: x.name })) : []}
          />
        </Card>

        {/* 3. Prețuri și inflație */}
        <Card id="preturi" aria-labelledby="preturi-title" data-testid="prices-section">
          <CardHeader>
            <CardTitle id="preturi-title">{t.pricesTitle}</CardTitle>
            <CardDescription>{t.estimate}</CardDescription>
          </CardHeader>
          <div className="flex flex-col gap-8">
            <InflationBlock
              result={inflationResult.ok ? inflationToJson(inflationResult.value) : null}
              months={months}
              baseline={baseline}
              period={period}
              reportId={selected?.id ?? null}
            />
            <PricesBlock
              result={productsResult.ok ? productsToJson(productsResult.value) : null}
              series={
                seriesResult && seriesResult.ok && seriesResult.value
                  ? seriesToJson(seriesResult.value)
                  : null
              }
              q={q}
              productKey={productKey}
              currency={currency}
            />
          </div>
        </Card>
      </div>
    </>
  );
}

type InflationJson = ReturnType<typeof inflationToJson>;

function InflationBlock({
  result,
  months,
  baseline,
  period,
  reportId,
}: Readonly<{
  result: InflationJson | null;
  months: number;
  baseline: "previous" | "year_ago";
  period: ReturnType<typeof pickPeriod>;
  reportId: string | null;
}>) {
  const t = ro.insights.inflation;
  const href = (m: number, b: "previous" | "year_ago") =>
    insightsHref({ report: reportId, period, months: m, baseline: b }, "inflatie");
  return (
    <section aria-labelledby="inflatie-title" id="inflatie" data-testid="inflation">
      <h3 id="inflatie-title" className="text-xl font-bold">
        {t.title}
      </h3>
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t.windowLabel}>
        {INFLATION_MONTHS.map((m) => (
          <Link
            key={m}
            href={href(m, baseline)}
            aria-current={months === m ? "true" : undefined}
            className={buttonClasses(months === m ? "default" : "outline", "sm")}
          >
            {t.months(m)}
          </Link>
        ))}
        {(["year_ago", "previous"] as const).map((b) => (
          <Link
            key={b}
            href={href(months, b)}
            aria-current={baseline === b ? "true" : undefined}
            className={buttonClasses(baseline === b ? "default" : "outline", "sm")}
          >
            {b === "year_ago" ? t.baselineYear : t.baselinePrev}
          </Link>
        ))}
      </div>
      {result === null ? <Alert className="mt-3">{ro.insights.loadError}</Alert> : null}
      {result && result.currencies.length === 0 ? (
        <p className="mt-3 text-muted-foreground" data-testid="inflation-empty">
          {t.noData}
        </p>
      ) : null}
      {result?.currencies.map((c) => (
        <div
          key={c.currency}
          className="mt-4 flex flex-col gap-3"
          data-testid={`inflation-${c.currency}`}
          data-status={c.status}
        >
          {c.status === "ok" && c.changeBps !== null ? (
            <>
              <p>
                <span className="text-sm text-muted-foreground">
                  {t.changeLabel} ({c.currency}) · {ro.insights.estimate}
                </span>
                <span
                  className="block font-mono text-3xl font-bold tabular-nums"
                  data-testid="inflation-change"
                >
                  {formatBps(c.changeBps, { sign: true })}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t.itemsUsed(c.itemsUsed)} · {t.coverage(formatBps(c.coverageBps))}
                </span>
              </p>
              {c.byMerchant.some((m) => m.changeBps !== null) ? (
                <div>
                  <h4 className="mb-1 font-bold">{t.byMerchant}</h4>
                  <ul className="flex flex-col gap-1 text-sm">
                    {c.byMerchant
                      .filter((m) => m.changeBps !== null)
                      .map((m) => (
                        <li key={m.merchantKey} className="flex justify-between gap-3">
                          <span>{m.merchantName ?? ro.insights.prices.merchantUnknown}</span>
                          <span className="font-mono tabular-nums">
                            {formatBps(m.changeBps!, { sign: true })}
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="mb-1 text-left font-bold">{t.topItems}</caption>
                  <thead>
                    <tr className="border-b border-border">
                      <th scope="col" className="py-1.5 pr-3">
                        {t.colItem}
                      </th>
                      <th scope="col" className="py-1.5 pr-3">
                        {t.colMerchant}
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right">
                        {t.colBase}
                      </th>
                      <th scope="col" className="py-1.5 pr-3 text-right">
                        {t.colCurrent}
                      </th>
                      <th scope="col" className="py-1.5 text-right">
                        {t.colChange}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.items.slice(0, 10).map((i) => (
                      <tr
                        key={`${i.productKey}-${i.merchantKey}`}
                        className="border-b border-border last:border-b-0"
                      >
                        <th scope="row" className="py-1.5 pr-3 font-normal">
                          {i.name}
                        </th>
                        <td className="py-1.5 pr-3">{i.merchantName ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                          {formatUnitPrice(
                            i.basePriceMinor,
                            c.currency as Currency,
                            i.unit as PriceUnit,
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                          {formatUnitPrice(
                            i.currentPriceMinor,
                            c.currency as Currency,
                            i.unit as PriceUnit,
                          )}
                        </td>
                        <td className="py-1.5 text-right font-mono tabular-nums">
                          {formatBps(i.changeBps, { sign: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p data-testid="inflation-insufficient">
              {t.insufficient} ({c.currency}: {t.itemsUsed(c.itemsUsed)})
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

type ProductsJson = ReturnType<typeof productsToJson>;
type SeriesJson = ReturnType<typeof seriesToJson>;

function PricesBlock({
  result,
  series,
  q,
  productKey,
  currency,
}: Readonly<{
  result: ProductsJson | null;
  series: SeriesJson | null;
  q: string;
  productKey: string;
  currency: Currency;
}>) {
  const t = ro.insights.prices;
  return (
    <section aria-labelledby="produse-title" id="produse" data-testid="prices">
      <h3 id="produse-title" className="text-xl font-bold">
        {t.title}
      </h3>
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      <form action="/insights" method="get" className="mt-3 flex flex-wrap items-end gap-2">
        <div className="flex min-w-48 grow flex-col gap-1.5 md:max-w-sm">
          <Label htmlFor="price-search">{t.search}</Label>
          <Input id="price-search" name="q" defaultValue={q} maxLength={80} autoComplete="off" />
        </div>
        <button type="submit" className={buttonClasses("outline")}>
          {t.searchButton}
        </button>
      </form>
      {result === null ? <Alert className="mt-3">{ro.insights.loadError}</Alert> : null}
      {result && result.products.length === 0 ? (
        <p className="mt-3 text-muted-foreground" data-testid="prices-empty">
          {q ? t.noMatch : t.noData}
        </p>
      ) : null}
      {result && result.products.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm" data-testid="prices-table">
            <caption className="sr-only">{t.title}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-1.5 pr-3">
                  {t.colProduct}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right">
                  {t.colPrice}
                </th>
                <th scope="col" className="py-1.5 pr-3 text-right">
                  {t.colObservations}
                </th>
                <th scope="col" className="py-1.5">
                  {t.colCheapest}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.products.map((p) => {
                const cur = p.currency as Currency;
                const cheapest = p.cheapest;
                return (
                  <tr
                    key={`${p.currency}-${p.productKey}`}
                    className="border-b border-border last:border-b-0"
                    data-testid="price-row"
                    data-enough={p.enough}
                  >
                    <th scope="row" className="py-1.5 pr-3 font-normal">
                      <Link
                        href={insightsHref({ q, product: p.productKey, currency: cur }, "produse")}
                        className="text-primary underline-offset-4 hover:underline"
                        aria-label={`${t.showSeries}: ${p.name}`}
                      >
                        {p.name}
                      </Link>
                    </th>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                      {p.enough && p.priceMinor !== null ? (
                        <>
                          {formatUnitPrice(p.priceMinor, cur, p.unit as PriceUnit)}
                          <span className="block text-xs text-muted-foreground">
                            {t.units[p.unit as keyof typeof t.units]}
                          </span>
                        </>
                      ) : (
                        <span className="font-sans text-muted-foreground">{t.notEnough}</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {p.observations}
                      {!p.enough ? (
                        <span className="block text-xs text-muted-foreground">
                          {t.notEnoughDetail(p.observations, p.months)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5">
                      {p.enough && cheapest
                        ? cheapest.cheapest.merchantKey === cheapest.mostUsed.merchantKey
                          ? t.sameStore
                          : t.cheapestValue(
                              cheapest.cheapest.merchantName ?? t.merchantUnknown,
                              formatBps(cheapest.diffBps),
                            )
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {result && result.excludedLines > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">{t.excluded(result.excludedLines)}</p>
      ) : null}
      {productKey && series ? (
        <div className="mt-6" data-testid="price-series" id="serie">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-bold">
              {t.seriesTitle}: {series.name}
            </h4>
            <Link href={insightsHref({ q }, "produse")} className={buttonClasses("outline", "sm")}>
              {t.closeSeries}
            </Link>
          </div>
          {series.enough ? (
            <PriceChart
              lines={[
                { key: "all", name: t.overall, points: series.overall },
                ...series.byMerchant.map((m) => ({
                  key: m.merchantKey,
                  name: m.merchantName ?? t.merchantUnknown,
                  points: m.points,
                })),
              ]}
              buckets={[...new Set(series.overall.map((p) => p.bucket))].sort()}
              currency={currency}
              label={t.seriesLabel(series.name, series.currency)}
              testId="series-chart"
              formatBucket={(b) => (b.length === 7 ? formatMonth(b) : b)}
            />
          ) : (
            <p className="mt-2 text-muted-foreground">{t.seriesNotEnough}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
