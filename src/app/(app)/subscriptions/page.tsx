import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import {
  type SubscriptionsSummaryJson,
  subscriptionsViewToJson,
} from "@/modules/subscriptions/subscriptions.schema";
import { getSubscriptions } from "@/modules/subscriptions/subscriptions.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatMinor } from "../../_lib/ledger-ui";
import { formatDate } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.subscriptions.title };

function CurrencySubscriptions({ s }: Readonly<{ s: SubscriptionsSummaryJson }>) {
  const t = ro.subscriptions;
  const c = s.currency;
  return (
    <Card aria-labelledby={`subs-${c}`} data-testid={`subscriptions-${c}`}>
      <CardHeader>
        <CardTitle id={`subs-${c}`}>{c}</CardTitle>
        <CardDescription>{t.counts(s.activeCount, s.pausedCount)}</CardDescription>
      </CardHeader>
      <dl className="mb-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md bg-surface-2 px-4 py-3">
          <dt className="text-sm text-muted-foreground">{t.monthly}</dt>
          <dd
            className="font-mono text-xl font-semibold tabular-nums"
            data-testid="subscriptions-monthly"
          >
            {formatMinor(s.monthlyMinor, c)}
          </dd>
        </div>
        <div className="rounded-md bg-surface-2 px-4 py-3">
          <dt className="text-sm text-muted-foreground">{t.annual}</dt>
          <dd
            className="font-mono text-xl font-semibold tabular-nums"
            data-testid="subscriptions-annual"
          >
            {formatMinor(s.annualMinor, c)}
          </dd>
        </div>
      </dl>

      <h3 className="mb-2 text-sm font-semibold">{t.upcomingTitle}</h3>
      {s.upcoming.length === 0 ? (
        <p className="mb-5 text-sm text-muted-foreground">{t.upcomingEmpty}</p>
      ) : (
        <ul
          className="mb-5 flex flex-col divide-y divide-border text-sm"
          data-testid="subscriptions-upcoming"
        >
          {s.upcoming.map((x) => (
            <li key={x.ruleId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span>
                <span className="font-medium">{x.name}</span>
                <span className="ml-2 text-muted-foreground">
                  {x.nextRenewalOn ? formatDate(x.nextRenewalOn) : ""} ·{" "}
                  {x.daysToRenewal === null ? "" : t.renewsIn(x.daysToRenewal)}
                </span>
              </span>
              <span className="font-mono tabular-nums">{formatMinor(x.amountMinor, c)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-sm font-semibold">{t.byCategoryTitle}</h3>
      <ul className="mb-5 flex flex-col gap-1 text-sm" data-testid="subscriptions-by-category">
        {s.byCategory.map((x) => (
          <li key={x.categoryId ?? "none"} className="flex justify-between gap-3">
            <span>
              {x.categoryName ?? t.noCategory}
              <span className="ml-1 text-muted-foreground">({x.count})</span>
            </span>
            <span className="font-mono tabular-nums">{formatMinor(x.monthlyMinor, c)}</span>
          </li>
        ))}
      </ul>

      <h3 className="mb-2 text-sm font-semibold">{t.listTitle}</h3>
      <table className="w-full text-sm" data-testid="subscriptions-list">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              {ro.recurring.description}
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              {ro.recurring.frequency}
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              {t.monthly}
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              {t.annual}
            </th>
          </tr>
        </thead>
        <tbody>
          {s.subscriptions.map((x) => (
            <tr
              key={x.ruleId}
              className={cn(
                "border-t border-border",
                x.status === "paused" && "text-muted-foreground",
              )}
            >
              <td className="py-1 pr-3">
                <Link href={`/recurring/${x.ruleId}`} className="underline">
                  {x.name}
                </Link>
                {x.merchant ? (
                  <span className="ml-1 text-muted-foreground">· {x.merchant}</span>
                ) : null}
                {x.status === "paused" ? <span className="ml-1 text-xs">({t.paused})</span> : null}
              </td>
              <td className="py-1 pr-3 whitespace-nowrap">
                {ro.recurring.every(x.interval, x.frequency)}
              </td>
              <td className="py-1 pr-3 text-right font-mono tabular-nums">
                {formatMinor(x.monthlyMinor, c)}
              </td>
              <td className="py-1 text-right font-mono tabular-nums">
                {formatMinor(x.annualMinor, c)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Abonamentele (modernizare 2026, pasul I; ADR 0047): o vedere peste regulile recurente de
 * cheltuieli, pe monedă: cost lunar/anual, reînnoiri în 30 de zile, categorii, lista; plus plățile
 * recurente detectate din istoric. Citiri pe server; administrarea rămâne în Recurențe.
 */
export default async function SubscriptionsPage() {
  const page = await requireLedgerPage("/subscriptions");
  const t = ro.subscriptions;
  const header = (
    <PageHeader
      eyebrow={t.eyebrow}
      title={t.title}
      usageStats={page.usageStats}
      actions={
        <Link href="/recurring" className={buttonClasses("outline")}>
          {t.manage}
        </Link>
      }
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
    subscriptionsViewToJson(
      await getSubscriptions({ db: page.session.runtime.db }, page.actor, householdId),
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
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <div className="flex flex-col gap-4">
        {view.currencies.length === 0 ? (
          <Card>
            <p className="text-muted-foreground" data-testid="subscriptions-empty">
              {t.empty}
            </p>
          </Card>
        ) : (
          view.currencies.map((s) => <CurrencySubscriptions key={s.currency} s={s} />)
        )}
        <Card aria-labelledby="subs-detected">
          <CardHeader>
            <CardTitle id="subs-detected">{t.detectedTitle}</CardTitle>
            <CardDescription>{t.detectedHint}</CardDescription>
          </CardHeader>
          {view.detected.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="subscriptions-detected-empty">
              {t.detectedEmpty}
            </p>
          ) : (
            <ul
              className="flex flex-col divide-y divide-border text-sm"
              data-testid="subscriptions-detected"
            >
              {view.detected.map((d) => (
                <li
                  key={d.signature}
                  className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                >
                  <span>
                    <span className="font-medium">{d.merchant ?? d.description}</span>
                    <span className="ml-2 text-muted-foreground">
                      {ro.recurring.frequencies[d.frequency]} ·{" "}
                      {t.detectedLine(d.occurrences, formatDate(d.lastOn))} · {d.accountName}
                    </span>
                  </span>
                  <span className="font-mono tabular-nums">
                    {formatMinor(d.amountMinor, d.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
