import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { formOptions } from "../../../_lib/ledger-options";
import { todayIn } from "../../../_lib/ledger-ui";
import { PageHeader } from "../../page-header";
import { TransactionForm } from "../transaction-form";

export const metadata: Metadata = { title: ro.transactions.newExpense };

export default async function NewTransactionPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const page = await requireLedgerPage("/transactions/new");
  const { type: rawType } = await searchParams;
  const type = rawType === "income" ? "income" : "expense";
  const title = type === "income" ? ro.transactions.newIncome : ro.transactions.newExpense;
  const header = (
    <PageHeader eyebrow={ro.transactions.title} title={title} usageStats={page.usageStats} />
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
      {options.value.accounts.length === 0 ? (
        <Card>
          <p className="text-muted-foreground">{ro.transactions.noAccounts}</p>
        </Card>
      ) : (
        <TransactionForm
          initialType={type}
          accounts={options.value.accounts}
          categories={options.value.categories}
          tags={options.value.tags}
          today={todayIn()}
        />
      )}
    </>
  );
}
