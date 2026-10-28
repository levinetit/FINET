import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { MoneyOverflowError } from "@/lib/money";
import { createAccount } from "@/modules/accounts/accounts.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  sqlState,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTransfer } from "@/modules/transfers/transfers.service";

import { type TransactionView, transactionToJson } from "./transactions.schema";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from "./transactions.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!TEST_ADMIN_URL)("tranzacții (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let ron: string;
  let eur: string;
  let groceries: string;
  let salary: string;

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_tx");
    ron = (await createAccount(f.deps, f.A, f.HA, { name: "RON", type: "bank", currency: "RON" }))
      .id;
    eur = (await createAccount(f.deps, f.A, f.HA, { name: "EUR", type: "bank", currency: "EUR" }))
      .id;
    groceries = await systemCategoryId(f.admin, "expense.groceries");
    salary = await systemCategoryId(f.admin, "income.salary");
  });
  afterAll(async () => {
    await f?.close();
  });

  const ctxA = () => ({ userId: f.A.userId, householdId: f.HA });

  it("creare: moneda contului, sursa manual, creatorul din sesiune, data calendaristică", async () => {
    const t = await createTransaction(f.deps, f.C, f.HA, {
      accountId: eur,
      type: "expense",
      amount: "12,34",
      occurredOn: "2026-03-29",
      categoryId: groceries,
      description: "  Lidl  ",
      merchant: "Lidl",
      notes: "",
    });
    expect(t).toMatchObject({
      currency: "EUR",
      amountMinor: 1234n,
      source: "manual",
      createdByUserId: f.C.userId,
      occurredOn: "2026-03-29",
      description: "Lidl",
      notes: null,
      transferGroupId: null,
    });
    const [row] = await f.admin<{ d: string }[]>`
      select occurred_on::text as d from finet.transactions where id = ${t.id}`;
    expect(row!.d).toBe("2026-03-29");
  });

  it("modificare: tip, categorie, sumă, mutare pe alt cont (moneda urmează contul)", async () => {
    const t = await createTransaction(f.deps, f.A, f.HA, {
      accountId: ron,
      type: "expense",
      amountMinor: 500,
      occurredOn: "2026-10-01",
      categoryId: groceries,
    });
    // Tipul nou cu categoria veche de cheltuieli → respins.
    await expect(
      updateTransaction(f.deps, f.A, f.HA, t.id, { type: "income" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const u = await updateTransaction(f.deps, f.A, f.HA, t.id, {
      type: "income",
      categoryId: salary,
      amountMinor: 700,
      accountId: eur,
      merchant: null,
    });
    expect(u).toMatchObject({
      type: "income",
      categoryId: salary,
      amountMinor: 700n,
      accountId: eur,
      currency: "EUR",
    });
    await expect(
      updateTransaction(f.deps, f.A, f.HA, t.id, { householdId: f.HB }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("ștergere definitivă cu audit fără sume sau descrieri", async () => {
    const t = await createTransaction(f.deps, f.A, f.HA, {
      accountId: ron,
      type: "expense",
      amountMinor: 98_765,
      occurredOn: "2026-10-02",
      description: "Text privat",
    });
    await deleteTransaction(f.deps, f.A, f.HA, t.id);
    await expect(getTransaction(f.deps, f.A, f.HA, t.id)).rejects.toBeInstanceOf(NotFoundError);
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where id = ${t.id}`;
    expect(n!.n).toBe(0);
    const audits = await f.admin<{ metadata: unknown; actor_user_id: string }[]>`
      select metadata, actor_user_id from finet.audit_events
       where action = 'transaction.deleted' and target_id = ${t.id}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_user_id).toBe(f.A.userId);
    const text = JSON.stringify(audits[0]!.metadata);
    expect(text).not.toContain("98765");
    expect(text).not.toContain("Text privat");
    await expect(deleteTransaction(f.deps, f.A, f.HA, t.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("un rând de transfer nu se modifică din serviciul de tranzacții", async () => {
    const tr = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: ron,
      toAccountId: (
        await createAccount(f.deps, f.A, f.HA, { name: "Alt RON", type: "cash", currency: "RON" })
      ).id,
      amountMinor: 10,
      occurredOn: "2026-10-03",
    });
    await expect(
      updateTransaction(f.deps, f.A, f.HA, tr.from.transactionId, { amountMinor: 11 }),
    ).rejects.toMatchObject({ reason: "transfer_row" });
    // În bază: transfer → venit e oprit de CHECK (grupul rămâne setat).
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctxA(), (tx) =>
          tx.execute(
            sql`update finet.transactions set type = 'income' where id = ${tr.from.transactionId}`,
          ),
        ),
      ),
    ).toBe("23514");
  });

  it("CHECK-uri în bază: sumă ≤ 0, monedă diferită de a contului, gospodărie străină", async () => {
    const insert = (amount: string, currency: string, householdId = f.HA) =>
      withRlsOn(f.db, ctxA(), (tx) =>
        tx.execute(sql`
          insert into finet.transactions
            (household_id, account_id, created_by_user_id, type, amount_minor, currency, occurred_on)
          values (${householdId}, ${ron}, ${f.A.userId}, 'expense', ${amount}::bigint, ${currency}, '2026-10-01')`),
      );
    expect(await sqlState(() => insert("0", "RON"))).toBe("23514");
    expect(await sqlState(() => insert("-5", "RON"))).toBe("23514");
    // Moneda trebuie să fie a contului (cheia compusă).
    expect(await sqlState(() => insert("5", "EUR"))).toBe("23503");
    // household_id străin: triggerul BEFORE (sub RLS) nu găsește contul în acea gospodărie și
    // respinge înaintea politicii (WITH CHECK, 42501 — verificat pe tabelele fără trigger în
    // src/db/ledger-rls.test.ts). Ambele căi refuză scrierea.
    expect(await sqlState(() => insert("5", "RON", f.HB))).toBe("23503");
    expect(await sqlState(() => insert("5", "RON"))).toBeNull();
  });

  it("sume bigint mari: > 2^53 se stochează, dar serializarea JSON le respinge", async () => {
    const big = 2n ** 53n + 7n;
    const [row] = await f.admin<{ id: string }[]>`
      insert into finet.transactions
        (household_id, account_id, created_by_user_id, type, amount_minor, currency, occurred_on)
      values (${f.HA}, ${eur}, ${f.A.userId}, 'income', ${big.toString()}::bigint, 'EUR', '1999-01-01')
      returning id`;
    const t = await getTransaction(f.deps, f.A, f.HA, row!.id);
    expect(t.amountMinor).toBe(big);
    expect(() => transactionToJson(t)).toThrow(MoneyOverflowError);
    // Prin serviciu nu intră peste 2^53 − 1.
    await expect(
      createTransaction(f.deps, f.A, f.HA, {
        accountId: eur,
        type: "income",
        amountMinor: Number.MAX_SAFE_INTEGER + 1,
        occurredOn: "2026-10-01",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await f.admin`delete from finet.transactions where id = ${row!.id}`;
  });

  it("izolare: B nu vede, nu modifică și nu șterge tranzacțiile lui A; nu scrie pe contul lui A", async () => {
    const t = await createTransaction(f.deps, f.A, f.HA, {
      accountId: ron,
      type: "expense",
      amountMinor: 42,
      occurredOn: "2026-10-04",
    });
    for (const op of [
      () => getTransaction(f.deps, f.B, f.HB, t.id),
      () => updateTransaction(f.deps, f.B, f.HB, t.id, { amountMinor: 1 }),
      () => deleteTransaction(f.deps, f.B, f.HB, t.id),
      () => listTransactions(f.deps, f.B, f.HA),
      () => getTransaction(f.deps, f.B, f.HA, t.id),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(
      createTransaction(f.deps, f.B, f.HB, {
        accountId: ron,
        type: "expense",
        amountMinor: 1,
        occurredOn: "2026-10-04",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await listTransactions(f.deps, f.B, f.HB)).data).toEqual([]);
    expect((await getTransaction(f.deps, f.A, f.HA, t.id)).amountMinor).toBe(42n);
    // Fără context: niciun rând.
    expect(await f.fx.client`select id from finet.transactions`).toHaveLength(0);
  });

  describe("căutare, filtre, sortare și paginare", () => {
    let acc: string;
    let lunch: string;
    const created: TransactionView[] = [];

    beforeAll(async () => {
      acc = (
        await createAccount(f.deps, f.A, f.HA, { name: "Listare", type: "bank", currency: "RON" })
      ).id;
      lunch = await systemCategoryId(f.admin, "expense.restaurants");
      // 25 de tranzacții în 2025, câteva în aceeași zi (ordinea pe id e decisivă).
      for (let i = 0; i < 25; i++) {
        const day = String(1 + (i % 9)).padStart(2, "0");
        created.push(
          await createTransaction(f.deps, f.A, f.HA, {
            accountId: acc,
            type: i % 5 === 0 ? "income" : "expense",
            amountMinor: 100 + i * 10,
            occurredOn: `2025-01-${day}`,
            categoryId: i % 5 === 0 ? null : i % 2 === 0 ? lunch : groceries,
            description: i === 7 ? "Reducere 50%_test" : `Cumpărături ${i}`,
            merchant: i === 3 ? "Kaufland Iași" : "Profi",
            notes: i === 11 ? "notă cu cuvântul ascuns" : null,
          }),
        );
      }
    });

    const all = async (query: Record<string, unknown>) => {
      const out: TransactionView[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const r = await listTransactions(f.deps, f.A, f.HA, { ...query, cursor });
        out.push(...r.data);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return out;
    };

    it("paginarea pe (occurred_on, id) parcurge tot, fără duplicate, în ordine", async () => {
      const rows = await all({ accountId: acc, limit: 4 });
      expect(rows).toHaveLength(25);
      expect(new Set(rows.map((r) => r.id)).size).toBe(25);
      const keys = rows.map((r) => `${r.occurredOn}|${r.id}`);
      expect(keys).toEqual([...keys].sort().reverse());
      const asc = await all({ accountId: acc, limit: 7, sort: "date_asc" });
      expect(asc.map((r) => r.id)).toEqual(rows.map((r) => r.id).reverse());
    });

    it("stabilă la inserări concurente: rândurile existente apar exact o dată", async () => {
      const seen: string[] = [];
      let r = await listTransactions(f.deps, f.A, f.HA, { accountId: acc, limit: 5 });
      seen.push(...r.data.map((t) => t.id));
      const extra: string[] = [];
      while (r.nextCursor) {
        // Între pagini: rânduri noi înainte și după poziția curentă, în aceeași zi.
        for (const day of ["2025-01-05", "2026-12-31", "2024-01-01"]) {
          extra.push(
            (
              await createTransaction(f.deps, f.C, f.HA, {
                accountId: acc,
                type: "expense",
                amountMinor: 1,
                occurredOn: day,
              })
            ).id,
          );
        }
        r = await listTransactions(f.deps, f.A, f.HA, {
          accountId: acc,
          limit: 5,
          cursor: r.nextCursor,
        });
        seen.push(...r.data.map((t) => t.id));
      }
      expect(new Set(seen).size).toBe(seen.length);
      for (const t of created) expect(seen).toContain(t.id);
      for (const id of extra) await deleteTransaction(f.deps, f.A, f.HA, id);
    });

    it("limit: implicit 50, plafonat la 100; 0 sau negativ respins", async () => {
      const r = await listTransactions(f.deps, f.A, f.HA, { limit: 100_000 });
      expect(r.data.length).toBeLessThanOrEqual(100);
      expect((await listTransactions(f.deps, f.A, f.HA, {})).data.length).toBeLessThanOrEqual(50);
      for (const limit of [0, -1, 2.5]) {
        await expect(listTransactions(f.deps, f.A, f.HA, { limit })).rejects.toBeInstanceOf(
          ValidationError,
        );
      }
      // Plafonul se vede când există mai multe rânduri decât el.
      for (let i = 0; i < 80; i++) {
        await f.admin`
          insert into finet.transactions
            (household_id, account_id, created_by_user_id, type, amount_minor, currency, occurred_on)
          values (${f.HA}, ${ron}, ${f.A.userId}, 'expense', 1, 'RON', '2020-01-01')`;
      }
      const capped = await listTransactions(f.deps, f.A, f.HA, { limit: 1000 });
      expect(capped.data).toHaveLength(100);
      expect(capped.nextCursor).not.toBeNull();
      await f.admin`delete from finet.transactions where occurred_on = '2020-01-01'`;
    });

    it("cursorul altei sortări sau modificat → 400", async () => {
      const r = await listTransactions(f.deps, f.A, f.HA, { accountId: acc, limit: 2 });
      await expect(
        listTransactions(f.deps, f.A, f.HA, { cursor: r.nextCursor!, sort: "amount_desc" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        listTransactions(f.deps, f.A, f.HA, { cursor: `${r.nextCursor!}x` }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("filtre: tip, categorie, interval de date și de sumă, sursă", async () => {
      const incomes = await all({ accountId: acc, type: "income" });
      expect(incomes.map((r) => r.id).sort()).toEqual(
        created
          .filter((t) => t.type === "income")
          .map((t) => t.id)
          .sort(),
      );
      const byCat = await all({ accountId: acc, categoryId: lunch });
      expect(byCat.every((r) => r.categoryId === lunch)).toBe(true);
      expect(byCat).toHaveLength(created.filter((t) => t.categoryId === lunch).length);
      const dates = await all({ accountId: acc, dateFrom: "2025-01-03", dateTo: "2025-01-04" });
      expect(dates.every((r) => r.occurredOn >= "2025-01-03" && r.occurredOn <= "2025-01-04")).toBe(
        true,
      );
      expect(dates).toHaveLength(
        created.filter((t) => t.occurredOn >= "2025-01-03" && t.occurredOn <= "2025-01-04").length,
      );
      const amounts = await all({ accountId: acc, amountMinMinor: 200, amountMaxMinor: 250 });
      expect(amounts.map((r) => r.amountMinor).sort()).toEqual([
        200n,
        210n,
        220n,
        230n,
        240n,
        250n,
      ]);
      expect(await all({ accountId: acc, source: "receipt" })).toEqual([]);
      expect(await all({ accountId: acc, source: "manual" })).toHaveLength(25);
    });

    it("căutare în descriere, comerciant și note; % și _ nu sunt metacaractere", async () => {
      const kaufland = await all({ q: "kaufland iași" });
      expect(kaufland.map((r) => r.id)).toEqual([created[3]!.id]);
      expect((await all({ q: "ASCUNS" })).map((r) => r.id)).toEqual([created[11]!.id]);
      expect((await all({ q: "50%_" })).map((r) => r.id)).toEqual([created[7]!.id]);
      expect(await all({ q: "%" })).toHaveLength(1);
      expect(await all({ q: "_" })).toHaveLength(1);
      expect(await all({ q: "nu există nicăieri" })).toEqual([]);
    });

    it("sortare pe sumă, cu paginare (cheia sumei ca text în cursor)", async () => {
      const desc = await all({ accountId: acc, sort: "amount_desc", limit: 3 });
      expect(desc).toHaveLength(25);
      const amounts = desc.map((r) => r.amountMinor);
      expect(amounts).toEqual([...amounts].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
      const ascending = await all({ accountId: acc, sort: "amount_asc", limit: 6 });
      expect(ascending[0]!.amountMinor).toBe(100n);
      expect(new Set(ascending.map((r) => r.id)).size).toBe(25);
    });
  });

  it("validare: categorie inexistentă, cont inexistent, dată invalidă → 400; conflictele sunt 409", async () => {
    for (const bad of [
      { accountId: ron, type: "expense", amountMinor: 1, occurredOn: "2026-02-30" },
      { accountId: randomUUID(), type: "expense", amountMinor: 1, occurredOn: "2026-10-01" },
      {
        accountId: ron,
        type: "expense",
        amountMinor: 1,
        occurredOn: "2026-10-01",
        categoryId: randomUUID(),
      },
      {
        accountId: ron,
        type: "expense",
        amountMinor: 1,
        occurredOn: "2026-10-01",
        notes: "x".repeat(2001),
      },
    ]) {
      await expect(
        createTransaction(f.deps, f.A, f.HA, bad),
        JSON.stringify(bad).slice(0, 80),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(new ConflictError("x").status).toBe(409);
  });
});
