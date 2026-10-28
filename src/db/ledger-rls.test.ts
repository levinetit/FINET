import { randomUUID } from "node:crypto";

import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAccount } from "@/modules/accounts/accounts.service";
import { type LedgerFixture, createLedgerFixture, sqlState } from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Tabelele Fazei 2 (0002_ledger.sql). */
const LEDGER_TABLES = [
  "accounts",
  "app_downloads",
  "app_events",
  "categories",
  "category_visibility",
  "client_installations",
  "idempotency_keys",
  "transactions",
];

describe.skipIf(!TEST_ADMIN_URL)("RLS și drepturi pe tabelele registrului (finet_app)", () => {
  let f: LedgerFixture;
  let accA: string;
  let accB: string;
  const as = (userId: string, householdId: string | null, statement: SQL) =>
    withRlsOn(f.db, { userId, householdId }, (tx) => tx.execute(statement));

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_lrls");
    accA = (await createAccount(f.deps, f.A, f.HA, { name: "A", type: "bank", currency: "RON" }))
      .id;
    accB = (await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" }))
      .id;
    const accA2 = (
      await createAccount(f.deps, f.A, f.HA, { name: "A2", type: "cash", currency: "RON" })
    ).id;
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: accA,
      type: "expense",
      amountMinor: 10,
      occurredOn: "2026-10-01",
    });
    await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: accA,
      toAccountId: accA2,
      amountMinor: 5,
      occurredOn: "2026-10-01",
    });
    await createTransaction(f.deps, f.B, f.HB, {
      accountId: accB,
      type: "income",
      amountMinor: 10,
      occurredOn: "2026-10-01",
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  it("RLS ENABLE + FORCE pe toate tabelele noi", async () => {
    const rows = await f.admin<{ relname: string; on: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'finet' and c.relkind = 'r' and c.relname = any(${LEDGER_TABLES})
       order by c.relname`;
    expect(rows).toEqual(LEDGER_TABLES.map((relname) => ({ relname, on: true, force: true })));
  });

  it("fără context: niciun rând (nici categoriile de sistem)", async () => {
    for (const table of LEDGER_TABLES.filter((t) => t !== "app_downloads")) {
      expect(await f.fx.client.unsafe(`select * from finet.${table}`), table).toHaveLength(0);
    }
    const [n] = await f.admin<{ n: number }[]>`select count(*)::int as n from finet.categories`;
    expect(n!.n).toBeGreaterThanOrEqual(28);
  });

  it("finet_migrator (proprietarul) nu vede datele: FORCE se aplică și lui", async () => {
    const migrator = f.fx.scratch;
    const { testClient } = await import("./testing");
    const sqlM = testClient(migrator.migratorUrl, 1);
    try {
      for (const table of ["accounts", "transactions", "categories"]) {
        expect(await sqlM.unsafe(`select * from finet.${table}`), table).toHaveLength(0);
      }
    } finally {
      await sqlM.end({ timeout: 5 });
    }
  });

  it("cu contextul HA, A vede doar HA; cu context HB (nemembru) nu vede nimic", async () => {
    const own = await as(A(), f.HA, sql`select distinct household_id from finet.transactions`);
    expect(own.map((r) => r.household_id)).toEqual([f.HA]);
    for (const table of ["accounts", "transactions", "category_visibility", "idempotency_keys"]) {
      const rows = await as(A(), f.HB, sql.raw(`select * from finet.${table}`));
      expect(rows, table).toHaveLength(0);
    }
    const cats = await as(A(), f.HB, sql`select id from finet.categories`);
    expect(cats).toHaveLength(0);
  });

  it("insert cu household_id străin → 42501 (tabele fără trigger)", async () => {
    for (const statement of [
      sql`insert into finet.accounts (household_id, name, type, currency) values (${f.HB}, 'X', 'cash', 'RON')`,
      sql`insert into finet.categories (household_id, name, kind) values (${f.HB}, 'X', 'expense')`,
      sql`insert into finet.idempotency_keys (household_id, key, request_hash)
          values (${f.HB}, 'cheie-test-1', ${"a".repeat(64)})`,
      // Nici în gospodăria proprie cu cheie de sistem (rândurile de sistem nu se creează).
      sql`insert into finet.categories (household_id, name, kind, system_key) values (null, 'X', 'expense', 'expense.x_test')`,
    ]) {
      expect(await sqlState(() => as(A(), f.HA, statement))).toBe("42501");
    }
  });

  it("A nu modifică sau șterge rândurile lui B (0 rânduri)", async () => {
    for (const statement of [
      sql`update finet.accounts set name = 'Furat' where id = ${accB} returning id`,
      sql`delete from finet.accounts where id = ${accB} returning id`,
      sql`update finet.transactions set notes = 'x' where account_id = ${accB} returning id`,
      sql`delete from finet.transactions where account_id = ${accB} returning id`,
    ]) {
      expect(await as(A(), f.HA, statement)).toHaveLength(0);
      expect(await as(A(), f.HB, statement)).toHaveLength(0);
    }
    const [row] = await f.admin<
      { name: string }[]
    >`select name from finet.accounts where id = ${accB}`;
    expect(row!.name).toBe("B");
  });

  it("UPDATE pe coloane interzise → 42501", async () => {
    for (const statement of [
      sql`update finet.accounts set household_id = household_id`,
      sql`update finet.accounts set id = id`,
      sql`update finet.accounts set created_at = now()`,
      sql`update finet.transactions set household_id = household_id`,
      sql`update finet.transactions set created_by_user_id = created_by_user_id`,
      sql`update finet.transactions set transfer_group_id = transfer_group_id`,
      sql`update finet.transactions set transfer_direction = transfer_direction`,
      sql`update finet.transactions set source = 'receipt'`,
      sql`update finet.transactions set external_ref = 'x'`,
      sql`update finet.categories set kind = kind`,
      sql`update finet.categories set household_id = household_id`,
      sql`update finet.categories set system_key = system_key`,
      sql`update finet.category_visibility set category_id = category_id`,
      sql`update finet.idempotency_keys set request_hash = request_hash`,
      sql`update finet.idempotency_keys set household_id = household_id`,
      sql`update finet.client_installations set user_id = user_id`,
      sql`update finet.client_installations set installation_id = installation_id`,
      sql`update finet.app_events set name = name`,
      sql`select * from finet.app_downloads`,
      sql`update finet.app_downloads set version = version`,
      sql`delete from finet.app_downloads`,
      // audit_events rămâne doar adăugare.
      sql`update finet.audit_events set action = action`,
      sql`delete from finet.audit_events`,
    ]) {
      expect(await sqlState(() => as(A(), f.HA, statement))).toBe("42501");
    }
  });

  it("anon și authenticated nu au niciun drept pe tabelele noi", async () => {
    const rows = await f.admin<{ grantee: string; table_name: string }[]>`
      select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'finet' and table_name = any(${LEDGER_TABLES})
         and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(rows).toEqual([]);
    const cols = await f.admin<{ grantee: string }[]>`
      select grantee from information_schema.column_privileges
       where table_schema = 'finet' and table_name = any(${LEDGER_TABLES})
         and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(cols).toEqual([]);
  });

  describe("proprietarul contului (constatarea MEDIUM 1)", () => {
    const insertAccount = (owner: string | null, name: string) =>
      sql`insert into finet.accounts (household_id, name, type, currency, owner_user_id)
          values (${f.HA}, ${name}, 'cash', 'RON', ${owner})`;

    it("către un utilizator din altă gospodărie → 42501 la insert și update", async () => {
      expect(await sqlState(() => as(A(), f.HA, insertAccount(B(), "Cu B")))).toBe("42501");
      expect(
        await sqlState(() =>
          as(A(), f.HA, sql`update finet.accounts set owner_user_id = ${B()} where id = ${accA}`),
        ),
      ).toBe("42501");
      // Și către un utilizator inexistent (cheia străină singură ar da 23503, politica întâi).
      expect(await sqlState(() => as(A(), f.HA, insertAccount(randomUUID(), "Fantomă")))).toMatch(
        /^(42501|23503)$/,
      );
    });

    it("către un membru al propriei gospodării sau null → ok", async () => {
      expect(await sqlState(() => as(A(), f.HA, insertAccount(C(), "Al lui C")))).toBeNull();
      expect(await sqlState(() => as(A(), f.HA, insertAccount(A(), "Al lui A")))).toBeNull();
      expect(await sqlState(() => as(A(), f.HA, insertAccount(null, "Comun")))).toBeNull();
      expect(
        await sqlState(() =>
          as(A(), f.HA, sql`update finet.accounts set owner_user_id = ${C()} where id = ${accA}`),
        ),
      ).toBeNull();
      expect(
        await sqlState(() =>
          as(A(), f.HA, sql`update finet.accounts set owner_user_id = null where id = ${accA}`),
        ),
      ).toBeNull();
    });
  });

  describe("instalări și evenimente (constatarea MEDIUM 2)", () => {
    const install = (userId: string, installationId: string) =>
      as(
        userId,
        null,
        sql`insert into finet.client_installations (installation_id, user_id, platform)
            values (${installationId}, ${userId}, 'android')`,
      );
    const event = (userId: string, householdId: string | null, installationId: string | null) =>
      as(
        userId,
        householdId,
        sql`insert into finet.app_events (user_id, household_id, installation_id, name)
            values (${userId}, ${householdId}, ${installationId}, 'screen.view')`,
      );

    it("doi utilizatori pot folosi același installation_id, fără conflict și fără să se vadă", async () => {
      const shared = randomUUID();
      expect(await sqlState(() => install(A(), shared))).toBeNull();
      expect(await sqlState(() => install(B(), shared))).toBeNull();
      const seenByA = await as(A(), null, sql`select user_id from finet.client_installations`);
      expect(seenByA.map((r) => r.user_id)).toEqual([A()]);
      const seenByB = await as(B(), null, sql`select user_id from finet.client_installations`);
      expect(seenByB.map((r) => r.user_id)).toEqual([B()]);
      // Același utilizator, același id → unicitate per utilizator.
      expect(await sqlState(() => install(A(), shared))).toBe("23505");
      // Nu se poate înregistra o instalare pe numele altuia.
      expect(
        await sqlState(() =>
          as(
            A(),
            null,
            sql`insert into finet.client_installations (installation_id, user_id, platform)
                values (${randomUUID()}, ${B()}, 'web')`,
          ),
        ),
      ).toBe("42501");
    });

    it("eveniment cu installation_id al altui utilizator → 42501; cu al lui sau fără → ok", async () => {
      const onlyB = randomUUID();
      await install(B(), onlyB);
      expect(await sqlState(() => event(A(), f.HA, onlyB))).toBe("42501");
      expect(await sqlState(() => event(A(), f.HA, randomUUID()))).toBe("42501");
      const mine = randomUUID();
      await install(A(), mine);
      expect(await sqlState(() => event(A(), f.HA, mine))).toBeNull();
      expect(await sqlState(() => event(A(), null, null))).toBeNull();
      // Gospodăria evenimentului trebuie să fie cea curentă, iar utilizatorul cel din context.
      expect(await sqlState(() => event(A(), f.HB, null))).toBe("42501");
      expect(
        await sqlState(() =>
          as(A(), null, sql`insert into finet.app_events (user_id, name) values (${B()}, 'x.y')`),
        ),
      ).toBe("42501");
      // Formatul fix: fără text liber (de exemplu o sumă în nume sau în ecran).
      expect(
        await sqlState(() =>
          as(
            A(),
            null,
            sql`insert into finet.app_events (user_id, name, screen) values (${A()}, 'screen.view', 'Total 123,45 lei')`,
          ),
        ),
      ).toBe("23514");
      const own = await as(A(), null, sql`select user_id from finet.app_events`);
      expect(new Set(own.map((r) => r.user_id))).toEqual(new Set([A()]));
    });

    it("DELETE (revocarea usage_stats, plafonul de instalări): doar rândurile proprii", async () => {
      const a = randomUUID();
      const b = randomUUID();
      await install(A(), a);
      await install(B(), b);
      await event(A(), null, a);
      await event(B(), null, b);
      const countB = async () => {
        const [row] = await f.admin<{ i: number; e: number }[]>`
          select (select count(*)::int from finet.client_installations where user_id = ${B()}) as i,
                 (select count(*)::int from finet.app_events where user_id = ${B()}) as e`;
        return row;
      };
      const before = await countB();
      await as(A(), null, sql`delete from finet.app_events`);
      await as(A(), null, sql`delete from finet.client_installations`);
      expect(await countB()).toEqual(before);
      const [mine] = await f.admin<{ i: number; e: number }[]>`
        select (select count(*)::int from finet.client_installations where user_id = ${A()}) as i,
               (select count(*)::int from finet.app_events where user_id = ${A()}) as e`;
      expect(mine).toEqual({ i: 0, e: 0 });
    });

    it("descărcări: anonime sau proprii, fără citire", async () => {
      const dl = (userId: string | null) =>
        as(
          A(),
          null,
          sql`insert into finet.app_downloads (user_id, version, source) values (${userId}, '1.0.0', 'qr')`,
        );
      expect(await sqlState(() => dl(null))).toBeNull();
      expect(await sqlState(() => dl(A()))).toBeNull();
      expect(await sqlState(() => dl(B()))).toBe("42501");
    });
  });

  it("idempotency_keys: unic pe (gospodărie, cheie), separat între gospodării", async () => {
    const ins = (userId: string, hh: string) =>
      as(
        userId,
        hh,
        sql`insert into finet.idempotency_keys (household_id, key, request_hash)
            values (${hh}, 'cheie-comuna-0001', ${"b".repeat(64)})`,
      );
    expect(await sqlState(() => ins(A(), f.HA))).toBeNull();
    expect(await sqlState(() => ins(B(), f.HB))).toBeNull();
    expect(await sqlState(() => ins(C(), f.HA))).toBe("23505");
    const seen = await as(B(), f.HB, sql`select household_id from finet.idempotency_keys`);
    expect(seen.map((r) => r.household_id)).toEqual([f.HB]);
  });

  it("ștergerea gospodăriei (de owner) șterge în cascadă conturile, tranzacțiile și transferurile", async () => {
    const [counts] = await f.admin<{ a: number; t: number }[]>`
      select (select count(*)::int from finet.accounts where household_id = ${f.HA}) as a,
             (select count(*)::int from finet.transactions where household_id = ${f.HA}) as t`;
    expect(counts!.a).toBeGreaterThan(0);
    expect(counts!.t).toBeGreaterThan(0);
    // C (member) nu poate șterge gospodăria; A (owner) da.
    expect(
      await as(C(), f.HA, sql`delete from finet.households where id = ${f.HA} returning id`),
    ).toHaveLength(0);
    const deleted = await as(
      A(),
      f.HA,
      sql`delete from finet.households where id = ${f.HA} returning id`,
    );
    expect(deleted).toHaveLength(1);
    const [after] = await f.admin<{ a: number; t: number; c: number; v: number }[]>`
      select (select count(*)::int from finet.accounts where household_id = ${f.HA}) as a,
             (select count(*)::int from finet.transactions where household_id = ${f.HA}) as t,
             (select count(*)::int from finet.categories where household_id = ${f.HA}) as c,
             (select count(*)::int from finet.category_visibility where household_id = ${f.HA}) as v`;
    expect(after).toEqual({ a: 0, t: 0, c: 0, v: 0 });
    // Categoriile de sistem și datele lui B rămân.
    const [rest] = await f.admin<{ s: number; b: number }[]>`
      select (select count(*)::int from finet.categories where household_id is null) as s,
             (select count(*)::int from finet.transactions where household_id = ${f.HB}) as b`;
    expect(rest).toEqual({ s: 28, b: 1 });
  });

  function A() {
    return f.A.userId;
  }
  function B() {
    return f.B.userId;
  }
  function C() {
    return f.C.userId;
  }
});
