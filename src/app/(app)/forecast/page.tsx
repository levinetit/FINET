import type { Metadata } from "next";

import { ForecastChart } from "@/components/planning/forecast-chart";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { type ForecastJson, forecastViewToJson } from "@/modules/forecast/forecast.schema";
import { getForecast } from "@/modules/forecast/forecast.service";

import { HORIZONS, chartPoints, pickHorizon } from "../../_lib/forecast-ui";
import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatMinor } from "../../_lib/ledger-ui";
import { formatDate } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.forecast.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const LEVEL_CLASS: Record<ForecastJson["confidence"]["level"], string> = {
  high: "border-ok bg-ok-soft",
  medium: "border-warn bg-warn-soft",
  low: "border-bad bg-bad-soft",
};

function HorizonCard({
  h,
  currency,
}: Readonly<{ h: ForecastJson["horizons"][number]; currency: ForecastJson["currency"] }>) {
  const t = ro.forecast;
  const negative = h.lowestMinor < 0;
  return (
    <div
      className="flex min-w-0 flex-col gap-1 rounded-md bg-surface-2 px-4 py-3"
      data-testid={`forecast-h${h.days}`}
    >
      <dt className="text-sm text-muted-foreground">
        {t.days(h.days)} · {formatDate(h.endOn)}
      </dt>
      <dd className="font-mono text-xl font-semibold tabular-nums" data-testid="forecast-projected">
        {formatMinor(h.projectedMinor, currency)}
      </dd>
      <dd className="text-xs text-muted-foreground">
        {t.scheduledIncome}: +{formatMinor(h.scheduledIncomeMinor, currency)} · {t.scheduledExpense}
        : −{formatMinor(h.scheduledExpenseMinor, currency)}
      </dd>
      <dd className="text-xs text-muted-foreground">
        {t.baselineExpense}: −{formatMinor(h.baselineExpenseMinor, currency)}
      </dd>
      <dd className={cn("text-xs", negative ? "font-semibold text-bad" : "text-muted-foreground")}>
        {t.lowest}: {formatMinor(h.lowestMinor, currency)} {t.lowestOn(formatDate(h.lowestOn))}
      </dd>
    </div>
  );
}

function CurrencyForecast({ f }: Readonly<{ f: ForecastJson }>) {
  const t = ro.forecast;
  const chart = chartPoints(f.points);
  const overdraft = f.horizons.some((h) => h.lowestMinor < 0);
  return (
    <Card aria-labelledby={`forecast-${f.currency}`} data-testid={`forecast-${f.currency}`}>
      <CardHeader>
        <CardTitle id={`forecast-${f.currency}`}>
          {f.currency} · {t.opening}: {formatMinor(f.openingMinor, f.currency)}
        </CardTitle>
        <CardDescription>{t.label}</CardDescription>
      </CardHeader>
      {overdraft ? (
        <Alert className="mb-4" data-testid="forecast-overdraft">
          {t.overdraftWarning}
        </Alert>
      ) : null}
      <dl className="mb-5 grid gap-3 sm:grid-cols-3">
        {f.horizons.map((h) => (
          <HorizonCard key={h.days} h={h} currency={f.currency} />
        ))}
      </dl>
      <h3 className="mb-2 text-sm font-semibold">{t.chartTitle}</h3>
      <ForecastChart points={chart.points} currency={f.currency} zeroY={chart.zeroY} />
      <h3 className="mt-5 mb-2 text-sm font-semibold">{t.confidenceTitle}</h3>
      <div
        className={cn("rounded-md border px-3 py-2 text-sm", LEVEL_CLASS[f.confidence.level])}
        data-testid="forecast-confidence"
      >
        <p className="font-semibold">
          {t.confidence[f.confidence.level]} · {t.confidenceScore(f.confidence.score)}
        </p>
        <ul className="mt-1 list-disc pl-5">
          {f.confidence.reasons.map((r) => (
            <li key={r.code}>{r.text}</li>
          ))}
        </ul>
      </div>
      <h3 className="mt-5 mb-2 text-sm font-semibold">{t.baselineTitle}</h3>
      <p className="text-sm text-muted-foreground">
        {f.baseline.historyMonths === 0
          ? t.baselineNone
          : t.baselineText(
              formatMinor(f.baseline.dailyIncomeMinor, f.currency),
              formatMinor(f.baseline.dailyExpenseMinor, f.currency),
              f.baseline.historyMonths,
              f.baseline.historyDays,
            )}
      </p>
      <h3 className="mt-5 mb-2 text-sm font-semibold">{t.upcomingTitle}</h3>
      {f.upcoming.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="forecast-upcoming-empty">
          {t.upcomingEmpty}
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="forecast-upcoming">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t.tableDate}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t.upcomingRule}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t.upcomingAmount}
              </th>
            </tr>
          </thead>
          <tbody>
            {f.upcoming.map((e) => (
              <tr key={`${e.date}-${e.ruleId}`} className="border-t border-border">
                <td className="py-1 pr-3 whitespace-nowrap">{formatDate(e.date)}</td>
                <td className="py-1 pr-3">{e.description}</td>
                <td
                  className={cn(
                    "py-1 text-right font-mono tabular-nums",
                    e.type === "expense" ? "text-bad" : "text-ok",
                  )}
                >
                  {e.type === "expense" ? "−" : "+"}
                  {formatMinor(e.amountMinor, f.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/**
 * Prognoza de cash-flow (modernizare 2026, pasul E; ADR 0045): orizontul din URL (`?days=30|60|90`,
 * implicit 90), câte o prognoză pe monedă: rezumatele la 30/60/90, linia soldului proiectat (SVG),
 * încrederea cu motive, linia de bază și plățile viitoare. Citiri pe server, prin serviciu.
 */
export default async function ForecastPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/forecast");
  const t = ro.forecast;
  const { days: rawDays } = await searchParams;
  const days = pickHorizon(rawDays);
  const actions = (
    <nav aria-label={t.horizon} className="flex gap-2">
      {HORIZONS.map((h) => (
        <a
          key={h}
          href={`/forecast?days=${h}`}
          aria-current={h === days ? "page" : undefined}
          className={buttonClasses(h === days ? "default" : "outline")}
        >
          {t.days(h)}
        </a>
      ))}
    </nav>
  );
  const header = (
    <PageHeader
      eyebrow={t.eyebrow}
      title={t.title}
      usageStats={page.usageStats}
      actions={page.householdId ? actions : undefined}
    />
  );
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
  const data = await load(async () =>
    forecastViewToJson(
      await getForecast({ db: page.session.runtime.db }, page.actor, householdId, { days }),
    ),
  );
  if (!data.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const view = data.value;
  return (
    <>
      {header}
      <p className="mb-4 text-muted-foreground">
        {t.intro} {t.today}: {formatDate(view.today)}.
      </p>
      <div className="flex flex-col gap-4">
        {view.currencies.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="forecast-empty">
              {t.noData}
            </p>
          </Card>
        ) : (
          view.currencies.map((f) => <CurrencyForecast key={f.currency} f={f} />)
        )}
      </div>
    </>
  );
}
