import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { MAX_JSON_SAFE_MINOR, MoneyOverflowError } from "@/lib/money";
import { createAccount, getAccount, updateAccount } from "@/modules/accounts/accounts.service";
import { createTransaction, updateTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer, updateTransfer } from "@/modules/transfers/transfers.service";

import { type LedgerFixture, createLedgerFixture } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CAP = 10_000_000_000_000n;
/** Cât mai încape pe un cont după 900 de sume la plafon: 2^53 − 1 − 900 × 10^13. */
const ROOM = MAX_JSON_SAFE_MINOR - 900n * CAP;

/** Revizuirea F2, LOW-2: scrierile care ar duce totalul brut al unui cont peste 2^53 − 1. */
describe.skipIf(!TEST_ADMIN_URL)("garda de interval a conturilor (LOW-2)", () => {
  let f: LedgerFixture;
  let full: string;
  let other: string;

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_range");
    full = (await createAccount(f.deps, f.A, f.HA, { name: "Plin", type: "bank", currency: "RON" }))
      .id;
    other = (
      await createAccount(f.deps, f.A, f.HA, { name: "Altul", type: "cash", currency: "RON" })
    ).id;
    // 900 de sume legitime la plafon (direct, ca să nu creăm 900 de cereri).
    await f.admin`
      insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on)
      select ${f.HA}, ${full}, 'income', ${CAP.toString()}::bigint, 'RON', '2026-10-01'
        from generate_series(1, 900)`;
  });
  afterAll(async () => {
    await f?.close();
  });

  const expense = (accountId: string, amountMinor: bigint) =>
    createTransaction(f.deps, f.A, f.HA, {
      accountId,
      type: "expense",
      amountMinor: Number(amountMinor),
      occurredOn: "2026-10-02",
    });

  it("o sumă care atinge exact 2^53 − 1 trece; una în plus → MoneyOverflowError, nimic scris", async () => {
    expect(ROOM).toBeGreaterThan(0n);
    expect(ROOM).toBeLessThan(CAP);
    const ok = await expense(full, ROOM);
    await expect(expense(full, 1n)).rejects.toBeInstanceOf(MoneyOverflowError);
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where account_id = ${full}`;
    expect(n!.n).toBe(901);
    // Soldul rămâne citibil (sub 2^53).
    expect((await getAccount(f.deps, f.A, f.HA, full)).balanceMinor).toBe(900n * CAP - ROOM);
    // Mărirea sumei existente sau mutarea unei tranzacții pe contul plin: respinse.
    await expect(
      updateTransaction(f.deps, f.A, f.HA, ok.id, { amountMinor: Number(ROOM + 1n) }),
    ).rejects.toBeInstanceOf(MoneyOverflowError);
    const small = await expense(other, 5n);
    await expect(
      updateTransaction(f.deps, f.A, f.HA, small.id, { accountId: full }),
    ).rejects.toBeInstanceOf(MoneyOverflowError);
    // Micșorarea merge.
    await updateTransaction(f.deps, f.A, f.HA, ok.id, { amountMinor: Number(ROOM - 10n) });
  });

  it("transferuri și soldul inițial: aceeași gardă, pe ambele conturi", async () => {
    await expect(
      createTransfer(f.deps, f.A, f.HA, {
        fromAccountId: other,
        toAccountId: full,
        amountMinor: 11,
        occurredOn: "2026-10-03",
      }),
    ).rejects.toBeInstanceOf(MoneyOverflowError);
    const t = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: other,
      toAccountId: full,
      amountMinor: 10,
      occurredOn: "2026-10-03",
    });
    await expect(
      updateTransfer(f.deps, f.A, f.HA, t.id, { amountMinor: 11 }),
    ).rejects.toBeInstanceOf(MoneyOverflowError);
    await expect(
      updateAccount(f.deps, f.A, f.HA, full, { openingBalanceMinor: -1 }),
    ).rejects.toBeInstanceOf(MoneyOverflowError);
    // Contul celălalt are loc: soldul lui inițial se poate schimba.
    await updateAccount(f.deps, f.A, f.HA, other, { openingBalanceMinor: 1000 });
  });
});
