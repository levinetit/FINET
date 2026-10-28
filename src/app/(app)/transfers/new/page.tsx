import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { formOptions } from "../../../_lib/ledger-options";
import { todayIn } from "../../../_lib/ledger-ui";
import { PageHeader } from "../../page-header";

import { TransferForm } from "./transfer-form";

export const metadata: Metadata = { title: ro.transfers.title };

export default async function NewTransferPage() {
  const page = await requireLedgerPage("/transfers/new");
  const header = (
    <PageHeader
      eyebrow={ro.transactions.title}
      title={ro.transfers.title}
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
  const options = await load(() => formOptions(page.session.runtime.db, page.actor, householdId));
  if (!options.ok) {
    return (
      <>
        {header}
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  return (
    <>
      {header}
      {options.value.accounts.length < 2 ? (
        <Card>
          <p className="text-muted-foreground">{ro.transfers.needTwoAccounts}</p>
        </Card>
      ) : (
        <TransferForm accounts={options.value.accounts} today={todayIn()} />
      )}
    </>
  );
}
