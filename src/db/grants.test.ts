import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";

import { withRlsOn } from "./index";
import { TEST_ADMIN_URL } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Codul SQLSTATE al erorii (postgres.js / DrizzleQueryError cu `cause`). */
async function sqlState(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const e = error as { code?: unknown; cause?: { code?: unknown } };
    return String(e.cause?.code ?? e.code ?? "fără cod");
  }
}

/** M5: drepturile `finet_app` pe tabelele de autentificare sunt pe coloane. */
describe.skipIf(!TEST_ADMIN_URL)("drepturi pe coloane pentru finet_app (M5)", () => {
  let fx: AuthFixture;
  const U = randomUUID();
  const V = randomUUID();

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_grants");
    for (const [id, email] of [
      [U, "u@exemplu.ro"],
      [V, "v@exemplu.ro"],
    ] as const) {
      await fx.db.execute(
        sql`insert into finet.users (id, email, name) values (${id}, ${email}, 'X')`,
      );
    }
    await fx.scratch.admin`
      insert into finet.auth_accounts (user_id, provider_id, account_id, password)
      values (${U}, 'credential', ${U}, 'hash-fictiv')`;
  });

  afterAll(async () => {
    await fx?.close();
  });

  it.each([
    ["is_platform_admin", sql`update finet.users set is_platform_admin = true`],
    ["status", sql`update finet.users set status = 'active'`],
    ["email", sql`update finet.users set email = 'alt@exemplu.ro'`],
    ["id", sql`update finet.users set id = gen_random_uuid()`],
    ["auth_accounts.user_id", sql`update finet.auth_accounts set user_id = user_id`],
    ["auth_accounts.provider_id", sql`update finet.auth_accounts set provider_id = 'x'`],
    ["auth_sessions.user_id", sql`update finet.auth_sessions set user_id = user_id`],
    ["auth_sessions.token", sql`update finet.auth_sessions set token = token`],
  ])("UPDATE %s → 42501", async (_label, statement) => {
    expect(await sqlState(() => fx.db.execute(statement))).toBe("42501");
  });

  it("INSERT în users cu is_platform_admin sau status → 42501; fără ele merge", async () => {
    expect(
      await sqlState(() =>
        fx.db.execute(
          sql`insert into finet.users (id, email, name, is_platform_admin)
              values (gen_random_uuid(), 'admin@exemplu.ro', 'A', true)`,
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlState(() =>
        fx.db.execute(
          sql`insert into finet.users (id, email, name, status)
              values (gen_random_uuid(), 'st@exemplu.ro', 'S', 'active')`,
        ),
      ),
    ).toBe("42501");
    const [row] = await fx.scratch.admin<{ status: string; is_platform_admin: boolean }[]>`
      select status, is_platform_admin from finet.users where id = ${U}`;
    expect(row).toEqual({ status: "active", is_platform_admin: false });
  });

  it("coloanele necesare aplicației rămân scriibile (nume, parolă)", async () => {
    await fx.db.execute(
      sql`update finet.users set name = 'Nume nou', updated_at = now() where id = ${U}`,
    );
    await fx.db.execute(
      sql`update finet.auth_accounts set password = 'alt-hash', updated_at = now() where user_id = ${U}`,
    );
    const [row] = await fx.scratch.admin<
      { name: string }[]
    >`select name from finet.users where id = ${U}`;
    expect(row!.name).toBe("Nume nou");
  });

  it("promote_first_admin: doar pentru utilizatorul din context și doar o dată", async () => {
    // Alt utilizator decât cel din context → 42501.
    expect(
      await sqlState(() =>
        withRlsOn(fx.db, { userId: V }, (tx) =>
          tx.execute(sql`select finet.promote_first_admin(${U}::uuid)`),
        ),
      ),
    ).toBe("42501");
    const promote = (id: string) =>
      withRlsOn(fx.db, { userId: id }, async (tx) => {
        const rows = await tx.execute<{ ok: boolean }>(
          sql`select finet.promote_first_admin(${id}::uuid) as ok`,
        );
        return rows[0]!.ok;
      });
    expect(await promote(U)).toBe(true);
    // Există deja un administrator: al doilea nu mai e promovat.
    expect(await promote(V)).toBe(false);
    const admins = await fx.scratch.admin`select id from finet.users where is_platform_admin`;
    expect(admins.map((a) => a.id)).toEqual([U]);
  });
  it("DELETE pe users → 42501 (ștergerea administratorului ar redeschide bootstrap-ul)", async () => {
    expect(await sqlState(() => fx.db.execute(sql`delete from finet.users where id = ${V}`))).toBe(
      "42501",
    );
  });

  it("finet_app nu are niciun drept pe bootstrap_state", async () => {
    for (const statement of [
      sql`select * from finet.bootstrap_state`,
      sql`insert into finet.bootstrap_state (key) values ('admin_bootstrapped')`,
      sql`update finet.bootstrap_state set created_at = now()`,
      sql`delete from finet.bootstrap_state`,
    ]) {
      expect(await sqlState(() => fx.db.execute(statement))).toBe("42501");
    }
  });

  it("bootstrap irepetabil: după ștergerea administratorului (de operator) promovarea rămâne închisă", async () => {
    const promote = (id: string) =>
      withRlsOn(fx.db, { userId: id }, async (tx) => {
        const rows = await tx.execute<{ ok: boolean }>(
          sql`select finet.promote_first_admin(${id}::uuid) as ok`,
        );
        return rows[0]!.ok;
      });
    const rows = await fx.scratch.admin`select key from finet.bootstrap_state`;
    expect(rows).toEqual([{ key: "admin_bootstrapped" }]);
    // Administratorul se promovează din nou pe sine: refuzat (bootstrap-ul a avut loc).
    expect(await promote(U)).toBe(false);
    await fx.scratch.admin`delete from finet.users where id = ${U}`;
    expect(await fx.scratch.admin`select 1 from finet.users where is_platform_admin`).toHaveLength(
      0,
    );
    expect(await promote(V)).toBe(false);
    const after = await fx.scratch.admin`select key from finet.bootstrap_state`;
    expect(after).toEqual([{ key: "admin_bootstrapped" }]);
    const [v] = await fx.scratch.admin<{ is_platform_admin: boolean }[]>`
      select is_platform_admin from finet.users where id = ${V}`;
    expect(v!.is_platform_admin).toBe(false);
  });
});

/** Faza 3 (0004): drepturile `finet_app` pe tabelele planificării, exact (tabel și coloane). */
describe.skipIf(!TEST_ADMIN_URL)("drepturile finet_app pe tabelele planificării (0004)", () => {
  let fx: AuthFixture;
  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_grants4");
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("privilegii pe tabel: SELECT/INSERT peste tot, DELETE doar unde e nevoie, fără UPDATE pe tabel", async () => {
    const rows = await fx.scratch.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and grantee = 'finet_app'
         and table_name in ('tags', 'tag_visibility', 'transaction_tags', 'budgets', 'goals')
       order by table_name, privilege_type`;
    const by = (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.privilege_type);
    expect(by("tags")).toEqual(["DELETE", "INSERT", "SELECT"]);
    expect(by("tag_visibility")).toEqual(["INSERT", "SELECT"]);
    expect(by("transaction_tags")).toEqual(["DELETE", "INSERT", "SELECT"]);
    expect(by("budgets")).toEqual(["DELETE", "INSERT", "SELECT"]);
    expect(by("goals")).toEqual(["DELETE", "INSERT", "SELECT"]);
  });

  it("UPDATE doar pe coloanele permise", async () => {
    const rows = await fx.scratch.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.column_privileges
       where table_schema = 'finet' and grantee = 'finet_app' and privilege_type = 'UPDATE'
         and table_name in ('tags', 'tag_visibility', 'transaction_tags', 'budgets', 'goals')
       order by table_name, column_name`;
    const by = (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.column_name);
    expect(by("tags")).toEqual(["color", "hidden", "name", "updated_at"]);
    expect(by("tag_visibility")).toEqual(["hidden", "updated_at"]);
    expect(by("transaction_tags")).toEqual([]);
    expect(by("budgets")).toEqual(["amount_minor", "archived_at", "updated_at", "warn_pct"]);
    expect(by("goals")).toEqual([
      "account_id",
      "deadline",
      "name",
      "saved_minor",
      "status",
      "target_minor",
      "updated_at",
    ]);
  });
});
