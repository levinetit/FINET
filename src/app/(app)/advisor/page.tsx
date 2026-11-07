import type { Metadata } from "next";
import Link from "next/link";

import { MonthSelector } from "@/components/planning/month-selector";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { type AdviceJson, adviceViewToJson } from "@/modules/advisor/advisor.schema";
import { getAdvice } from "@/modules/advisor/advisor.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatMinor } from "../../_lib/ledger-ui";
import { pageMonth } from "../../_lib/planning-page";
import { formatDate, formatMonth } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.advisor.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const PRIORITY_CLASS: Record<AdviceJson["suggestions"][number]["priority"], string> = {
  high: "border-bad bg-bad-soft",
  medium: "border-warn bg-warn-soft",
  low: "border-ok bg-ok-soft",
};

function CurrencyAdvice({ a }: Readonly<{ a: AdviceJson }>) {
  const t = ro.advisor;
  const th = ro.health;
  return (
    <Card aria-labelledby={`advisor-${a.currency}`} data-testid={`advisor-${a.currency}`}>
      <CardHeader>
        <CardTitle id={`advisor-${a.currency}`}>{a.currency}</CardTitle>
        <CardDescription>{t.label}</CardDescription>
      </CardHeader>
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-surface-2 px-4 py-3" data-testid="advisor-health">
          <p className="text-sm text-muted-foreground">{t.healthTitle}</p>
          <p className="font-mono text-xl font-semibold tabular-nums">
            {a.health?.score === null || a.health?.score === undefined
              ? th.noScoreComponent
              : `${a.health.score} ${th.scoreOf}`}
            {a.health?.band ? (
              <span className="ml-2 font-sans text-sm font-normal">{th.bands[a.health.band]}</span>
            ) : null}
          </p>
          <Link href={`/health?month=${a.month}`} className="text-sm text-primary underline">
            {t.healthLink}
          </Link>
        </div>
        {a.forecast ? (
          <div className="rounded-md bg-surface-2 px-4 py-3" data-testid="advisor-forecast">
            <p className="text-sm text-muted-foreground">{t.forecastTitle}</p>
            <p
              className={cn("text-sm", a.forecast.lowestMinor < 0 ? "font-semibold text-bad" : "")}
            >
              {t.forecastLowest(
                formatMinor(a.forecast.lowestMinor, a.currency),
                formatDate(a.forecast.lowestOn),
                a.forecast.days,
              )}
            </p>
            <Link href="/forecast" className="text-sm text-primary underline">
              {t.forecastLink}
            </Link>
          </div>
        ) : null}
      </div>

      <h3 className="mb-2 text-sm font-semibold">{t.suggestionsTitle}</h3>
      <ol className="mb-5 flex flex-col gap-2" data-testid="advisor-suggestions">
        {a.suggestions.map((s) => (
          <li
            key={s.code}
            className={cn("rounded-md border px-3 py-2 text-sm", PRIORITY_CLASS[s.priority])}
            data-testid={`advisor-suggestion-${s.code}`}
          >
            <p className="font-semibold">
              {s.title}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {t.priority[s.priority]}
              </span>
            </p>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>

      <h3 className="mb-2 text-sm font-semibold">{t.unusualTitle}</h3>
      {a.unusual.length === 0 ? (
        <p className="mb-5 text-sm text-muted-foreground" data-testid="advisor-unusual-empty">
          {t.unusualEmpty}
        </p>
      ) : (
        <ul className="mb-5 flex flex-col gap-3" data-testid="advisor-unusual">
          {a.unusual.map((u) => (
            <li key={u.transactionId} className="flex flex-col gap-0.5 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-medium">
                  {formatDate(u.occurredOn)} · {u.merchant ?? u.description ?? "—"}
                </span>
                <span className="font-mono tabular-nums text-bad">
                  −{formatMinor(u.amountMinor, a.currency)}
                </span>
              </div>
              <p className="text-muted-foreground">{u.explanation}</p>
              <Link href={`/transactions/${u.transactionId}`} className="text-primary underline">
                {t.unusualOpen}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-sm font-semibold">{t.patternsTitle}</h3>
      {a.patterns.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="advisor-patterns-empty">
          {t.patternsEmpty}
        </p>
      ) : (
        <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="advisor-patterns">
          {a.patterns.map((p) => (
            <li key={`${p.code}-${p.categoryId ?? p.merchant ?? ""}`}>{p.explanation}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Consilierul (modernizare 2026, pasul F; ADR 0045): luna aleasă, câte o analiză pe monedă:
 * scorul și prognoza (legături spre paginile lor), sugestiile pe priorități, tranzacțiile
 * neobișnuite, tiparele și regulile folosite. Citiri pe server; nimic nu pleacă din aplicație.
 */
export default async function AdvisorPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const page = await requireLedgerPage("/advisor");
  const t = ro.advisor;
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
        <MonthSelector action="/advisor" month={selection.month} current={selection.current} />
      }
    />
  );
  const data = await load(async () =>
    adviceViewToJson(
      await getAdvice({ db: page.session.runtime.db }, page.actor, householdId, {
        month: selection.month,
      }),
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
  const withExpenses = view.currencies.filter((a) => a.expenseTotalMinor > 0);
  return (
    <>
      {header}
      {selection.invalid ? <Alert className="mb-4">{ro.planning.invalidMonth}</Alert> : null}
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <h2 className="sr-only">{formatMonth(view.month)}</h2>
      <div className="flex flex-col gap-4">
        {withExpenses.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="advisor-empty">
              {t.noData}
            </p>
          </Card>
        ) : (
          withExpenses.map((a) => <CurrencyAdvice key={a.currency} a={a} />)
        )}
        <Card aria-labelledby="advisor-rules">
          <CardHeader>
            <CardTitle id="advisor-rules">{t.rulesTitle}</CardTitle>
          </CardHeader>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {t.rules.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
