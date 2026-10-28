import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { signedAmount } from "@/lib/money";
import { archiveAccount, createAccount, getAccount } from "@/modules/accounts/accounts.service";
import { type LedgerFixture, createLedgerFixture, sqlState } from "@/modules/ledger/testing";
import { deleteTransaction, listTransactions } from "@/modules/transactions/transactions.service";

import { transferToJson } from "./transfers.schema";
import { createTransfer, deleteTransfer, getTransfer, updateTransfer } from "./transfers.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!TEST_ADMIN_URL)("transferuri (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let r1: string;
  let r2: string;
  let e1: string;
  const day = "2026-10-20";

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_trf");
    const mk = async (name: string, currency: "RON" | "EUR", openingBalanceMinor = 0) =>
      (
        await createAccount(f.deps, f.A, f.HA, {
          name,
          type: "bank",
          currency,
          openingBalanceMinor,
        })
      ).id;
    r1 = await mk("R1", "RON", 100_000);
    r2 = await mk("R2", "RON");
    e1 = await mk("E1", "EUR");
  });
  afterAll(async () => {
    await f?.close();
  });

  const count = async (accountId: string) => {
    const [row] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where account_id = ${accountId}`;
    return row!.n;
  };
  const balance = async (id: string) => (await getAccount(f.deps, f.A, f.HA, id)).balanceMinor;

  it("aceeași monedă: două rânduri legate, aceeași sumă, soldurile se mută", async () => {
    const t = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: r2,
      amount: "250,00",
      occurredOn: day,
      description: "Economii",
    });
    expect(t.from).toMatchObject({ accountId: r1, amountMinor: 25_000n, currency: "RON" });
    expect(t.to).toMatchObject({ accountId: r2, amountMinor: 25_000n, currency: "RON" });
    expect(await balance(r1)).toBe(75_000n);
    expect(await balance(r2)).toBe(25_000n);
    const rows = await f.admin<
      { type: string; transfer_group_id: string; transfer_direction: string }[]
    >`
      select type, transfer_group_id, transfer_direction from finet.transactions
       where transfer_group_id = ${t.id} order by transfer_direction`;
    expect(rows).toEqual([
      { type: "transfer", transfer_group_id: t.id, transfer_direction: "in" },
      { type: "transfer", transfer_group_id: t.id, transfer_direction: "out" },
    ]);
    // Neutru la totalurile de venituri/cheltuieli.
    expect(signedAmount("transfer", t.from.amountMinor)).toBe(0n);
    expect(transferToJson(t).from.amountMinor).toBe(25_000);
    expect((await getTransfer(f.deps, f.C, f.HA, t.id)).id).toBe(t.id);
  });

  it("monede diferite: se cer explicit ambele sume", async () => {
    await expect(
      createTransfer(f.deps, f.A, f.HA, {
        fromAccountId: r1,
        toAccountId: e1,
        amountMinor: 1_000,
        occurredOn: day,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const t = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: e1,
      amountFromMinor: 4_975,
      amountToMinor: 1_000,
      occurredOn: day,
    });
    expect(t.from).toMatchObject({ amountMinor: 4_975n, currency: "RON" });
    expect(t.to).toMatchObject({ amountMinor: 1_000n, currency: "EUR" });
    expect(await balance(e1)).toBe(1_000n);
    // Aceeași monedă cu sume diferite → respins (serviciu și bază).
    await expect(
      createTransfer(f.deps, f.A, f.HA, {
        fromAccountId: r1,
        toAccountId: r2,
        amountFromMinor: 10,
        amountToMinor: 11,
        occurredOn: day,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("același cont și conturi arhivate sau străine sunt refuzate", async () => {
    await expect(
      createTransfer(f.deps, f.A, f.HA, {
        fromAccountId: r1,
        toAccountId: r1,
        amountMinor: 1,
        occurredOn: day,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const old = (
      await createAccount(f.deps, f.A, f.HA, { name: "Vechi", type: "cash", currency: "RON" })
    ).id;
    await archiveAccount(f.deps, f.A, f.HA, old);
    for (const [from, to] of [
      [r1, old],
      [old, r1],
    ] as const) {
      await expect(
        createTransfer(f.deps, f.A, f.HA, {
          fromAccountId: from,
          toAccountId: to,
          amountMinor: 1,
          occurredOn: day,
        }),
      ).rejects.toMatchObject({ reason: "account_archived" });
    }
    const accB = (
      await createAccount(f.deps, f.B, f.HB, { name: "B", type: "cash", currency: "RON" })
    ).id;
    await expect(
      createTransfer(f.deps, f.A, f.HA, {
        fromAccountId: r1,
        toAccountId: accB,
        amountMinor: 1,
        occurredOn: day,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createTransfer(f.deps, f.B, f.HB, {
        fromAccountId: accB,
        toAccountId: r1,
        amountMinor: 1,
        occurredOn: day,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await count(accB)).toBe(0);
  });

  it("atomicitate: un eșec forțat pe AL DOILEA rând anulează și primul", async () => {
    // Scenariu forțat (doar baza de test, ca superuser): orice rând `in` pe R2 eșuează.
    await f.admin.unsafe(`
      create function finet.test_fail_second_leg() returns trigger language plpgsql as $$
      begin
        raise exception 'eșec forțat pe al doilea rând' using errcode = 'P0001';
      end $$;
      create trigger test_fail_second_leg before insert on finet.transactions
        for each row when (new.transfer_direction = 'in' and new.account_id = '${r2}')
        execute function finet.test_fail_second_leg();
    `);
    try {
      const before = { r1: await count(r1), r2: await count(r2), b1: await balance(r1) };
      await expect(
        createTransfer(f.deps, f.A, f.HA, {
          fromAccountId: r1,
          toAccountId: r2,
          amountMinor: 333,
          occurredOn: day,
        }),
      ).rejects.toThrow();
      expect(await count(r1)).toBe(before.r1);
      expect(await count(r2)).toBe(before.r2);
      expect(await balance(r1)).toBe(before.b1);
    } finally {
      await f.admin.unsafe(`
        drop trigger test_fail_second_leg on finet.transactions;
        drop function finet.test_fail_second_leg();
      `);
    }
  });

  it("baza refuză la COMMIT un transfer incomplet sau incoerent", async () => {
    const ctx = { userId: f.A.userId, householdId: f.HA };
    const leg = (group: string, account: string, direction: string, amount: number) => sql`
      insert into finet.transactions
        (household_id, account_id, created_by_user_id, type, amount_minor, currency, occurred_on,
         transfer_group_id, transfer_direction)
      values (${f.HA}, ${account}, ${f.A.userId}, 'transfer', ${amount}, 'RON', ${day},
              ${group}, ${direction})`;
    const g1 = randomUUID();
    // Un singur rând: eroarea apare la COMMIT, nimic nu rămâne.
    expect(
      await sqlState(() => withRlsOn(f.db, ctx, (tx) => tx.execute(leg(g1, r1, "out", 5)))),
    ).toBe("23514");
    const g2 = randomUUID();
    // Același cont pe ambele rânduri.
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctx, async (tx) => {
          await tx.execute(leg(g2, r1, "out", 5));
          await tx.execute(leg(g2, r1, "in", 5));
        }),
      ),
    ).toBe("23514");
    // Aceeași monedă, sume diferite.
    const g3 = randomUUID();
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctx, async (tx) => {
          await tx.execute(leg(g3, r1, "out", 5));
          await tx.execute(leg(g3, r2, "in", 6));
        }),
      ),
    ).toBe("23514");
    // Al treilea rând în grup → indexul unic.
    const ok = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: r2,
      amountMinor: 5,
      occurredOn: day,
    });
    expect(
      await sqlState(() => withRlsOn(f.db, ctx, (tx) => tx.execute(leg(ok.id, r2, "out", 5)))),
    ).toBe("23505");
    // Ștergerea unui singur rând → refuzată la COMMIT.
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctx, (tx) =>
          tx.execute(sql`delete from finet.transactions where id = ${ok.to.transactionId}`),
        ),
      ),
    ).toBe("23514");
    const [left] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions
       where transfer_group_id in (${g1}, ${g2}, ${g3})`;
    expect(left!.n).toBe(0);
    expect((await getTransfer(f.deps, f.A, f.HA, ok.id)).to.transactionId).toBe(
      ok.to.transactionId,
    );
  });

  it("modificare: sumele ambelor rânduri, data și textele; monede diferite cer ambele sume", async () => {
    const t = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: r2,
      amountMinor: 100,
      occurredOn: day,
    });
    const u = await updateTransfer(f.deps, f.A, f.HA, t.id, {
      amountMinor: 150,
      occurredOn: "2026-10-21",
      description: "Corectat",
    });
    expect(u.from.amountMinor).toBe(150n);
    expect(u.to.amountMinor).toBe(150n);
    expect(u).toMatchObject({ occurredOn: "2026-10-21", description: "Corectat" });
    const x = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: e1,
      amountFromMinor: 500,
      amountToMinor: 100,
      occurredOn: day,
    });
    await expect(
      updateTransfer(f.deps, f.A, f.HA, x.id, { amountMinor: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    const ux = await updateTransfer(f.deps, f.A, f.HA, x.id, {
      amountFromMinor: 600,
      amountToMinor: 120,
    });
    expect([ux.from.amountMinor, ux.to.amountMinor]).toEqual([600n, 120n]);
  });

  it("ștergerea unui transfer șterge ambele rânduri (și prin serviciul de tranzacții), cu audit", async () => {
    const before = { r1: await balance(r1), r2: await balance(r2) };
    const t = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: r2,
      amountMinor: 777,
      occurredOn: day,
    });
    await deleteTransfer(f.deps, f.A, f.HA, t.id);
    await expect(getTransfer(f.deps, f.A, f.HA, t.id)).rejects.toBeInstanceOf(NotFoundError);
    expect([await balance(r1), await balance(r2)]).toEqual([before.r1, before.r2]);
    const t2 = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: r2,
      amountMinor: 1,
      occurredOn: day,
    });
    await deleteTransaction(f.deps, f.A, f.HA, t2.to.transactionId);
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where transfer_group_id = ${t2.id}`;
    expect(n!.n).toBe(0);
    const audits = await f.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events
       where action = 'transfer.deleted' and target_id in (${t.id}, ${t2.id})`;
    expect(audits).toHaveLength(2);
    for (const a of audits) expect(a.metadata).toEqual({});
  });

  it("izolare: B nu vede, nu modifică și nu șterge transferurile lui A", async () => {
    const t = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: r1,
      toAccountId: r2,
      amountMinor: 9,
      occurredOn: day,
    });
    for (const op of [
      () => getTransfer(f.deps, f.B, f.HB, t.id),
      () => updateTransfer(f.deps, f.B, f.HB, t.id, { amountMinor: 1 }),
      () => deleteTransfer(f.deps, f.B, f.HB, t.id),
      () => getTransfer(f.deps, f.B, f.HA, t.id),
      () => getTransfer(f.deps, f.A, f.HA, "x"),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await getTransfer(f.deps, f.A, f.HA, t.id)).from.amountMinor).toBe(9n);
    const list = await listTransactions(f.deps, f.A, f.HA, { type: "transfer", limit: 100 });
    expect(list.data.every((r) => r.transferGroupId !== null)).toBe(true);
    expect(new ConflictError("x")).toBeInstanceOf(Error);
  });
});
