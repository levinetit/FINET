import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { type LedgerFixture, createLedgerFixture } from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import { accountToJson } from "./accounts.schema";
import {
  archiveAccount,
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  unarchiveAccount,
  updateAccount,
} from "./accounts.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!TEST_ADMIN_URL)("conturi și solduri (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_acc");
  });
  afterAll(async () => {
    await f?.close();
  });

  const day = "2026-10-15";
  const expense = (accountId: string, amountMinor: number) =>
    createTransaction(f.deps, f.A, f.HA, {
      accountId,
      type: "expense",
      amountMinor,
      occurredOn: day,
    });
  const income = (accountId: string, amountMinor: number) =>
    createTransaction(f.deps, f.A, f.HA, { accountId, type: "income", amountMinor, occurredOn: day });

  it("soldul = inițial + venituri − cheltuieli + transferuri intrate − transferuri ieșite", async () => {
    const bank = await createAccount(f.deps, f.A, f.HA, {
      name: "Banca Sold",
      type: "bank",
      currency: "RON",
      openingBalance: "1.000,00",
    });
    const cash = await createAccount(f.deps, f.A, f.HA, {
      name: "Numerar Sold",
      type: "cash",
      currency: "RON",
    });
    expect(bank.openingBalanceMinor).toBe(100_000n);
    expect(bank.balanceMinor).toBe(100_000n);
    await income(bank.id, 250_050);
    await expense(bank.id, 12_345);
    await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: bank.id,
      toAccountId: cash.id,
      amountMinor: 20_000,
      occurredOn: day,
    });
    const after = await getAccount(f.deps, f.A, f.HA, bank.id);
    expect(after.balanceMinor).toBe(100_000n + 250_050n - 12_345n - 20_000n);
    expect((await getAccount(f.deps, f.A, f.HA, cash.id)).balanceMinor).toBe(20_000n);
    // C (member în HA) vede aceleași solduri.
    expect((await getAccount(f.deps, f.C, f.HA, bank.id)).balanceMinor).toBe(after.balanceMinor);
  });

  it("sold inițial negativ (card de credit) și totaluri separate pe monedă", async () => {
    const card = await createAccount(f.deps, f.A, f.HA, {
      name: "Card credit",
      type: "credit_card",
      currency: "RON",
      openingBalanceMinor: -50_000,
    });
    expect(card.balanceMinor).toBe(-50_000n);
    await expense(card.id, 1_000);
    expect((await getAccount(f.deps, f.A, f.HA, card.id)).balanceMinor).toBe(-51_000n);

    const eur = await createAccount(f.deps, f.A, f.HA, {
      name: "Economii EUR",
      type: "savings",
      currency: "EUR",
      openingBalanceMinor: 30_000,
    });
    const usd = await createAccount(f.deps, f.A, f.HA, {
      name: "Cont USD",
      type: "bank",
      currency: "USD",
    });
    await income(usd.id, 999);
    const list = await listAccounts(f.deps, f.A, f.HA);
    const ronSum = list.accounts
      .filter((a) => a.currency === "RON")
      .reduce((acc, a) => acc + a.balanceMinor, 0n);
    expect(list.totals).toEqual([
      { currency: "EUR", balanceMinor: eur.balanceMinor },
      { currency: "RON", balanceMinor: ronSum },
      { currency: "USD", balanceMinor: 999n },
    ]);
    // Fiecare sold e bigint, iar JSON-ul are întregi.
    for (const a of list.accounts) expect(typeof a.balanceMinor).toBe("bigint");
    expect(accountToJson(list.accounts.find((a) => a.id === card.id)!).balanceMinor).toBe(-51_000);
  });

  it("arhivarea: contul dispare din lista implicită și din totaluri, rămâne cu includeArchived", async () => {
    const acc = await createAccount(f.deps, f.A, f.HA, {
      name: "De arhivat",
      type: "cash",
      currency: "EUR",
      openingBalanceMinor: 700,
    });
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: acc.id,
      type: "income",
      amountMinor: 300,
      occurredOn: day,
    });
    const before = await listAccounts(f.deps, f.A, f.HA);
    const eurBefore = before.totals.find((t) => t.currency === "EUR")!.balanceMinor;
    const archived = await archiveAccount(f.deps, f.A, f.HA, acc.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(archived.balanceMinor).toBe(1_000n);
    const after = await listAccounts(f.deps, f.A, f.HA);
    expect(after.accounts.map((a) => a.id)).not.toContain(acc.id);
    expect(after.totals.find((t) => t.currency === "EUR")!.balanceMinor).toBe(eurBefore - 1_000n);
    const all = await listAccounts(f.deps, f.A, f.HA, { includeArchived: true });
    expect(all.accounts.map((a) => a.id)).toContain(acc.id);
    // Contul arhivat nu primește tranzacții noi și nu e ținta unui transfer.
    await expect(
      createTransaction(f.deps, f.A, f.HA, {
        accountId: acc.id,
        type: "expense",
        amountMinor: 1,
        occurredOn: day,
      }),
    ).rejects.toMatchObject({ reason: "account_archived" });
    // Numele unui cont arhivat se poate refolosi; reactivarea cu nume ocupat → conflict.
    const again = await createAccount(f.deps, f.A, f.HA, {
      name: "de arhivat",
      type: "cash",
      currency: "EUR",
    });
    await expect(unarchiveAccount(f.deps, f.A, f.HA, acc.id)).rejects.toMatchObject({
      reason: "account_name_taken",
    });
    await deleteAccount(f.deps, f.A, f.HA, again.id);
    expect((await unarchiveAccount(f.deps, f.A, f.HA, acc.id)).archivedAt).toBeNull();
  });

  it("ștergere: doar contul gol; cel cu tranzacții → conflict (se arhivează)", async () => {
    const empty = await createAccount(f.deps, f.A, f.HA, {
      name: "Gol",
      type: "cash",
      currency: "RON",
    });
    await deleteAccount(f.deps, f.A, f.HA, empty.id);
    await expect(getAccount(f.deps, f.A, f.HA, empty.id)).rejects.toBeInstanceOf(NotFoundError);
    const used = await createAccount(f.deps, f.A, f.HA, {
      name: "Folosit",
      type: "cash",
      currency: "RON",
    });
    await expense(used.id, 5);
    await expect(deleteAccount(f.deps, f.A, f.HA, used.id)).rejects.toMatchObject({
      reason: "account_not_empty",
    });
    const [audit] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.audit_events
       where action = 'account.deleted' and target_id = ${empty.id}`;
    expect(audit!.n).toBe(1);
  });

  it("moneda: se schimbă doar pe un cont fără tranzacții", async () => {
    const acc = await createAccount(f.deps, f.A, f.HA, {
      name: "Monedă",
      type: "bank",
      currency: "RON",
    });
    expect((await updateAccount(f.deps, f.A, f.HA, acc.id, { currency: "EUR" })).currency).toBe(
      "EUR",
    );
    await income(acc.id, 10);
    await expect(
      updateAccount(f.deps, f.A, f.HA, acc.id, { currency: "USD" }),
    ).rejects.toMatchObject({ reason: "account_has_transactions" });
    const renamed = await updateAccount(f.deps, f.A, f.HA, acc.id, {
      name: "  Monedă   nouă ",
      openingBalance: "-1,50",
    });
    expect(renamed.name).toBe("Monedă nouă");
    expect(renamed.openingBalanceMinor).toBe(-150n);
  });

  it("nume duplicat (fără diferență de majuscule) → conflict; validare strictă", async () => {
    await createAccount(f.deps, f.A, f.HA, { name: "Duplicat", type: "cash", currency: "RON" });
    await expect(
      createAccount(f.deps, f.A, f.HA, { name: "DUPLICAT", type: "bank", currency: "RON" }),
    ).rejects.toBeInstanceOf(ConflictError);
    for (const bad of [
      { name: "", type: "cash", currency: "RON" },
      { name: "X", type: "crypto", currency: "RON" },
      { name: "X", type: "cash", currency: "GBP" },
      { name: "X", type: "cash", currency: "RON", householdId: f.HB },
      { name: "X", type: "cash", currency: "RON", openingBalanceMinor: 1.5 },
      { name: "X", type: "cash", currency: "RON", bankCode: "BT; drop" },
    ]) {
      await expect(createAccount(f.deps, f.A, f.HA, bad), JSON.stringify(bad)).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });

  it("proprietarul contului trebuie să fie membru al gospodăriei", async () => {
    const own = await createAccount(f.deps, f.A, f.HA, {
      name: "Al lui C",
      type: "cash",
      currency: "RON",
      ownerUserId: f.C.userId,
    });
    expect(own.ownerUserId).toBe(f.C.userId);
    await expect(
      createAccount(f.deps, f.A, f.HA, {
        name: "Al lui B",
        type: "cash",
        currency: "RON",
        ownerUserId: f.B.userId,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      updateAccount(f.deps, f.A, f.HA, own.id, { ownerUserId: f.B.userId }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await updateAccount(f.deps, f.A, f.HA, own.id, { ownerUserId: null })).ownerUserId).toBe(
      null,
    );
  });

  it("izolare: B nu vede, nu modifică, nu arhivează și nu șterge conturile lui A (404)", async () => {
    const acc = await createAccount(f.deps, f.A, f.HA, {
      name: "Privat A",
      type: "bank",
      currency: "RON",
    });
    // Gospodăria străină: B nu e membru al HA.
    await expect(listAccounts(f.deps, f.B, f.HA)).rejects.toBeInstanceOf(NotFoundError);
    // Contul străin, prin propria gospodărie.
    for (const op of [
      () => getAccount(f.deps, f.B, f.HB, acc.id),
      () => updateAccount(f.deps, f.B, f.HB, acc.id, { name: "Furat" }),
      () => archiveAccount(f.deps, f.B, f.HB, acc.id),
      () => deleteAccount(f.deps, f.B, f.HB, acc.id),
      () => getAccount(f.deps, f.B, f.HB, "nu-e-uuid"),
      () => getAccount(f.deps, f.B, f.HB, randomUUID()),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await listAccounts(f.deps, f.B, f.HB)).accounts).toEqual([]);
    expect((await getAccount(f.deps, f.A, f.HA, acc.id)).name).toBe("Privat A");
  });
});
