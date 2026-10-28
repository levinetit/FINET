import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";
import { todayLocal } from "@/modules/recurring/recurring.service";

import { formOptions } from "../../../_lib/ledger-options";
import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";
import { RecurringForm } from "../recurring-form";

export const metadata: Metadata = { title: ro.recurring.newTitle };

/** O regulă recurentă nouă: doar conturile active și categoriile vizibile. */
export default async function NewRecurringPage() {
  const page = await requireLedgerPage("/recurring/new");
  const header = (
    <PageHeader
      eyebrow={ro.recurring.title}
      title={ro.recurring.newTitle}
      usageStats={page.usageStats}
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
  const result = await load(() => formOptions(page.session.runtime.db, page.actor, householdId));
  if (!result.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { accounts, categories } = result.value;
  return (
    <>
      {header}
      {accounts.length === 0 ? (
        <Card>
          <p className="text-muted-foreground">{ro.recurring.noAccounts}</p>
          <Link href="/accounts" className={buttonClasses("outline")}>
            {ro.nav.accounts}
          </Link>
        </Card>
      ) : (
        <RecurringForm accounts={accounts} categories={categories} today={todayLocal()} />
      )}
    </>
  );
}
