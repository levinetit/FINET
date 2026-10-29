import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAccount } from "@/modules/accounts/accounts.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  sqlState,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Tabelele Fazei 3 (0004_budgets_goals_tags.sql). */
const PLANNING_TABLES = ["budgets", "goals", "tag_visibility", "tags", "transaction_tags"];

describe.skipIf(!TEST_ADMIN_URL)("RLS și drepturi pe tabelele planificării (finet_app)", () => {
  let f: LedgerFixture;
  let accA: string;
  let accB: string;
  let txA: string;
  let txB: string;
  let tagB: string;
  let groceries: string;
  let salary: string;
  const as = (userId: string, householdId: string | null, statement: SQL) =>
    withRlsOn(f.db, { userId, householdId }, (tx) => tx.execute(statement));
  const A = () => f.A.userId;
  const B = () => f.B.userId;
  const C = () => f.C.userId;

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_prls");
    accA = (await createAccount(f.deps, f.A, f.HA, { name: "A", type: "bank", currency: "RON" }))
      .id;
    accB = (await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" }))
      .id;
    txA = (
      await createTransaction(f.deps, f.A, f.HA, {
        accountId: accA,
        type: "expense",
        amountMinor: 10,
        occurredOn: "2026-10-01",
      })
    ).id;
    txB = (
      await createTransaction(f.deps, f.B, f.HB, {
        accountId: accB,
        type: "expense",
        amountMinor: 10,
        occurredOn: "2026-10-01",
      })
    ).id;
    const [row] = await as(
      B(),
      f.HB,
      sql`insert into finet.tags (household_id, name) values (${f.HB}, 'Secret B') returning id`,
    );
    tagB = String(row!.id);
    groceries = await systemCategoryId(f.admin, "expense.groceries");
    salary = await systemCategoryId(f.admin, "income.salary");
  });
  afterAll(async () => {
    await f?.close();
  });

  it("RLS ENABLE + FORCE pe toate tabelele noi; 5 etichete de sistem", async () => {
    const rows = await f.admin<{ relname: string; on: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'finet' and c.relkind = 'r' and c.relname = any(${PLANNING_TABLES})
       order by c.relname`;
    expect(rows).toEqual(PLANNING_TABLES.map((relname) => ({ relname, on: true, force: true })));
    const sys = await f.admin<{ system_key: string }[]>`
      select system_key from finet.tags where household_id is null order by sort_order`;
    expect(sys.map((r) => r.system_key)).toEqual([
      "personal",
      "family",
      "children",
      "deductible",
      "gift",
    ]);
  });

  it("fără context: niciun rând (nici etichetele de sistem); context străin: nimic", async () => {
    for (const table of PLANNING_TABLES) {
      expect(await f.fx.client.unsafe(`select * from finet.${table}`), table).toHaveLength(0);
    }
    for (const table of PLANNING_TABLES) {
      expect(await as(A(), f.HB, sql.raw(`select * from finet.${table}`)), table).toHaveLength(0);
    }
    const tags = await as(A(), f.HA, sql`select name from finet.tags`);
    expect(tags.map((t) => t.name)).not.toContain("Secret B");
    expect(tags).toHaveLength(5);
  });

  it("insert cu household_id străin → 42501", async () => {
    for (const statement of [
      sql`insert into finet.tags (household_id, name) values (${f.HB}, 'X')`,
      sql`insert into finet.tags (household_id, name, system_key) values (null, 'X', 'x_test')`,
      sql`insert into finet.budgets (household_id, amount_minor, currency) values (${f.HB}, 100, 'RON')`,
      sql`insert into finet.goals (household_id, name, target_minor, currency) values (${f.HB}, 'X', 100, 'RON')`,
    ]) {
      expect(await sqlState(() => as(A(), f.HA, statement))).toBe("42501");
    }
    // transaction_tags: triggerul BEFORE rulează înaintea politicii și nu vede eticheta lui B
    // (RLS) → 23503; oricum respins, fără scurgere de date.
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.transaction_tags (transaction_id, tag_id, household_id) values (${txB}, ${tagB}, ${f.HB})`,
        ),
      ),
    ).toBe("23503");
  });

  it("legături: tranzacția sau eticheta altei gospodării → respinse", async () => {
    // Eticheta lui B, pe o tranzacție a lui A: invizibilă → 23503 (trigger).
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.transaction_tags (transaction_id, tag_id, household_id) values (${txA}, ${tagB}, ${f.HA})`,
        ),
      ),
    ).toBe("23503");
    // Tranzacția lui B cu household_id-ul lui A: din 0012 politica cere o tranzacție VIZIBILĂ,
    // deci refuzul vine înaintea cheii compuse (id, household_id): 42501.
    const [own] = await as(
      A(),
      f.HA,
      sql`insert into finet.tags (household_id, name) values (${f.HA}, 'Al meu') returning id`,
    );
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.transaction_tags (transaction_id, tag_id, household_id) values (${txB}, ${own!.id}, ${f.HA})`,
        ),
      ),
    ).toBe("42501");
    // Eticheta de sistem pe tranzacția proprie: ok; vizibilitatea doar pentru cele de sistem.
    await as(
      A(),
      f.HA,
      sql`insert into finet.transaction_tags (transaction_id, tag_id, household_id)
          select ${txA}, id, ${f.HA} from finet.tags where system_key = 'gift'`,
    );
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.tag_visibility (household_id, tag_id) values (${f.HA}, ${own!.id})`,
        ),
      ),
    ).toBe("23503");
    // Ștergerea tranzacției șterge legăturile.
    await f.admin`delete from finet.transactions where id = ${txA}`;
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transaction_tags where transaction_id = ${txA}`;
    expect(n!.n).toBe(0);
  });

  it("etichetele de sistem nu se modifică și nu se șterg (0 rânduri)", async () => {
    expect(
      await as(
        A(),
        f.HA,
        sql`update finet.tags set name = 'X' where household_id is null returning id`,
      ),
    ).toHaveLength(0);
    expect(
      await as(A(), f.HA, sql`delete from finet.tags where household_id is null returning id`),
    ).toHaveLength(0);
    expect(
      await as(A(), f.HA, sql`update finet.tags set name = 'X' where id = ${tagB} returning id`),
    ).toHaveLength(0);
  });

  it("bugete: categorie de venit → 23514; categoria altei gospodării → 23503; personal doar al proprietarului", async () => {
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.budgets (household_id, category_id, amount_minor, currency) values (${f.HA}, ${salary}, 100, 'RON')`,
        ),
      ),
    ).toBe("23514");
    const [catB] = await as(
      B(),
      f.HB,
      sql`insert into finet.categories (household_id, name, kind) values (${f.HB}, 'Cat B', 'expense') returning id`,
    );
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.budgets (household_id, category_id, amount_minor, currency) values (${f.HA}, ${catB!.id}, 100, 'RON')`,
        ),
      ),
    ).toBe("23503");
    // Buget personal pentru altcineva → 42501; pentru sine → ok, invizibil lui C.
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.budgets (household_id, amount_minor, currency, scope, user_id) values (${f.HA}, 100, 'RON', 'personal', ${C()})`,
        ),
      ),
    ).toBe("42501");
    const [mine] = await as(
      A(),
      f.HA,
      sql`insert into finet.budgets (household_id, category_id, amount_minor, currency, scope, user_id)
          values (${f.HA}, ${groceries}, 100, 'RON', 'personal', ${A()}) returning id`,
    );
    expect(
      await as(C(), f.HA, sql`select id from finet.budgets where id = ${mine!.id}`),
    ).toHaveLength(0);
    expect(
      await as(
        C(),
        f.HA,
        sql`update finet.budgets set warn_pct = 50 where id = ${mine!.id} returning id`,
      ),
    ).toHaveLength(0);
    expect(
      await as(C(), f.HA, sql`delete from finet.budgets where id = ${mine!.id} returning id`),
    ).toHaveLength(0);
    expect(
      await as(A(), f.HA, sql`select id from finet.budgets where id = ${mine!.id}`),
    ).toHaveLength(1);
    // Personal fără user_id: politica (WITH CHECK, înaintea CHECK-ului) îl respinge → 42501.
    expect(
      await sqlState(() =>
        as(
          A(),
          f.HA,
          sql`insert into finet.budgets (household_id, amount_minor, currency, scope) values (${f.HA}, 100, 'RON', 'personal')`,
        ),
      ),
    ).toBe("42501");
    // Domeniul gospodăriei cu user_id, plafonul și warn_pct → 23514.
    for (const statement of [
      sql`insert into finet.budgets (household_id, amount_minor, currency, scope, user_id) values (${f.HA}, 100, 'RON', 'household', ${A()})`,
      sql`insert into finet.budgets (household_id, amount_minor, currency) values (${f.HA}, 10000000000001, 'RON')`,
      sql`insert into finet.budgets (household_id, amount_minor, currency) values (${f.HA}, 0, 'RON')`,
      sql`insert into finet.budgets (household_id, amount_minor, currency, warn_pct) values (${f.HA}, 100, 'RON', 101)`,
      sql`insert into finet.budgets (household_id, amount_minor, currency, warn_pct) values (${f.HA}, 100, 'RON', 0)`,
    ]) {
      expect(await sqlState(() => as(A(), f.HA, statement))).toBe("23514");
    }
  });

  it("bugetul general activ e unic pe (gospodărie, domeniu, monedă); arhivatul nu contează", async () => {
    const ins = sql`insert into finet.budgets (household_id, amount_minor, currency) values (${f.HA}, 100, 'EUR') returning id`;
    const [first] = await as(A(), f.HA, ins);
    expect(await sqlState(() => as(A(), f.HA, ins))).toBe("23505");
    await as(A(), f.HA, sql`update finet.budgets set archived_at = now() where id = ${first!.id}`);
    expect(await as(A(), f.HA, ins)).toHaveLength(1);
  });

  it("obiective: cont al altei gospodării sau în altă monedă → 23503; progres incoerent → 23514", async () => {
    for (const statement of [
      sql`insert into finet.goals (household_id, name, target_minor, currency, account_id) values (${f.HA}, 'X', 100, 'RON', ${accB})`,
      sql`insert into finet.goals (household_id, name, target_minor, currency, account_id) values (${f.HA}, 'X', 100, 'EUR', ${accA})`,
    ]) {
      expect(await sqlState(() => as(A(), f.HA, statement))).toBe("23503");
    }
    for (const statement of [
      sql`insert into finet.goals (household_id, name, target_minor, currency, saved_minor, status) values (${f.HA}, 'X', 100, 'RON', 100, 'active')`,
      sql`insert into finet.goals (household_id, name, target_minor, currency, saved_minor, status) values (${f.HA}, 'X', 100, 'RON', 99, 'achieved')`,
      sql`insert into finet.goals (household_id, name, target_minor, currency, saved_minor) values (${f.HA}, 'X', 100, 'RON', -1)`,
      sql`insert into finet.goals (household_id, name, target_minor, currency) values (${f.HA}, 'X', 0, 'RON')`,
      sql`insert into finet.goals (household_id, name, target_minor, currency) values (${f.HA}, ' X', 10, 'RON')`,
    ]) {
      expect(await sqlState(() => as(A(), f.HA, statement))).toBe("23514");
    }
    // Abandonat: liber față de progres.
    await as(
      A(),
      f.HA,
      sql`insert into finet.goals (household_id, name, target_minor, currency, saved_minor, status) values (${f.HA}, 'Ab', 100, 'RON', 500, 'abandoned')`,
    );
  });

  it("ștergerea unui cont gol desface legătura obiectivului (SET NULL doar pe account_id)", async () => {
    const empty = (
      await createAccount(f.deps, f.A, f.HA, { name: "Gol", type: "savings", currency: "RON" })
    ).id;
    const [g] = await as(
      A(),
      f.HA,
      sql`insert into finet.goals (household_id, name, target_minor, currency, account_id) values (${f.HA}, 'Vacanță', 100, 'RON', ${empty}) returning id`,
    );
    await as(A(), f.HA, sql`delete from finet.accounts where id = ${empty}`);
    const [row] = await f.admin<
      { account_id: string | null; household_id: string; currency: string }[]
    >`
      select account_id, household_id, currency from finet.goals where id = ${String(g!.id)}`;
    expect(row).toEqual({ account_id: null, household_id: f.HA, currency: "RON" });
  });

  it("ștergerea categoriei personalizate șterge bugetele ei (cascadă)", async () => {
    const [cat] = await as(
      A(),
      f.HA,
      sql`insert into finet.categories (household_id, name, kind) values (${f.HA}, 'Hobby', 'expense') returning id`,
    );
    await as(
      A(),
      f.HA,
      sql`insert into finet.budgets (household_id, category_id, amount_minor, currency) values (${f.HA}, ${cat!.id}, 100, 'RON')`,
    );
    await as(A(), f.HA, sql`delete from finet.categories where id = ${cat!.id}`);
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.budgets where category_id = ${String(cat!.id)}`;
    expect(n!.n).toBe(0);
  });

  it("UPDATE pe coloane interzise → 42501", async () => {
    for (const statement of [
      sql`update finet.tags set household_id = household_id`,
      sql`update finet.tags set system_key = system_key`,
      sql`update finet.tags set id = id`,
      sql`update finet.tag_visibility set tag_id = tag_id`,
      sql`update finet.tag_visibility set household_id = household_id`,
      sql`update finet.transaction_tags set tag_id = tag_id`,
      sql`update finet.transaction_tags set transaction_id = transaction_id`,
      sql`delete from finet.tag_visibility`,
      sql`update finet.budgets set category_id = category_id`,
      sql`update finet.budgets set currency = currency`,
      sql`update finet.budgets set scope = scope`,
      sql`update finet.budgets set user_id = user_id`,
      sql`update finet.budgets set household_id = household_id`,
      sql`update finet.goals set currency = currency`,
      sql`update finet.goals set household_id = household_id`,
      sql`update finet.goals set created_at = now()`,
    ]) {
      expect(await sqlState(() => as(A(), f.HA, statement))).toBe("42501");
    }
  });

  it("anon și authenticated nu au niciun drept pe tabelele noi", async () => {
    const rows = await f.admin<{ grantee: string }[]>`
      select grantee from information_schema.role_table_grants
       where table_schema = 'finet' and table_name = any(${PLANNING_TABLES})
         and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(rows).toEqual([]);
    const cols = await f.admin<{ grantee: string }[]>`
      select grantee from information_schema.column_privileges
       where table_schema = 'finet' and table_name = any(${PLANNING_TABLES})
         and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(cols).toEqual([]);
  });
});
