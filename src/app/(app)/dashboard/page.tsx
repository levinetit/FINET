import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { accountToJson, currencyTotalToJson } from "@/modules/accounts/accounts.schema";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { getMe } from "@/modules/profile/profile.service";
import { transactionToJson } from "@/modules/transactions/transactions.schema";
import { listTransactions } from "@/modules/transactions/transactions.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { formatCalendarDate, formatMinor, formatSigned } from "../../_lib/ledger-ui";
import { AccountsList, CurrencyTotals } from "../accounts/accounts-list";
import { PageHeader } from "../page-header";

export const metadata: Metadata = { title: ro.dashboard.title };

/**
 * Acasă: dashboard-ul real vine în Faza 3 (placeholder onest). Până atunci: soldurile conturilor
 * active, totalurile pe monedă (fără conversie) și ultimele 5 tranzacții, citite din servicii pe
 * server. Fără grafice sau bugete.
 */
export default async function DashboardPage() {
  const page = await requireLedgerPage("/dashboard");
  const { db } = page.session.runtime;
  const me = await getMe(db, page.actor.userId);
  const householdId = page.householdId;
  const ledger = householdId
    ? await load(async () => {
        const deps = { db };
        const [accounts, recent] = await Promise.all([
          listAccounts(deps, page.actor, householdId),
          listTransactions(deps, page.actor, householdId, { limit: 5 }),
        ]);
        return {
          accounts: accounts.accounts.map(accountToJson),
          totals: accounts.totals.map(currencyTotalToJson),
          recent: recent.data.map(transactionToJson),
        };
      })
    : null;
  const accountName = new Map(
    ledger?.ok ? ledger.value.accounts.map((a) => [a.id, a.name] as const) : [],
  );

  return (
    <>
      <PageHeader
        eyebrow={me.household?.name}
        title={ro.dashboard.title}
        usageStats={page.usageStats}
      />
      <div className="flex flex-col gap-4">
        <Card>
          <CardTitle>{ro.dashboard.greeting(me.user.name)}</CardTitle>
          <CardDescription className="mt-2">{ro.dashboard.placeholder}</CardDescription>
        </Card>
        {ledger && !ledger.ok ? <Alert>{ro.dashboard.loadError}</Alert> : null}
        {ledger?.ok ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card aria-labelledby="balances-title">
              <CardHeader>
                <CardTitle id="balances-title">{ro.dashboard.balancesTitle}</CardTitle>
              </CardHeader>
              <div className="flex flex-col gap-4">
                <CurrencyTotals totals={ledger.value.totals} />
                {ledger.value.accounts.length > 0 ? (
                  <AccountsList accounts={ledger.value.accounts} testId="dashboard-accounts" />
                ) : null}
                <Link href="/accounts" className="text-sm font-medium text-primary hover:underline">
                  {ro.dashboard.seeAllAccounts}
                </Link>
              </div>
            </Card>
            <Card aria-labelledby="recent-title">
              <CardHeader>
                <CardTitle id="recent-title">{ro.dashboard.recentTitle}</CardTitle>
              </CardHeader>
              {ledger.value.recent.length === 0 ? (
                <p className="text-muted-foreground">{ro.dashboard.recentEmpty}</p>
              ) : (
                <ul
                  className="flex flex-col divide-y divide-border"
                  data-testid="recent-transactions"
                >
                  {ledger.value.recent.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {r.description ?? r.merchant ?? ro.ledger.types[r.type]}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {formatCalendarDate(r.occurredOn)} · {accountName.get(r.accountId) ?? "—"}
                        </span>
                      </span>
                      <span className="font-mono whitespace-nowrap tabular-nums">
                        {r.type === "transfer"
                          ? formatMinor(r.amountMinor, r.currency)
                          : formatSigned(r.type, r.amountMinor, r.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link
                href="/transactions"
                className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
              >
                {ro.dashboard.seeAllTransactions}
              </Link>
            </Card>
          </div>
        ) : null}
        <Card aria-labelledby="household-title">
          <h2 id="household-title" className="sr-only">
            {ro.dashboard.household}
          </h2>
          {me.household ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">{ro.dashboard.household}</dt>
                <dd className="font-semibold" data-testid="household-name">
                  {me.household.name}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{ro.dashboard.role}</dt>
                <dd className="font-semibold" data-testid="household-role">
                  {ro.dashboard.roles[me.household.role] ?? me.household.role}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground">{ro.dashboard.noHousehold}</p>
          )}
        </Card>
      </div>
    </>
  );
}
