import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { ro } from "@/messages/ro";
import { isValidId } from "@/modules/ledger/input";
import { transactionToJson } from "@/modules/transactions/transactions.schema";
import { getTransaction } from "@/modules/transactions/transactions.service";
import { transferToJson } from "@/modules/transfers/transfers.schema";
import { getTransfer } from "@/modules/transfers/transfers.service";

import { load, requireLedgerPage } from "../../../_lib/ledger-page";
import { formOptions } from "../../../_lib/ledger-options";
import { todayIn } from "../../../_lib/ledger-ui";
import { PageHeader } from "../../page-header";
import { TransactionForm } from "../transaction-form";

import { TransferDetails } from "./transfer-details";

export const metadata: Metadata = { title: ro.transactions.editTitle };

/**
 * O tranzacție: venitul/cheltuiala se editează și se șterge; un rând de transfer arată ambele
 * conturi și se șterge ca transfer (ambele rânduri). Id invalid, inexistent sau străin → 404.
 */
export default async function TransactionPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const page = await requireLedgerPage(`/transactions/${id}`);
  if (!isValidId(id) || !page.householdId) notFound();
  const householdId = page.householdId;
  const { db } = page.session.runtime;
  const result = await load(async () => {
    const tx = transactionToJson(await getTransaction({ db }, page.actor, householdId, id));
    const options = await formOptions(db, page.actor, householdId, {
      accountId: tx.accountId,
      categoryId: tx.categoryId,
    });
    const transfer =
      tx.type === "transfer" && tx.transferGroupId
        ? transferToJson(await getTransfer({ db }, page.actor, householdId, tx.transferGroupId))
        : null;
    return { tx, options, transfer };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader title={ro.transactions.editTitle} usageStats={page.usageStats} />
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { tx, options, transfer } = result.value;
  if (transfer) {
    const name = (accountId: string) =>
      options.allAccounts.find((a) => a.id === accountId)?.name ?? "—";
    return (
      <>
        <PageHeader
          eyebrow={ro.transactions.title}
          title={ro.transfers.detailsTitle}
          usageStats={page.usageStats}
        />
        <TransferDetails
          transfer={transfer}
          fromName={name(transfer.from.accountId)}
          toName={name(transfer.to.accountId)}
        />
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow={ro.transactions.title}
        title={ro.transactions.editTitle}
        usageStats={page.usageStats}
      />
      <TransactionForm
        transaction={tx}
        initialType={tx.type === "income" ? "income" : "expense"}
        accounts={options.accounts}
        categories={options.categories}
        today={todayIn()}
      />
    </>
  );
}
