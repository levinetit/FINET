import type { Metadata } from "next";

import { Bar } from "@/components/planning/charts";
import { MonthSelector } from "@/components/planning/month-selector";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import type { HealthComponent, HealthScore } from "@/modules/health/health";
import { getHealthScore } from "@/modules/health/health.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { pageMonth } from "../../_lib/planning-page";
import { formatMonth } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.health.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TONE: Record<HealthComponent["status"], "ok" | "warn" | "bad" | "primary"> = {
  good: "ok",
  ok: "warn",
  weak: "bad",
  none: "primary",
};

const BAND_CLASS: Record<NonNullable<HealthScore["band"]>, string> = {
  good: "text-ok",
  ok: "text-primary",
  watch: "text-warn",
  fragile: "text-bad",
};

function ScoreCard({ score }: Readonly<{ score: HealthScore }>) {
  const t = ro.health;
  return (
    <Card aria-labelledby={`health-${score.currency}`} data-testid={`health-${score.currency}`}>
      <CardHeader>
        <CardTitle id={`health-${score.currency}`}>{score.currency}</CardTitle>
        <CardDescription>{t.label}</CardDescription>
      </CardHeader>
      {score.score === null || score.band === null ? (
        <p className="text-muted-foreground" data-testid="health-no-score">
          {t.noScore}
        </p>
      ) : (
        <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            className={cn("font-mono text-5xl font-bold tabular-nums", BAND_CLASS[score.band])}
            data-testid="health-score"
          >
            {score.score}
          </span>
          <span className="text-muted-foreground">{t.scoreOf}</span>
          <span className="font-semibold" data-testid="health-band">
            {t.bands[score.band]}
          </span>
          <p className="basis-full text-sm text-muted-foreground">{t.bandHints[score.band]}</p>
        </div>
      )}
      <h3 className="mb-3 text-sm font-semibold">{t.componentsTitle}</h3>
      <ul className="flex flex-col gap-4">
        {score.components.map((c) => {
          const name = t.components[c.key].name;
          return (
            <li key={c.key} className="flex flex-col gap-1" data-testid={`health-${c.key}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">{name}</span>
                <span className="font-mono text-sm tabular-nums">
                  {c.score === null ? t.noScoreComponent : `${c.score} ${t.scoreOf}`}
                  <span className="text-muted-foreground"> · {c.display}</span>
                </span>
              </div>
              <Bar
                length={c.score ?? 0}
                tone={TONE[c.status]}
                label={`${name}: ${c.score === null ? t.noScoreComponent : `${c.score} ${t.scoreOf}`}`}
              />
              <p className="text-sm text-muted-foreground">
                {c.explanation}{" "}
                <span className="whitespace-nowrap">
                  ({t.weight} {c.weight} %)
                </span>
              </p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Scorul de sănătate financiară (modernizare 2026, pasul D; ADR 0045): luna aleasă (`?month=`),
 * câte un scor pe monedă, componentele cu bare SVG (fără bibliotecă), explicațiile și pragurile.
 * Citirile se fac pe server, prin serviciu (ADR 0006); nimic nu pleacă în afara aplicației.
 */
export default async function HealthPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/health");
  const t = ro.health;
  const { month: rawMonth } = await searchParams;
  if (!page.householdId) {
    return (
      <>
        <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />
        <Card>
          <p className="text-muted-foreground">{t.noHousehold}</p>
        </Card>
      </>
    );
  }
  const householdId = page.householdId;
  const selection = await pageMonth(page, householdId, rawMonth);
  const header = (
    <PageHeader
      eyebrow={t.eyebrow}
      title={t.title}
      usageStats={page.usageStats}
      actions={
        <MonthSelector action="/health" month={selection.month} current={selection.current} />
      }
    />
  );
  const data = await load(() =>
    getHealthScore({ db: page.session.runtime.db }, page.actor, householdId, {
      month: selection.month,
    }),
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
      {selection.invalid ? <Alert className="mb-4">{ro.planning.invalidMonth}</Alert> : null}
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <h2 className="sr-only">{formatMonth(view.month)}</h2>
      <div className="flex flex-col gap-4">
        {view.currencies.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="health-empty">
              {t.noData}
            </p>
          </Card>
        ) : (
          view.currencies.map((s) => <ScoreCard key={s.currency} score={s} />)
        )}
        <Card aria-labelledby="health-thresholds">
          <CardHeader>
            <CardTitle id="health-thresholds">{t.thresholdsTitle}</CardTitle>
          </CardHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {t.thresholds.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
