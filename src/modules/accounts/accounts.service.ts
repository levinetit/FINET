import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { type Currency, add, money, sub, zero } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput, resolveAmount } from "@/modules/ledger/input";
import { assertAccountsWithinJsonRange } from "@/modules/ledger/range-guard";

import {
  type AccountRow,
  accountHasTransactions,
  deleteAccountRow,
  insertAccount,
  isHouseholdMember,
  selectAccount,
  selectAccountSums,
  selectAccounts,
  updateAccountRow,
} from "./accounts.repo";
import {
  type AccountList,
  type AccountView,
  type CurrencyTotal,
  accountCreateSchema,
  accountListSchema,
  accountUpdateSchema,
} from "./accounts.schema";

/**
 * Conturile gospodăriei (Faza 2): creare, modificare, arhivare, ștergere (doar conturile goale,
 * 5.6) și listarea cu sold CALCULAT:
 *   sold = sold inițial + Σ venituri − Σ cheltuieli + Σ transferuri intrate − Σ transferuri ieșite,
 * totul în `bigint` prin `money.ts`, separat pe monedă (fără conversie).
 */

function view(row: AccountRow, balanceMinor: bigint): AccountView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    openingBalanceMinor: row.openingBalanceMinor,
    balanceMinor,
    bankCode: row.bankCode,
    ownerUserId: row.ownerUserId,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Soldurile curente ale conturilor date (aceeași formulă pentru listă și pentru un cont). */
export async function computeBalances(
  tx: Tx,
  householdId: string,
  rows: readonly AccountRow[],
): Promise<Map<string, bigint>> {
  const sums = await selectAccountSums(
    tx,
    householdId,
    rows.map((r) => r.id),
  );
  const byAccount = new Map(sums.map((s) => [s.accountId, s]));
  const out = new Map<string, bigint>();
  for (const row of rows) {
    const c = row.currency;
    const s = byAccount.get(row.id);
    let balance = money(row.openingBalanceMinor, c);
    if (s) {
      balance = add(balance, money(BigInt(s.income), c));
      balance = sub(balance, money(BigInt(s.expense), c));
      balance = add(balance, money(BigInt(s.transferIn), c));
      balance = sub(balance, money(BigInt(s.transferOut), c));
    }
    out.set(row.id, balance.amountMinor);
  }
  return out;
}

function totalsOf(list: readonly AccountView[]): CurrencyTotal[] {
  const totals = new Map<Currency, ReturnType<typeof zero>>();
  for (const a of list) {
    if (a.archivedAt) continue;
    totals.set(
      a.currency,
      add(totals.get(a.currency) ?? zero(a.currency), money(a.balanceMinor, a.currency)),
    );
  }
  return [...totals.values()]
    .sort((x, y) => x.currency.localeCompare(y.currency))
    .map((m) => ({ currency: m.currency, balanceMinor: m.amountMinor }));
}

export async function listAccounts(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<AccountList> {
  const options = parseInput(accountListSchema, rawOptions) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await selectAccounts(tx, m.householdId, {
      includeArchived: options.includeArchived ?? false,
    });
    const balances = await computeBalances(tx, m.householdId, rows);
    const list = rows.map((r) => view(r, balances.get(r.id)!));
    return { accounts: list, totals: totalsOf(list) };
  });
}

async function loadView(tx: Tx, householdId: string, id: string): Promise<AccountView> {
  const row = await selectAccount(tx, householdId, id);
  if (!row) throw new NotFoundError();
  const balances = await computeBalances(tx, householdId, [row]);
  return view(row, balances.get(row.id)!);
}

export async function getAccount(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
): Promise<AccountView> {
  if (!isValidId(accountId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, (tx, m) =>
    loadView(tx, m.householdId, accountId.toLowerCase()),
  );
}

async function checkOwner(tx: Tx, householdId: string, ownerUserId: string | null | undefined) {
  if (ownerUserId && !(await isHouseholdMember(tx, householdId, ownerUserId))) {
    throw new ValidationError({
      ownerUserId: "Proprietarul trebuie să fie membru al gospodăriei.",
    });
  }
}

export async function createAccount(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<AccountView> {
  const input = parseInput(accountCreateSchema, rawInput);
  const opening =
    input.openingBalanceMinor === undefined && input.openingBalance === undefined
      ? 0n
      : resolveAmount(
          { amountMinor: input.openingBalanceMinor, amount: input.openingBalance },
          input.currency,
          "openingBalanceMinor",
          true,
        );
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    await checkOwner(tx, m.householdId, input.ownerUserId);
    const row = await insertAccount(tx, {
      householdId: m.householdId,
      name: input.name,
      type: input.type,
      currency: input.currency,
      openingBalanceMinor: opening,
      bankCode: input.bankCode ?? null,
      ownerUserId: input.ownerUserId ?? null,
    });
    return view(row, row.openingBalanceMinor);
  });
}

export async function updateAccount(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
  rawPatch: unknown,
): Promise<AccountView> {
  if (!isValidId(accountId)) throw new NotFoundError();
  const patch = parseInput(accountUpdateSchema, rawPatch);
  const id = accountId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectAccount(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    const currency = patch.currency ?? current.currency;
    if (currency !== current.currency && (await accountHasTransactions(tx, m.householdId, id))) {
      throw new ConflictError(
        "account_has_transactions",
        "Moneda unui cont cu tranzacții nu se schimbă.",
      );
    }
    await checkOwner(tx, m.householdId, patch.ownerUserId);
    const opening =
      patch.openingBalanceMinor === undefined && patch.openingBalance === undefined
        ? undefined
        : resolveAmount(
            { amountMinor: patch.openingBalanceMinor, amount: patch.openingBalance },
            currency,
            "openingBalanceMinor",
            true,
          );
    await updateAccountRow(tx, m.householdId, id, {
      name: patch.name,
      type: patch.type,
      currency: patch.currency,
      openingBalanceMinor: opening,
      bankCode: patch.bankCode,
      ownerUserId: patch.ownerUserId,
    });
    if (opening !== undefined) await assertAccountsWithinJsonRange(tx, m.householdId, [id]);
    return loadView(tx, m.householdId, id);
  });
}

async function setArchived(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
  archived: boolean,
): Promise<AccountView> {
  if (!isValidId(accountId)) throw new NotFoundError();
  const id = accountId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectAccount(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if ((current.archivedAt !== null) !== archived) {
      await updateAccountRow(tx, m.householdId, id, { archivedAt: archived ? new Date() : null });
      await insertAudit(tx, actor.userId, m.householdId, {
        action: archived ? "account.archived" : "account.unarchived",
        targetType: "account",
        targetId: id,
      });
    }
    return loadView(tx, m.householdId, id);
  });
}

/** Arhivează contul (5.6): rămâne în istoric și în solduri, dar nu mai primește tranzacții noi. */
export function archiveAccount(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
): Promise<AccountView> {
  return setArchived(deps, actor, householdId, accountId, true);
}

/** Reactivează un cont arhivat (numele trebuie să fie din nou unic între conturile active). */
export function unarchiveAccount(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
): Promise<AccountView> {
  return setArchived(deps, actor, householdId, accountId, false);
}

/** Șterge un cont GOL; un cont cu tranzacții se arhivează (5.6) → `ConflictError`. */
export async function deleteAccount(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  accountId: string,
): Promise<void> {
  if (!isValidId(accountId)) throw new NotFoundError();
  const id = accountId.toLowerCase();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectAccount(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (await accountHasTransactions(tx, m.householdId, id)) {
      throw new ConflictError(
        "account_not_empty",
        "Contul are tranzacții: arhivează-l în loc să-l ștergi.",
      );
    }
    if (!(await deleteAccountRow(tx, m.householdId, id))) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "account.deleted",
      targetType: "account",
      targetId: id,
    });
  });
}
