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
});
