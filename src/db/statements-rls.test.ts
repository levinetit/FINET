import { createHash, randomUUID } from "node:crypto";

import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAccount } from "@/modules/accounts/accounts.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { sqlState } from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const TABLES = ["statement_imports", "statement_lines", "statement_usage_daily"];
const sha = (c: string) => c.repeat(64);

/**
 * RLS, drepturile și triggerele de integritate ale tabelelor Fazei 7 (0013_statements), ca
 * `finet_app`: vizibilitatea urmează contul (personal ⇒ doar proprietarul), legătura rând →
 * tranzacție doar în același cont și vizibilă, ștergerea rândurilor doar pentru previzualizări,
 * tranzițiile de stare ale importurilor și rândurilor.
 */
describe.skipIf(!TEST_ADMIN_URL)("extrase: RLS, drepturi și triggere (finet_app)", () => {
  let f: FamilyFixture;
  let common: string;
  let common2: string;
  let personalC: string;
  let txCommon: string;
  let txCommon2: string;
  let txPersonal: string;
  const as = (userId: string, householdId: string | null, statement: SQL) =>
    withRlsOn(f.db, { userId, householdId }, (tx) => tx.execute(statement));

  const newImport = (user: string, account: string, opts: { status?: string; c?: string } = {}) => {
    const id = randomUUID();
    return {
      id,
      run: () =>
        as(
          user,
          f.HA,
          sql`insert into finet.statement_imports (id, household_id, account_id, currency,
                created_by_user_id, bank, format, status, parser_version, balance_status,
                source_sha256, imported_at)
              values (${id}, ${f.HA}, ${account}, 'RON', ${user}, 'bt', 'pdf',
                ${opts.status ?? "previewed"}, 1, 'ok', ${sha(opts.c ?? "a")},
                ${opts.status === "imported" ? sql`now()` : sql`null`})`,
        ),
    };
  };
  const newLine = (
    user: string,
    importId: string,
    account: string,
    rowNo: number,
    tx: string | null = null,
  ) =>
    as(
      user,
      f.HA,
      sql`insert into finet.statement_lines (household_id, import_id, account_id, currency, row_no,
            occurred_on, direction, amount_minor, description, dedup_key, transaction_id)
          values (${f.HA}, ${importId}, ${account}, 'RON', ${rowNo}, '2026-11-03', 'debit', 100,
            'x', ${createHash("sha256").update(`${importId}:${rowNo}`).digest("hex")}, ${tx})`,
    );

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_stmtrls");
    const mk = async (actor: typeof f.A, name: string, owner?: string) =>
      (
        await createAccount(f.deps, actor, f.HA, {
          name,
          type: "bank",
          currency: "RON",
          ...(owner ? { ownerUserId: owner } : {}),
        })
      ).id;
    common = await mk(f.A, "Comun");
    common2 = await mk(f.A, "Comun 2");
    personalC = await mk(f.C, "Al lui C", f.C.userId);
    const tx = async (actor: typeof f.A, accountId: string) =>
      (
        await createTransaction(f.deps, actor, f.HA, {
          accountId,
          type: "expense",
          amountMinor: 100,
          occurredOn: "2026-11-03",
        })
      ).id;
    txCommon = await tx(f.A, common);
    txCommon2 = await tx(f.A, common2);
    txPersonal = await tx(f.C, personalC);
  });
  afterAll(async () => {
    await f?.close();
  });

  it("RLS ENABLE + FORCE; fără context: niciun rând; nimic pentru anon/authenticated/PUBLIC", async () => {
    const rows = await f.admin<{ relname: string; on: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'finet' and c.relkind = 'r' and c.relname = any(${TABLES})
       order by c.relname`;
    expect(rows).toEqual(TABLES.map((relname) => ({ relname, on: true, force: true })));
    const imp = newImport(f.A.userId, common);
    await imp.run();
    for (const t of TABLES) {
      expect(await f.fx.client.unsafe(`select * from finet.${t}`), t).toHaveLength(0);
    }
    const grants = await f.admin`
      select grantee from information_schema.role_table_grants
       where table_schema = 'finet' and table_name = any(${TABLES})
         and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(grants).toEqual([]);
    await as(f.A.userId, f.HA, sql`delete from finet.statement_imports where id = ${imp.id}`);
  });

  it("drepturile lui finet_app: fără UPDATE pe tabel, doar pe coloanele de stare", async () => {
    const table = await f.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and grantee = 'finet_app' and table_name = any(${TABLES})
       order by 1, 2`;
    expect(table.map((r) => `${r.table_name}:${r.privilege_type}`)).toEqual([
      "statement_imports:DELETE",
      "statement_imports:INSERT",
      "statement_imports:SELECT",
      "statement_lines:DELETE",
      "statement_lines:INSERT",
      "statement_lines:SELECT",
      "statement_usage_daily:INSERT",
      "statement_usage_daily:SELECT",
    ]);
    const cols = await f.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.column_privileges
       where table_schema = 'finet' and grantee = 'finet_app' and privilege_type = 'UPDATE'
         and table_name = any(${TABLES}) order by 1, 2`;
    expect(cols.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "statement_imports.cancelled_at",
      "statement_imports.cancelled_by_user_id",
      "statement_imports.duplicate_count",
      "statement_imports.error_code",
      "statement_imports.imported_at",
      "statement_imports.imported_count",
      "statement_imports.new_count",
      "statement_imports.status",
      "statement_imports.updated_at",
      "statement_lines.state",
      "statement_lines.transaction_id",
      "statement_usage_daily.count",
      "statement_usage_daily.updated_at",
    ]);
    expect(
      await sqlState(() =>
        as(f.A.userId, f.HA, sql`update finet.statement_imports set source_sha256 = ${sha("f")}`),
      ),
    ).toBe("42501");
    expect(
      await sqlState(() => as(f.A.userId, f.HA, sql`delete from finet.statement_usage_daily`)),
    ).toBe("42501");
  });

  it("cont PERSONAL: doar proprietarul creează și vede importul și rândurile lui", async () => {
    const byA = newImport(f.A.userId, personalC, { c: "b" });
    expect(await sqlState(byA.run)).toBe("42501");
    const byC = newImport(f.C.userId, personalC, { c: "b" });
    await byC.run();
    await newLine(f.C.userId, byC.id, personalC, 1);
    const seen = (user: string) =>
      as(user, f.HA, sql`select id from finet.statement_imports where id = ${byC.id}`);
    expect(await seen(f.C.userId)).toHaveLength(1);
    expect(await seen(f.A.userId)).toHaveLength(0);
    expect(
      await as(
        f.A.userId,
        f.HA,
        sql`select id from finet.statement_lines where import_id = ${byC.id}`,
      ),
    ).toHaveLength(0);
    // Alt membru nu poate scrie un rând pe contul personal al lui C (nici cu id-ul importului).
    expect(await sqlState(() => newLine(f.A.userId, byC.id, personalC, 2))).toBe("42501");
    // Alt utilizator în altă gospodărie: nimic.
    expect(
      await as(f.B.userId, f.HB, sql`select id from finet.statement_imports where id = ${byC.id}`),
    ).toHaveLength(0);
    // created_by trebuie să fie utilizatorul curent.
    const forged = randomUUID();
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.statement_imports (id, household_id, account_id, currency,
                created_by_user_id, bank, format, parser_version, balance_status, source_sha256)
              values (${forged}, ${f.HA}, ${common}, 'RON', ${f.C.userId}, 'bt', 'pdf', 1, 'ok', ${sha("c")})`,
        ),
      ),
    ).toBe("42501");
  });

  it("legătura rând → tranzacție: doar o tranzacție din ACELAȘI cont și vizibilă", async () => {
    const imp = newImport(f.A.userId, common, { c: "d" });
    await imp.run();
    // Tranzacția altui cont (comun, vizibil) → refuz.
    expect(await sqlState(() => newLine(f.A.userId, imp.id, common, 1, txCommon2))).toBe("23503");
    // Tranzacția din contul personal al lui C (invizibilă pentru A) → refuz.
    expect(await sqlState(() => newLine(f.A.userId, imp.id, common, 1, txPersonal))).toBe("23503");
    await newLine(f.A.userId, imp.id, common, 1);
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.statement_lines set transaction_id = ${txPersonal} where import_id = ${imp.id}`,
        ),
      ),
    ).toBe("23503");
    await as(
      f.A.userId,
      f.HA,
      sql`update finet.statement_lines set transaction_id = ${txCommon}, state = 'imported' where import_id = ${imp.id}`,
    );
    // Legătura nu se mută pe altă tranzacție.
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.statement_lines set transaction_id = ${txCommon2} where import_id = ${imp.id}`,
        ),
      ),
    ).toMatch(/23503|23514/);
  });

  it("ștergerea rândurilor: doar pentru o previzualizare; tranzițiile de stare sunt verificate", async () => {
    const imp = newImport(f.A.userId, common, { c: "e" });
    await imp.run();
    await newLine(f.A.userId, imp.id, common, 1);
    await newLine(f.A.userId, imp.id, common, 2);
    const del = (user: string) =>
      as(
        user,
        f.HA,
        sql`delete from finet.statement_lines where import_id = ${imp.id} and row_no = 2 returning id`,
      );
    expect(await del(f.A.userId)).toHaveLength(1);
    // Confirmare (ordinea serviciului): rândurile → imported cât importul e `previewed`, apoi
    // importul → imported.
    await as(
      f.A.userId,
      f.HA,
      sql`update finet.statement_lines set state = 'imported' where import_id = ${imp.id}`,
    );
    await as(
      f.A.userId,
      f.HA,
      sql`update finet.statement_imports set status = 'imported', imported_at = now(), imported_count = 1 where id = ${imp.id}`,
    );
    // După confirmare: niciun rând nou, nicio schimbare de stare în afara anulării.
    expect(await sqlState(() => newLine(f.A.userId, imp.id, common, 3))).toBe("42501");
    // Rândurile unui import confirmat nu se șterg; importul confirmat nu se șterge.
    expect(
      await as(
        f.A.userId,
        f.HA,
        sql`delete from finet.statement_lines where import_id = ${imp.id} returning id`,
      ),
    ).toHaveLength(0);
    expect(
      await as(
        f.A.userId,
        f.HA,
        sql`delete from finet.statement_imports where id = ${imp.id} returning id`,
      ),
    ).toHaveLength(0);
    const upd = (set: SQL) =>
      sqlState(() =>
        as(f.A.userId, f.HA, sql`update finet.statement_imports set ${set} where id = ${imp.id}`),
      );
    expect(await upd(sql`status = 'previewed', imported_at = null`)).toBe("23514");
    expect(await upd(sql`status = 'failed'`)).toBe("23514");
    expect(await upd(sql`imported_at = now() + interval '1 day'`)).toBe("23514");
    expect(await upd(sql`imported_count = 7`)).toBe("23514");
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.statement_lines set state = 'new' where import_id = ${imp.id}`,
        ),
      ),
    ).toBe("23514");
    // Anularea (ordinea serviciului): rândurile → cancelled cât importul e `imported`, apoi
    // importul → cancelled; apoi totul e final.
    await as(
      f.A.userId,
      f.HA,
      sql`update finet.statement_lines set state = 'cancelled' where import_id = ${imp.id}`,
    );
    expect(
      await upd(
        sql`status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = ${f.A.userId}`,
      ),
    ).toBeNull();
    expect(
      await upd(sql`status = 'imported', cancelled_at = null, cancelled_by_user_id = null`),
    ).toBe("23514");
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.statement_lines set state = 'imported' where import_id = ${imp.id}`,
        ),
      ),
    ).toBe("23514");
    // După anulare, același fișier poate fi previzualizat din nou pe același cont.
    await newImport(f.A.userId, common, { c: "e" }).run();
    expect(await sqlState(() => newImport(f.A.userId, common, { c: "e" }).run())).toBe("23505");
  });
  it("inserarea rândurilor: doar în previzualizări, doar stări inițiale, fără legătură", async () => {
    const imp = newImport(f.A.userId, common, { c: "1" });
    await imp.run();
    const insert = (state: string, tx: string | null) =>
      as(
        f.A.userId,
        f.HA,
        sql`insert into finet.statement_lines (household_id, import_id, account_id, currency,
              row_no, occurred_on, direction, amount_minor, description, dedup_key, state,
              transaction_id)
            values (${f.HA}, ${imp.id}, ${common}, 'RON', 9, '2026-11-03', 'debit', 100, 'x',
              ${sha("9")}, ${state}, ${tx})`,
      );
    expect(await sqlState(() => insert("imported", null))).toBe("42501");
    expect(await sqlState(() => insert("cancelled", null))).toBe("42501");
    expect(await sqlState(() => insert("new", txCommon))).toBe("42501");
    // Un import nu se inserează direct ca `imported`/`cancelled`.
    expect(
      await sqlState(() => newImport(f.A.userId, common, { status: "imported", c: "2" }).run()),
    ).toBe("42501");
  });

  it("legătura spre tranzacție: nu se golește și nu se repune de aplicație; o golește doar ștergerea tranzacției", async () => {
    const imp = newImport(f.A.userId, common, { c: "3" });
    await imp.run();
    await newLine(f.A.userId, imp.id, common, 1);
    const own = await createTransaction(f.deps, f.A, f.HA, {
      accountId: common,
      type: "expense",
      amountMinor: 100,
      occurredOn: "2026-11-03",
    });
    const own2 = await createTransaction(f.deps, f.A, f.HA, {
      accountId: common,
      type: "expense",
      amountMinor: 100,
      occurredOn: "2026-11-04",
    });
    const upd = (set: SQL) =>
      sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`update finet.statement_lines set ${set} where import_id = ${imp.id}`,
        ),
      );
    // Legătura doar odată cu `imported`.
    expect(await upd(sql`transaction_id = ${own.id}`)).toBe("23514");
    expect(await upd(sql`transaction_id = ${own.id}, state = 'imported'`)).toBeNull();
    await as(
      f.A.userId,
      f.HA,
      sql`update finet.statement_imports set status = 'imported', imported_at = now() where id = ${imp.id}`,
    );
    expect(await upd(sql`transaction_id = null`)).toBe("23514");
    expect(await upd(sql`transaction_id = ${own2.id}`)).toBe("23514");
    // Ștergerea tranzacției (ca aplicația) pune NULL prin cheia străină; rândul rămâne `imported`.
    await as(f.A.userId, f.HA, sql`delete from finet.transactions where id = ${own.id}`);
    const [row] = await f.admin<{ state: string; transaction_id: string | null }[]>`
      select state, transaction_id from finet.statement_lines where import_id = ${imp.id}`;
    expect(row).toEqual({ state: "imported", transaction_id: null });
    // NULL → altă tranzacție după ce a fost legată: refuz.
    expect(await upd(sql`transaction_id = ${own2.id}`)).toBe("23514");
  });
});
