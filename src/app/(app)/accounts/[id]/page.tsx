import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { ACCOUNT_TYPES, DB_CURRENCIES } from "@/db/schema";
import { isValidId } from "@/modules/ledger/input";
import { ro } from "@/messages/ro";
import { accountToJson } from "@/modules/accounts/accounts.schema";
import { getAccount } from "@/modules/accounts/accounts.service";
import { isValuedType } from "@/modules/net-worth/net-worth";
import { valuationToJson } from "@/modules/net-worth/net-worth.schema";
import { listValuations } from "@/modules/net-worth/net-worth.service";
import { listTransactions } from "@/modules/transactions/transactions.service";

import { formatMinor } from "../../../_lib/ledger-ui";
import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";
import { AccountForm } from "../account-form";

import { AccountActions } from "./account-actions";
import { ValuationsPanel } from "./valuations-panel";

export const metadata: Metadata = { title: ro.accounts.editTitle };

/**
 * Pagina unui cont: editare, arhivare/dezarhivare, ștergere (doar pentru un cont fără
 * tranzacții). Un id invalid, inexistent sau din altă gospodărie → 404 uniform.
 */
export default async function AccountPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/accounts/${id}`);
  if (!isValidId(id) || !page.householdId) notFound();
  const householdId = page.householdId;
  const deps = { db: page.session.runtime.db };
  const result = await load(async () => {
    const account = await getAccount(deps, page.actor, householdId, id);
    const used = await listTransactions(deps, page.actor, householdId, {
      accountId: account.id,
      limit: 1,
    });
    // ADR 0046: evaluările, doar pentru conturile evaluate (investiții, proprietăți, credite…).
    const valuations = isValuedType(account.type)
      ? (await listValuations(deps, page.actor, householdId, account.id)).map(valuationToJson)
      : null;
    return { account: accountToJson(account), empty: used.data.length === 0, valuations };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader title={ro.accounts.editTitle} usageStats={page.usageStats} />
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { account, empty, valuations } = result.value;
  return (
    <>
      <PageHeader
        eyebrow={`${ro.accounts.balance}: ${formatMinor(account.balanceMinor, account.currency)}`}
        title={account.name}
        usageStats={page.usageStats}
      />
      <div className="flex flex-col gap-4">
        <AccountForm
          account={account}
          types={ACCOUNT_TYPES}
          currencies={DB_CURRENCIES}
          currencyLocked={!empty}
          meUserId={page.actor.userId}
        />
        <AccountActions id={account.id} archived={account.archived} empty={empty} />
        {valuations ? (
          <ValuationsPanel
            accountId={account.id}
            currency={account.currency}
            valuations={valuations}
          />
        ) : null}
      </div>
    </>
  );
}
