import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { verifyPassword } from "@/modules/auth/password";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";
import { findPasswordHash } from "@/modules/auth/users.repo";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import { type AdminIo, main, parseArgs } from "./cli";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("parseArgs", () => {
  it("refuză parola ca argument, opțiunile necunoscute și repetate", () => {
    expect(() => parseArgs(["create-user", "--email", "a@b.ro", "--password", "x"])).toThrow(
      /--password-stdin/,
    );
    expect(() => parseArgs(["create-user", "--password=x"])).toThrow(/--password-stdin/);
    expect(() => parseArgs(["create-user", "--rol", "x"])).toThrow(/necunoscută/);
    expect(() => parseArgs(["create-user", "--email", "a", "--email", "b"])).toThrow(/repetată/);
    expect(() => parseArgs(["sterge-tot"])).toThrow();
    expect(parseArgs(["add-member", "--household=h", "--email", "e"]).flags).toEqual({
      household: "h",
      email: "e",
    });
  });
});

describe.skipIf(!TEST_ADMIN_URL)("CLI admin pe PostgreSQL real", () => {
  let fx: AuthFixture;
  // URL fictiv: testele dau baza direct (`io.db`); configurația îl cere pentru rolul admin.
  const ENV = {
    APP_MODE: "personal",
    NODE_ENV: "test",
    FINET_ROLE: "admin",
    DATABASE_URL: "postgres://finet_app:fictiv@localhost:5432/fictiv",
  };

  function run(argv: string[], stdin = "", env: Record<string, string> = ENV) {
    const out: string[] = [];
    const err: string[] = [];
    const io: AdminIo = {
      env,
      argv,
      readStdin: async () => stdin,
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      db: fx.db,
    };
    return main(io).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_cli");
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("create-user cu --password-stdin: utilizator + preferințe + gospodărie; parola nu apare în ieșire", async () => {
    const secret = "parola-din-stdin-987";
    const r = await run(
      ["create-user", "--email", " Ana@Exemplu.RO ", "--name", "Ana", "--password-stdin"],
      `${secret}\n`,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("administrator al platformei");
    expect(`${r.out}\n${r.err}`).not.toContain(secret);
    expect(`${r.out}\n${r.err}`).not.toContain("ana@exemplu.ro");

    const users = await fx.scratch.admin<
      { id: string; email: string; is_platform_admin: boolean; email_verified: boolean }[]
    >`
      select id, email, is_platform_admin, email_verified from finet.users`;
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: "ana@exemplu.ro",
      is_platform_admin: true,
      email_verified: true,
    });
    const id = users[0]!.id;
    const prefs = await fx.scratch
      .admin`select locale, timezone, default_currency from finet.user_preferences where user_id = ${id}`;
    expect(prefs[0]).toEqual({
      locale: "ro-RO",
      timezone: "Europe/Bucharest",
      default_currency: "RON",
    });
    const members = await fx.scratch
      .admin`select role from finet.household_members where user_id = ${id}`;
    expect(members).toEqual([{ role: "owner" }]);
    const hash = await findPasswordHash(fx.db, id);
    expect(await verifyPassword(hash!, secret)).toBe(true);
    const audit = await fx.scratch
      .admin`select action from finet.audit_events where actor_user_id = ${id}`;
    expect(audit.map((a) => a.action)).toContain("user.created");
  });

  it("idempotent: a doua creare cu același email nu modifică nimic (exit 0)", async () => {
    const r = await run(
      ["create-user", "--email", "ana@exemplu.ro", "--name", "Alt nume", "--password-stdin"],
      "alta-parola-12345\n",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("există deja");
    const users = await fx.scratch.admin`select name from finet.users`;
    expect(users).toEqual([{ name: "Ana" }]);
  });

  it("al doilea utilizator nu devine administrator; parola generată e afișată o singură dată", async () => {
    const r = await run(["create-user", "--email", "bogdan@exemplu.ro", "--name", "Bogdan"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("administrator al platformei");
    const generated = /afișată o singură dată\): (\S+)/.exec(r.out)![1]!;
    expect(generated.length).toBe(24);
    expect(r.out.split(generated).length - 1).toBe(1);
    const row = await fx.scratch.admin<{ id: string; is_platform_admin: boolean }[]>`
      select id, is_platform_admin from finet.users where email = 'bogdan@exemplu.ro'`;
    expect(row[0]!.is_platform_admin).toBe(false);
    expect(await verifyPassword((await findPasswordHash(fx.db, row[0]!.id))!, generated)).toBe(
      true,
    );
  });

  it("parolă prea scurtă sau email invalid → exit 2, nimic creat", async () => {
    const short = await run(
      ["create-user", "--email", "c@exemplu.ro", "--name", "C", "--password-stdin"],
      "scurta\n",
    );
    expect(short.code).toBe(2);
    expect(short.err).not.toContain("scurta");
    const bad = await run(["create-user", "--email", "nu-e-email", "--name", "C"]);
    expect(bad.code).toBe(2);
    const rows = await fx.scratch.admin`select 1 from finet.users where email = 'c@exemplu.ro'`;
    expect(rows.length).toBe(0);
  });

  it("crearea e atomică: o eroare la gospodărie anulează utilizatorul și preferințele", async () => {
    await fx.scratch.admin.unsafe(`
      create function finet.test_fail() returns trigger language plpgsql as
        $$ begin raise exception 'eșec simulat'; end $$;
      create trigger test_fail before insert on finet.households
        for each row execute function finet.test_fail();`);
    try {
      const r = await run(
        ["create-user", "--email", "eva@exemplu.ro", "--name", "Eva", "--password-stdin"],
        "parola-eva-12345\n",
      );
      expect(r.code).toBe(1);
      expect(r.err).toContain("EȘEC");
      await expect(
        createUserWithHousehold(fx.db, {
          email: "eva@exemplu.ro",
          name: "Eva",
          password: null,
          firstUserBecomesAdmin: false,
          emailVerified: true,
        }),
      ).rejects.toThrow();
    } finally {
      await fx.scratch.admin.unsafe(
        "drop trigger test_fail on finet.households; drop function finet.test_fail();",
      );
    }
    const rows = await fx.scratch.admin`
      select email from finet.users where email in ('eva@exemplu.ro')`;
    expect(rows.length).toBe(0);
    const prefs = await fx.scratch.admin`
      select 1 from finet.user_preferences p left join finet.users u on u.id = p.user_id where u.id is null`;
    expect(prefs.length).toBe(0);
  });

  it("reset-password: parolă nouă din stdin, toate sesiunile revocate, parola nu apare în ieșire", async () => {
    const user = await fx.scratch.admin<
      { id: string }[]
    >`select id from finet.users where email = 'ana@exemplu.ro'`;
    const id = user[0]!.id;
    await fx.scratch.admin`
      insert into finet.auth_sessions (token, user_id, expires_at)
      values ('tok-1', ${id}, now() + interval '1 day'), ('tok-2', ${id}, now() + interval '1 day')`;
    const secret = "parola-resetata-555";
    const r = await run(
      ["reset-password", "--email", "ANA@exemplu.ro", "--password-stdin"],
      secret,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("sesiuni revocate: 2");
    expect(`${r.out}\n${r.err}`).not.toContain(secret);
    const sessions = await fx.scratch
      .admin`select 1 from finet.auth_sessions where user_id = ${id}`;
    expect(sessions.length).toBe(0);
    expect(await verifyPassword((await findPasswordHash(fx.db, id))!, secret)).toBe(true);
    const missing = await run(["reset-password", "--email", "nimeni@exemplu.ro"]);
    expect(missing.code).toBe(1);
  });

  it("add-member: adaugă în gospodăria indicată (ca owner), idempotent, cu audit", async () => {
    const ana = await fx.scratch.admin<{ household_id: string }[]>`
      select m.household_id from finet.household_members m join finet.users u on u.id = m.user_id
       where u.email = 'ana@exemplu.ro'`;
    const household = ana[0]!.household_id;
    const r = await run(["add-member", "--household", household, "--email", "bogdan@exemplu.ro"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("a fost adăugat");
    const again = await run([
      "add-member",
      "--household",
      household,
      "--email",
      "bogdan@exemplu.ro",
    ]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("deja membru");
    const members = await fx.scratch.admin`
      select role from finet.household_members where household_id = ${household} order by role`;
    expect(members).toEqual([{ role: "member" }, { role: "owner" }]);
    const audit = await fx.scratch.admin`
      select metadata from finet.audit_events where action = 'household.member_added'`;
    expect(audit).toEqual([{ metadata: { role: "member", via: "cli" } }]);

    const none = await run([
      "add-member",
      "--household",
      "00000000-0000-4000-8000-000000000000",
      "--email",
      "bogdan@exemplu.ro",
    ]);
    expect(none.code).toBe(1);
    const badRole = await run([
      "add-member",
      "--household",
      household,
      "--email",
      "bogdan@exemplu.ro",
      "--role",
      "admin",
    ]);
    expect(badRole.code).toBe(2);
  });

  it("aggregate-events: scrie doar numărul de evenimente agregate (> 13 luni), idempotent", async () => {
    const [u] = await fx.scratch.admin<{ id: string }[]>`
      insert into finet.users (email, name) values ('agg@exemplu.ro', 'Agg') returning id`;
    await fx.scratch.admin`insert into finet.app_events (user_id, name, occurred_at)
      values (${u!.id}, 'app_open', now() - interval '14 months'), (${u!.id}, 'app_open', now())`;
    const first = await run(["aggregate-events"]);
    expect(first).toEqual({ code: 0, out: "1", err: "" });
    expect((await run(["aggregate-events"])).out).toBe("0");
    expect((await run(["aggregate-events", "--x", "1"])).code).toBe(2);
  });

  it("refuză alt FINET_ROLE decât admin", async () => {
    const r = await run(["create-user", "--email", "x@exemplu.ro", "--name", "X"], "", {
      APP_MODE: "personal",
      NODE_ENV: "test",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("FINET_ROLE");
  });
});
