import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { DB_CURRENCIES } from "@/db/schema";
import { ro } from "@/messages/ro";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { getMe } from "@/modules/profile/profile.service";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";
import { GoalForm } from "../goal-form";

export const metadata: Metadata = { title: ro.goals.newTitle };

export default async function NewGoalPage() {
  const page = await requireLedgerPage("/goals/new");
  const header = (
    <PageHeader eyebrow={ro.goals.title} title={ro.goals.newTitle} usageStats={page.usageStats} />
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
  const { db } = page.session.runtime;
  const result = await load(async () => {
    const [accounts, me] = await Promise.all([
      listAccounts({ db }, page.actor, householdId),
      getMe(db, page.actor.userId),
    ]);
    return {
      accounts: accounts.accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
      currency: me.household?.defaultCurrency ?? me.preferences.defaultCurrency,
    };
  });
  return (
    <>
      {header}
      {result.ok ? (
        <GoalForm
          accounts={result.value.accounts}
          currencies={DB_CURRENCIES}
          defaultCurrency={result.value.currency}
        />
      ) : (
        <Alert>{ro.ledger.loadError}</Alert>
      )}
    </>
  );
}
