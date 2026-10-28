import "server-only";

import { randomUUID } from "node:crypto";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ValidationError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput, resolvePositiveAmount } from "@/modules/ledger/input";
import {
  type TransactionRow,
  deleteTransactionRows,
  insertTransactionRow,
  selectTransferGroup,
  updateTransactionRow,
} from "@/modules/transactions/transactions.repo";
import { requireOpenAccount } from "@/modules/transactions/transactions.service";

import { type TransferView, transferCreateSchema, transferUpdateSchema } from "./transfers.schema";

/**
 * Transferuri ATOMICE (5.1): ambele rânduri se scriu în aceeași tranzacție SQL; orice eroare
 * (inclusiv pe al doilea rând) le anulează pe amândouă. Baza verifică la COMMIT că grupul e
 * complet și coerent (constraint trigger `transactions_transfer_group_valid`, 0002_ledger.sql).
 * Transferurile nu intră în totalurile de venituri/cheltuieli (`signedAmount` = 0), doar în
 * soldurile conturilor (intrare +, ieșire −).
 */

type Amounts = {
  amountMinor?: number;
  amount?: string;
  amountFromMinor?: number;
  amountToMinor?: number;
};

/** Sumele celor două rânduri, după regula monedelor. */
function resolveLegAmounts(
  input: Amounts,
  fromCurrency: Currency,
  toCurrency: Currency,
): { from: bigint; to: bigint } {
  if (fromCurrency === toCurrency) {
    if (input.amountFromMinor !== undefined || input.amountToMinor !== undefined) {
      if (input.amountFromMinor === undefined || input.amountFromMinor !== input.amountToMinor) {
        throw new ValidationError({
          amountMinor: "În aceeași monedă, transferul are o singură sumă.",
        });
      }
      const value = resolvePositiveAmount({ amountMinor: input.amountFromMinor }, fromCurrency);
      return { from: value, to: value };
    }
    const value = resolvePositiveAmount(input, fromCurrency);
    return { from: value, to: value };
  }
  if (input.amountFromMinor === undefined || input.amountToMinor === undefined) {
    throw new ValidationError({
      amountToMinor:
        "Pentru monede diferite trimite ambele sume (amountFromMinor și amountToMinor).",
    });
  }
  return {
    from: resolvePositiveAmount(
      { amountMinor: input.amountFromMinor },
      fromCurrency,
      "amountFromMinor",
    ),
    to: resolvePositiveAmount({ amountMinor: input.amountToMinor }, toCurrency, "amountToMinor"),
  };
}

function toView(rows: readonly TransactionRow[]): TransferView {
  const out = rows.find((r) => r.transferDirection === "out");
  const inn = rows.find((r) => r.transferDirection === "in");
  if (!out || !inn || rows.length !== 2) throw new NotFoundError();
  const leg = (r: TransactionRow) => ({
    transactionId: r.id,
    accountId: r.accountId,
    amountMinor: r.amountMinor,
    currency: r.currency,
  });
  return {
    id: out.transferGroupId!,
    from: leg(out),
    to: leg(inn),
    occurredOn: out.occurredOn,
    description: out.description,
    notes: out.notes,
    createdByUserId: out.createdByUserId,
    createdAt: out.createdAt,
  };
}

export async function createTransfer(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<TransferView> {
  const input = parseInput(transferCreateSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const from = await requireOpenAccount(tx, m.householdId, input.fromAccountId, "fromAccountId");
    const to = await requireOpenAccount(tx, m.householdId, input.toAccountId, "toAccountId");
    const amounts = resolveLegAmounts(input, from.currency, to.currency);
    const groupId = randomUUID();
    const common = {
      householdId: m.householdId,
      createdByUserId: actor.userId,
      type: "transfer" as const,
      occurredOn: input.occurredOn,
      description: input.description ?? null,
      notes: input.notes ?? null,
      source: "manual" as const,
      transferGroupId: groupId,
    };
    const out = await insertTransactionRow(tx, {
      ...common,
      accountId: from.id,
      currency: from.currency,
      amountMinor: amounts.from,
      transferDirection: "out",
    });
    const inn = await insertTransactionRow(tx, {
      ...common,
      accountId: to.id,
      currency: to.currency,
      amountMinor: amounts.to,
      transferDirection: "in",
    });
    return toView([out, inn]);
  });
}

async function loadGroup(tx: Tx, householdId: string, groupId: string, lock = false) {
  const rows = await selectTransferGroup(tx, householdId, groupId, lock);
  if (rows.length === 0) throw new NotFoundError();
  return rows;
}

export async function getTransfer(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transferId: string,
): Promise<TransferView> {
  if (!isValidId(transferId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) =>
    toView(await loadGroup(tx, m.householdId, transferId.toLowerCase())),
  );
}

/** Modifică sumele, data sau textele; conturile unui transfer nu se schimbă (se recreează). */
export async function updateTransfer(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transferId: string,
  rawPatch: unknown,
): Promise<TransferView> {
  if (!isValidId(transferId)) throw new NotFoundError();
  const patch = parseInput(transferUpdateSchema, rawPatch);
  const groupId = transferId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = toView(await loadGroup(tx, m.householdId, groupId, true));
    const hasAmount =
      patch.amountMinor !== undefined ||
      patch.amount !== undefined ||
      patch.amountFromMinor !== undefined ||
      patch.amountToMinor !== undefined;
    const amounts = hasAmount
      ? resolveLegAmounts(patch, current.from.currency, current.to.currency)
      : null;
    const common = {
      occurredOn: patch.occurredOn,
      description: patch.description,
      notes: patch.notes,
    };
    await updateTransactionRow(tx, m.householdId, current.from.transactionId, {
      ...common,
      amountMinor: amounts?.from,
    });
    await updateTransactionRow(tx, m.householdId, current.to.transactionId, {
      ...common,
      amountMinor: amounts?.to,
    });
    return toView(await loadGroup(tx, m.householdId, groupId));
  });
}

/** Șterge ambele rânduri ale transferului (definitiv, cu audit fără sume). */
export async function deleteTransfer(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transferId: string,
): Promise<void> {
  if (!isValidId(transferId)) throw new NotFoundError();
  const groupId = transferId.toLowerCase();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    await loadGroup(tx, m.householdId, groupId, true);
    await deleteTransactionRows(tx, m.householdId, { transferGroupId: groupId });
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "transfer.deleted",
      targetType: "transfer",
      targetId: groupId,
    });
  });
}
