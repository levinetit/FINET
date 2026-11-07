import type { Metadata } from "next";
import Link from "next/link";

import { ForecastChart } from "@/components/planning/forecast-chart";
import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ro } from "@/messages/ro";
import { type NetWorthJson, netWorthViewToJson } from "@/modules/net-worth/net-worth.schema";
import { getNetWorth } from "@/modules/net-worth/net-worth.service";

import { chartPoints } from "../../_lib/forecast-ui";
import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatMinor } from "../../_lib/ledger-ui";
import { formatDate } from "../../_lib/planning-ui";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.netWorth.title };

function CurrencyNetWorth({ n }: Readonly<{ n: NetWorthJson }>) {
  const t = ro.netWorth;
  const c = n.currency;
  const chart = chartPoints(
    n.history.map((p) => ({ date: p.asOf, balanceMinor: p.netMinor, scheduledMinor: 0 })),
  );
  return (
    <Card aria-labelledby={`net-worth-${c}`} data-testid={`net-worth-${c}`}>
      <CardHeader>
        <CardTitle id={`net-worth-${c}`}>{c}</CardTitle>
        <CardDescription>{t.asOf(formatDate(n.asOf))}</CardDescription>
      </CardHeader>
      <dl className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-md bg-surface-2 px-4 py-3">
          <dt className="text-sm text-muted-foreground">{t.assets}</dt>
          <dd
            className="font-mono text-xl font-semibold tabular-nums"
            data-testid="net-worth-assets"
          >
            {formatMinor(n.current.assetsMinor, c)}
          </dd>
        </div>
        <div className="rounded-md bg-surface-2 px-4 py-3">
          <dt className="text-sm text-muted-foreground">{t.liabilities}</dt>
          <dd
            className="font-mono text-xl font-semibold tabular-nums"
            data-testid="net-worth-liabilities"
          >
            {formatMinor(n.current.liabilitiesMinor, c)}
          </dd>
        </div>
        <div className="rounded-md bg-surface-2 px-4 py-3">
          <dt className="text-sm text-muted-foreground">{t.net}</dt>
          <dd
            className={cn(
              "font-mono text-xl font-semibold tabular-nums",
              n.current.netMinor < 0 ? "text-bad" : "text-ok",
            )}
            data-testid="net-worth-net"
          >
            {formatMinor(n.current.netMinor, c)}
          </dd>
        </div>
      </dl>

      <h3 className="mb-2 text-sm font-semibold">{t.historyTitle}</h3>
      <ForecastChart points={chart.points} currency={c} zeroY={chart.zeroY} />

      <h3 className="mt-5 mb-2 text-sm font-semibold">{t.byTypeTitle}</h3>
      <ul className="flex flex-col gap-3" data-testid="net-worth-by-type">
        {n.byType.map((b) => (
          <li key={b.type} className="rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-medium">
                {ro.ledger.accountTypes[b.type] ?? b.type}
                <span className="ml-2 text-xs text-muted-foreground">{t.kinds[b.kind]}</span>
              </span>
              <span className="font-mono tabular-nums">{formatMinor(b.valueMinor, c)}</span>
            </div>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground">
              {b.accounts.map((a) => (
                <li key={a.accountId} className="flex flex-wrap justify-between gap-x-3">
                  <Link href={`/accounts/${a.accountId}`} className="underline">
                    {a.name}
                    {a.archived ? ` · ${t.archived}` : ""}
                  </Link>
                  <span className="font-mono tabular-nums">
                    {formatMinor(a.valueMinor, c)}
                    <span className="ml-1 text-xs">
                      (
                      {a.basis === "valuation" && a.valuedOn
                        ? t.valuedOn(formatDate(a.valuedOn))
                        : t.basis[a.basis]}
                      )
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">{t.addValuationHint}</p>
    </Card>
  );
}

/**
 * Averea netă (modernizare 2026, pasul G; ADR 0046): câte un card pe monedă cu activele, pasivele
 * și averea netă de azi, evoluția lunară (SVG) și defalcarea pe tipuri de cont cu baza fiecărei
 * valori (sold sau evaluare). Citiri pe server, prin serviciu.
 */
export default async function NetWorthPage() {
  const page = await requireLedgerPage("/net-worth");
  const t = ro.netWorth;
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
  const data = await load(async () =>
    netWorthViewToJson(await getNetWorth({ db: page.session.runtime.db }, page.actor, householdId)),
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
            <p className="text-muted-foreground" data-testid="net-worth-empty">
              {t.noData}
            </p>
          </Card>
        ) : (
          view.currencies.map((n) => <CurrencyNetWorth key={n.currency} n={n} />)
        )}
      </div>
    </>
  );
}
