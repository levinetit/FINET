import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import {
  type AccountJson,
  accountToJson,
  currencyTotalToJson,
} from "@/modules/accounts/accounts.schema";
import { listAccounts } from "@/modules/accounts/accounts.service";

import { requireLedgerPage, load } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { AccountsList, CurrencyTotals } from "./accounts-list";

export const metadata: Metadata = { title: ro.accounts.title };

export default async function AccountsPage() {
  const page = await requireLedgerPage("/accounts");
  const header = (
    <PageHeader
      eyebrow={ro.accounts.eyebrow}
      title={ro.accounts.title}
      usageStats={page.usageStats}
      actions={
        page.householdId ? (
          <Link href="/accounts/new" className={buttonClasses()}>
            {ro.accounts.add}
          </Link>
        ) : null
      }
    />
  );
  if (!page.householdId) {
    return (
      <>
        {header}
        <Card>
          <p className="text-muted-foreground">{ro.ledger.noHousehold}</p>
        </Card>
      </>
    );
  }
  const householdId = page.householdId;
  const result = await load(() =>
    listAccounts({ db: page.session.runtime.db }, page.actor, householdId, {
      includeArchived: true,
    }),
  );
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const accounts: AccountJson[] = result.value.accounts.map(accountToJson);
  // Totalurile serviciului: doar conturile active, separat pe monedă (fără conversie).
  const totals = result.value.totals.map(currencyTotalToJson);
  const active = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <Card aria-labelledby="totals-title">
          <CardHeader>
            <CardTitle id="totals-title">{ro.accounts.totals}</CardTitle>
            <CardDescription>{ro.accounts.totalsHint}</CardDescription>
          </CardHeader>
          <CurrencyTotals totals={totals} />
        </Card>
        <Card aria-labelledby="active-title">
          <CardHeader>
            <CardTitle id="active-title">{ro.accounts.active}</CardTitle>
          </CardHeader>
          {active.length === 0 ? (
            <p className="text-muted-foreground">{ro.accounts.empty}</p>
          ) : (
            <AccountsList accounts={active} testId="active-accounts" />
          )}
        </Card>
        <Card aria-labelledby="archived-title">
          <CardHeader>
            <CardTitle id="archived-title">{ro.accounts.archived}</CardTitle>
          </CardHeader>
          {archived.length === 0 ? (
            <p className="text-muted-foreground">{ro.accounts.archivedEmpty}</p>
          ) : (
            <AccountsList accounts={archived} testId="archived-accounts" />
          )}
        </Card>
      </div>
    </>
  );
}
