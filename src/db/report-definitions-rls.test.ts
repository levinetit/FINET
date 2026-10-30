import { randomUUID } from "node:crypto";

import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { sqlState } from "@/modules/ledger/testing";
import { SYSTEM_REPORTS } from "@/modules/report-definitions/system-definitions";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * 0018_report_definitions ca `finet_app` (ADR 0023): RLS ENABLE + FORCE, rapoartele de sistem
 * citibile și neschimbabile, rapoartele gospodăriei izolate, drepturile pe coloane, CHECK-urile
 * (sistem ⇔ fără gospodărie; forma regulilor) și plafonul pe gospodărie.
 */
describe.skipIf(!TEST_ADMIN_URL)("0018: report_definitions (finet_app)", () => {
  let f: FamilyFixture;
  let outsider: { userId: string };
  const rules =
    '{"v":1,"combine":"any","include":[],"exclude":[],"kinds":["product"],"categoryIds":[],"tagIds":[]}';
  const as = (userId: string, householdId: string | null, statement: SQL) =>
    withRlsOn(f.db, { userId, householdId }, (tx) => tx.execute(statement));
  const insert = (
    userId: string,
    hh: string,
    name: string,
    over: {
      household?: string | null;
      isSystem?: boolean;
      author?: string | null;
      rules?: string;
    } = {},
  ) => {
    const id = randomUUID();
    const household = over.household === undefined ? hh : over.household;
    return {
      id,
      run: () =>
        as(
          userId,
          hh,
          sql`insert into finet.report_definitions (id, household_id, name, rules, is_system, created_by_user_id)
              values (${id}, ${household}, ${name}, ${over.rules ?? rules}::jsonb,
                ${over.isSystem ?? false}, ${over.author === undefined ? userId : over.author})`,
        ),
    };
  };

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_repdef_rls");
    outsider = await f.newUser("Străin");
  });
  afterAll(async () => {
    await f?.close();
  });

  it("RLS ENABLE + FORCE; PUBLIC/anon nu au drepturi; UPDATE doar pe coloanele permise", async () => {
    const [c] = await f.admin<{ rls: boolean; force: boolean; acl: string | null }[]>`
      select relrowsecurity as rls, relforcerowsecurity as force, relacl::text as acl
        from pg_class where oid = 'finet.report_definitions'::regclass`;
    expect(c).toMatchObject({ rls: true, force: true });
    expect(c!.acl).not.toMatch(/(^|[{,])=/); // fără PUBLIC
    const perms = await f.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and table_name = 'report_definitions' and grantee = 'finet_app'
       order by privilege_type`;
    expect(perms.map((p) => p.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT"]);
    const cols = await f.admin<{ column_name: string }[]>`
      select column_name from information_schema.column_privileges
       where table_schema = 'finet' and table_name = 'report_definitions' and grantee = 'finet_app'
         and privilege_type = 'UPDATE' order by column_name`;
    expect(cols.map((r) => r.column_name)).toEqual([
      "advice",
      "archived",
      "description",
      "name",
      "rules",
      "updated_at",
    ]);
    const other = await f.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where table_name = 'report_definitions' and grantee in ('anon', 'authenticated', 'PUBLIC')`;
    expect(other[0]!.n).toBe(0);
  });

  it("câmpurile fixe nu se schimbă (42501)", async () => {
    const r = insert(f.A.userId, f.HA, "Fix");
    await r.run();
    for (const statement of [
      sql`update finet.report_definitions set household_id = ${f.HB} where id = ${r.id}`,
      sql`update finet.report_definitions set is_system = true where id = ${r.id}`,
      sql`update finet.report_definitions set created_by_user_id = null where id = ${r.id}`,
      sql`update finet.report_definitions set id = gen_random_uuid() where id = ${r.id}`,
      sql`update finet.report_definitions set created_at = now() where id = ${r.id}`,
    ]) {
      expect(await sqlState(() => as(f.A.userId, f.HA, statement))).toBe("42501");
    }
  });

  it("sistem: citibil pentru orice utilizator autentificat; invizibil fără utilizator; nescriibil", async () => {
    const count = async (userId: string | null, hh: string | null) => {
      const rows = await withRlsOn(f.db, { userId, householdId: hh }, (tx) =>
        tx.execute(sql`select id from finet.report_definitions where is_system`),
      );
      return rows.length;
    };
    expect(await count(f.A.userId, f.HA)).toBe(SYSTEM_REPORTS.length);
    expect(await count(f.B.userId, f.HB)).toBe(SYSTEM_REPORTS.length);
    // un utilizator fără gospodărie curentă încă le vede (sunt publice între membrii aplicației)
    expect(await count(outsider.userId, null)).toBe(SYSTEM_REPORTS.length);
    expect(await count(null, null)).toBe(0);
    const sys = SYSTEM_REPORTS[0]!.id;
    const upd = await as(
      f.A.userId,
      f.HA,
      sql`update finet.report_definitions set name = 'x' where id = ${sys}`,
    );
    expect(upd.count).toBe(0);
    const del = await as(
      f.A.userId,
      f.HA,
      sql`delete from finet.report_definitions where id = ${sys}`,
    );
    expect(del.count).toBe(0);
    // inserarea unui rând de sistem: RLS (household NULL) sau CHECK
    for (const over of [
      { household: null, isSystem: true, author: null },
      { household: null, isSystem: false },
      { isSystem: true },
    ]) {
      const code = await sqlState(() =>
        insert(f.A.userId, f.HA, `Sistem ${randomUUID()}`, over).run(),
      );
      expect(["42501", "23514"], JSON.stringify(over)).toContain(code);
    }
  });

  it("rândurile gospodăriei: izolate; scrierea cere gospodăria curentă și autorul = utilizatorul", async () => {
    const own = insert(f.A.userId, f.HA, "A privat");
    await own.run();
    const seen = async (userId: string, hh: string) =>
      (await as(userId, hh, sql`select id from finet.report_definitions where id = ${own.id}`))
        .length;
    expect(await seen(f.A.userId, f.HA)).toBe(1);
    expect(await seen(f.C.userId, f.HA)).toBe(1); // alt membru
    expect(await seen(f.B.userId, f.HB)).toBe(0); // altă gospodărie
    // B nu poate «forța» contextul HA (nu e membru)
    expect(await seen(f.B.userId, f.HA)).toBe(0);
    expect(await sqlState(() => insert(f.B.userId, f.HA, "Intrus").run())).toBe("42501");
    // gospodărie străină în rând
    expect(
      await sqlState(() => insert(f.A.userId, f.HA, "Străin", { household: f.HB }).run()),
    ).toBe("42501");
    // autor fals
    expect(
      await sqlState(() => insert(f.A.userId, f.HA, "Autor fals", { author: f.C.userId }).run()),
    ).toBe("42501");
    // B nu poate modifica / șterge rândul lui A
    const upd = await as(
      f.B.userId,
      f.HB,
      sql`update finet.report_definitions set name = 'x' where id = ${own.id}`,
    );
    expect(upd.count).toBe(0);
    const del = await as(
      f.B.userId,
      f.HB,
      sql`delete from finet.report_definitions where id = ${own.id}`,
    );
    expect(del.count).toBe(0);
    // membrul HA îl poate modifica
    const ok = await as(
      f.C.userId,
      f.HA,
      sql`update finet.report_definitions set name = 'A privat 2' where id = ${own.id}`,
    );
    expect(ok.count).toBe(1);
  });

  it("CHECK-uri: forma regulilor, mărimea, nume și texte", async () => {
    const bad = async (name: string, over: { rules?: string }) =>
      sqlState(() => insert(f.A.userId, f.HA, name, over).run());
    expect(await bad("R1", { rules: '{"v":2}' })).toBe("23514");
    expect(await bad("R2", { rules: "[]" })).toBe("23514");
    expect(await bad("R3", { rules: '{"v":1,"x":"' + "x".repeat(9000) + '"}' })).toBe("23514");
    expect(await bad("R4", { rules: '{"v":1}' })).toBeNull();
    expect(await bad("", {})).toBe("23514");
    expect(await bad(" spații ", {})).toBe("23514");
    expect(await bad("x".repeat(81), {})).toBe("23514");
    const id = randomUUID();
    expect(
      await sqlState(() =>
        as(
          f.A.userId,
          f.HA,
          sql`insert into finet.report_definitions (id, household_id, name, rules, advice, created_by_user_id)
          values (${id}, ${f.HA}, 'Sfat lung', ${rules}::jsonb, ${"x".repeat(501)}, ${f.A.userId})`,
        ),
      ),
    ).toBe("23514");
  });

  it("nume unic (fără diferență de litere) printre cele active ale gospodăriei; arhivatele nu blochează", async () => {
    expect(await sqlState(() => insert(f.A.userId, f.HA, "Unic").run())).toBeNull();
    expect(await sqlState(() => insert(f.C.userId, f.HA, "UNIC").run())).toBe("23505");
    expect(await sqlState(() => insert(f.B.userId, f.HB, "Unic").run())).toBeNull();
    await as(
      f.A.userId,
      f.HA,
      sql`update finet.report_definitions set archived = true where lower(name) = 'unic'`,
    );
    expect(await sqlState(() => insert(f.C.userId, f.HA, "unic").run())).toBeNull();
  });

  it("ștergerea gospodăriei șterge rapoartele ei; ștergerea autorului le păstrează (SET NULL)", async () => {
    const author = await f.newUser("Autor");
    await f.addMember(f.A, f.HA, author);
    const r = insert(author.userId, f.HA, "Al autorului");
    await r.run();
    await f.admin`delete from finet.users where id = ${author.userId}`;
    const [row] = await f.admin<{ created_by_user_id: string | null }[]>`
      select created_by_user_id from finet.report_definitions where id = ${r.id}`;
    expect(row).toEqual({ created_by_user_id: null });
    await f.admin`delete from finet.households where id = ${f.HB}`;
    const [left] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.report_definitions where household_id = ${f.HB}`;
    expect(left!.n).toBe(0);
    const [sys] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.report_definitions where is_system`;
    expect(sys!.n).toBe(SYSTEM_REPORTS.length);
  });
});
