import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { ro } from "@/messages/ro";
import { isValidId } from "@/modules/ledger/input";
import { receiptIdsForTransactions } from "@/modules/receipts/receipts.service";
import { getTransactionTagIds } from "@/modules/tags/tags.service";
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
    const tagIds =
      tx.type === "transfer" ? [] : await getTransactionTagIds({ db }, page.actor, householdId, id);
    const options = await formOptions(db, page.actor, householdId, {
      accountId: tx.accountId,
      categoryId: tx.categoryId,
      tagIds,
    });
    const transfer =
      tx.type === "transfer" && tx.transferGroupId
        ? transferToJson(await getTransfer({ db }, page.actor, householdId, tx.transferGroupId))
        : null;
    // Faza 6: tranzacția creată dintr-un bon are legătura spre ecranul bonului.
    const receiptId =
      tx.source === "receipt"
        ? ((await receiptIdsForTransactions({ db }, page.actor, householdId, [tx.id])).get(tx.id) ??
          null)
        : null;
    return { tx, options, transfer, tagIds, receiptId };
  });
  if (!result.ok) {
    return (
      <>
        <PageHeader title={ro.transactions.editTitle} usageStats={page.usageStats} />
        <Alert>{ro.ledger.loadError}</Alert>
      </>
    );
  }
  const { tx, options, transfer, tagIds, receiptId } = result.value;
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
        actions={
          receiptId ? (
            <Link
              href={`/receipts/${receiptId}`}
              className={buttonClasses("outline")}
              data-testid="transaction-receipt-link"
            >
              {ro.transactions.viewReceipt}
            </Link>
          ) : undefined
        }
      />
      <TransactionForm
        transaction={tx}
        initialType={tx.type === "income" ? "income" : "expense"}
        accounts={options.accounts}
        categories={options.categories}
        tags={options.tags}
        initialTagIds={tagIds}
        today={todayIn()}
      />
    </>
  );
}
