import "server-only";

import { and, eq } from "drizzle-orm";

import type { Tx } from "@/db";
import { transactionSplits } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { selectAccount } from "@/modules/accounts/accounts.repo";
import { selectCategory } from "@/modules/categories/categories.repo";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput, resolvePositiveAmount } from "@/modules/ledger/input";
import { assertAccountsWithinJsonRange } from "@/modules/ledger/range-guard";
import { applyTransactionTags } from "@/modules/tags/tags.service";

import {
  type ListFilters,
  type TransactionRow,
  deleteTransactionRows,
  insertTransactionRow,
  selectTransaction,
  selectTransactionPage,
  updateTransactionRow,
} from "./transactions.repo";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type TransactionListQuery,
  type TransactionPage,
  type TransactionView,
  decodeCursor,
  encodeCursor,
  transactionCreateSchema,
  transactionListSchema,
  transactionUpdateSchema,
} from "./transactions.schema";

/**
 * Venituri și cheltuieli (Faza 2): creare, modificare, ștergere definitivă cu audit fără sume
 * (5.6), listare cu căutare, filtre, sortare și paginare cu cursor. Transferurile au serviciul lor
 * (`src/modules/transfers`); un rând de transfer nu se modifică de aici, iar ștergerea lui
 * șterge tot grupul.
 */

export function toView(row: TransactionRow): TransactionView {
  return {
    id: row.id,
    accountId: row.accountId,
    categoryId: row.categoryId,
    type: row.type,
    amountMinor: row.amountMinor,
    currency: row.currency,
    occurredOn: row.occurredOn,
    description: row.description,
    merchant: row.merchant,
    notes: row.notes,
    source: row.source,
    transferGroupId: row.transferGroupId,
    transferDirection: row.transferDirection,
    recurringRuleId: row.recurringRuleId,
    documentId: row.documentId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function hasSplits(tx: Tx, householdId: string, transactionId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: transactionSplits.id })
    .from(transactionSplits)
    .where(
      and(
        eq(transactionSplits.householdId, householdId),
        eq(transactionSplits.transactionId, transactionId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Contul: din gospodărie (altfel 404), nearhivat dacă primește o tranzacție nouă. */
export async function requireOpenAccount(tx: Tx, householdId: string, accountId: string) {
  const account = await selectAccount(tx, householdId, accountId);
  // Inexistent sau al altei gospodării (invizibil sub RLS): același 404 uniform.
  if (!account) throw new NotFoundError();
  if (account.archivedAt) {
    throw new ConflictError("account_archived", "Contul e arhivat și nu mai primește tranzacții.");
  }
  return account;
}

async function checkCategory(
  tx: Tx,
  householdId: string,
  categoryId: string | null | undefined,
  type: "income" | "expense",
): Promise<void> {
  if (!categoryId) return;
  const category = await selectCategory(tx, householdId, categoryId);
  if (!category) throw new NotFoundError();
  if (category.kind !== type) {
    throw new ValidationError({ categoryId: "Categoria are alt tip decât tranzacția." });
  }
}

export async function createTransaction(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<TransactionView> {
  const input = parseInput(transactionCreateSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const account = await requireOpenAccount(tx, m.householdId, input.accountId);
    const amountMinor = resolvePositiveAmount(input, account.currency);
    await checkCategory(tx, m.householdId, input.categoryId, input.type);
    const row = await insertTransactionRow(tx, {
      householdId: m.householdId,
      accountId: account.id,
      categoryId: input.categoryId ?? null,
      createdByUserId: actor.userId,
      type: input.type,
      amountMinor,
      currency: account.currency,
      occurredOn: input.occurredOn,
      description: input.description ?? null,
      merchant: input.merchant ?? null,
      notes: input.notes ?? null,
      source: "manual",
    });
    await assertAccountsWithinJsonRange(tx, m.householdId, [row.accountId]);
    if (input.tagIds && input.tagIds.length > 0) {
      await applyTransactionTags(tx, m.householdId, row.id, input.tagIds);
    }
    return toView(row);
  });
}

export async function getTransaction(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
): Promise<TransactionView> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const row = await selectTransaction(tx, m.householdId, transactionId.toLowerCase());
    if (!row) throw new NotFoundError();
    return toView(row);
  });
}

export async function updateTransaction(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
  rawPatch: unknown,
): Promise<TransactionView> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  const patch = parseInput(transactionUpdateSchema, rawPatch);
  const id = transactionId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectTransaction(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (current.type === "transfer") {
      throw new ConflictError(
        "transfer_row",
        "Un transfer se modifică prin serviciul de transferuri.",
      );
    }
    // Faza 8: o cheltuială împărțită între membri are suma părților = totalul (verificat și la
    // COMMIT în bază). Suma, contul sau tipul nu se schimbă cât timp împărțirea există.
    const touchesTotal =
      patch.amountMinor !== undefined ||
      patch.amount !== undefined ||
      (patch.accountId !== undefined && patch.accountId !== current.accountId) ||
      (patch.type !== undefined && patch.type !== current.type);
    if (touchesTotal && (await hasSplits(tx, m.householdId, id))) {
      throw new ConflictError(
        "transaction_split",
        "Tranzacția e împărțită între membri: modifică întâi împărțirea.",
      );
    }
    let currency = current.currency;
    let accountId = current.accountId;
    if (patch.accountId && patch.accountId !== current.accountId) {
      const account = await requireOpenAccount(tx, m.householdId, patch.accountId);
      accountId = account.id;
      currency = account.currency;
    }
    // Mutarea pe un cont în altă monedă fără sumă explicită ar reinterpreta suma (100 RON → 100
    // EUR): se cere suma nouă (revizuirea F2, LOW-1).
    if (
      currency !== current.currency &&
      patch.amountMinor === undefined &&
      patch.amount === undefined
    ) {
      throw new ConflictError(
        "currency_change_requires_amount",
        "Contul nou are altă monedă: trimite și suma în moneda lui.",
      );
    }
    const type = patch.type ?? current.type;
    const categoryId = patch.categoryId === undefined ? current.categoryId : patch.categoryId;
    if (patch.categoryId !== undefined || patch.type !== undefined) {
      await checkCategory(tx, m.householdId, categoryId, type);
    }
    const amountMinor =
      patch.amountMinor !== undefined || patch.amount !== undefined
        ? resolvePositiveAmount(patch, currency)
        : undefined;
    const row = await updateTransactionRow(tx, m.householdId, id, {
      accountId,
      currency,
      type,
      categoryId,
      amountMinor,
      occurredOn: patch.occurredOn,
      description: patch.description,
      merchant: patch.merchant,
      notes: patch.notes,
    });
    if (!row) throw new NotFoundError();
    // Doar contul care primește (sau păstrează) rândul poate crește; cel vechi doar scade.
    if (amountMinor !== undefined || accountId !== current.accountId) {
      await assertAccountsWithinJsonRange(tx, m.householdId, [row.accountId]);
    }
    if (patch.tagIds !== undefined) await applyTransactionTags(tx, m.householdId, id, patch.tagIds);
    return toView(row);
  });
}

/**
 * Ștergere definitivă (5.6), cu `audit_event` fără sume sau descrieri. Pentru un rând de transfer
 * se șterge tot grupul (ambele rânduri), ca soldurile să rămână coerente.
 */
export async function deleteTransaction(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
): Promise<void> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  const id = transactionId.toLowerCase();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectTransaction(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (current.transferGroupId) {
      await deleteTransactionRows(tx, m.householdId, { transferGroupId: current.transferGroupId });
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "transfer.deleted",
        targetType: "transfer",
        targetId: current.transferGroupId,
      });
      return;
    }
    await deleteTransactionRows(tx, m.householdId, { id });
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "transaction.deleted",
      targetType: "transaction",
      targetId: id,
      metadata: { type: current.type },
    });
  });
}

/** Filtrele repo-ului din interogarea validată (lista și exportul CSV folosesc aceleași). */
export function listFiltersOf(query: NonNullable<TransactionListQuery>): ListFilters {
  return {
    q: query.q || undefined,
    accountId: query.accountId,
    categoryId: query.categoryId,
    tagIds: query.tagIds,
    tagMatch: query.tagMatch,
    merchant: query.merchant || undefined,
    type: query.type,
    source: query.source,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    amountMinMinor: query.amountMinMinor === undefined ? undefined : BigInt(query.amountMinMinor),
    amountMaxMinor: query.amountMaxMinor === undefined ? undefined : BigInt(query.amountMaxMinor),
  };
}

/**
 * Lista paginată. `limit` lipsă = 50, peste 100 se reduce la 100. Cursorul e legat de sortare: un
 * cursor creat pentru altă sortare e respins. Ordinea e stabilă: `(cheie, id)`.
 */
export async function listTransactions(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<TransactionPage> {
  const query = parseInput(transactionListSchema, rawQuery) ?? {};
  const sort = query.sort ?? "date_desc";
  const cursor = query.cursor ? decodeCursor(query.cursor, sort) : null;
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await selectTransactionPage(
      tx,
      m.householdId,
      listFiltersOf(query),
      sort,
      cursor,
      limit,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({
            sort,
            key: sort.startsWith("date_") ? last.occurredOn : last.amountMinor.toString(),
            id: last.id,
          })
        : null;
    return { data: page.map(toView), nextCursor };
  });
}
