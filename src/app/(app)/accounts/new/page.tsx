import type { Metadata } from "next";

import { Card } from "@/components/ui/card";
import { ACCOUNT_TYPES, DB_CURRENCIES } from "@/db/schema";
import { ro } from "@/messages/ro";

import { requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";
import { AccountForm } from "../account-form";

export const metadata: Metadata = { title: ro.accounts.newTitle };

export default async function NewAccountPage() {
  const page = await requireLedgerPage("/accounts/new");
  return (
    <>
      <PageHeader
        eyebrow={ro.accounts.title}
        title={ro.accounts.newTitle}
        usageStats={page.usageStats}
      />
      {page.householdId ? (
        <AccountForm
          types={ACCOUNT_TYPES}
          currencies={DB_CURRENCIES}
          meUserId={page.actor.userId}
        />
      ) : (
        <Card>
          <p className="text-muted-foreground">{ro.ledger.noHousehold}</p>
        </Card>
      )}
    </>
  );
}
