import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHousehold as createHouseholdSql } from "./households";
import { type Db, RlsContextError, createDb, withRlsOn } from "./index";
import { runMigrations } from "./migrate";
import {
  auditEvents,
  consents,
  householdMembers,
  households,
  userPreferences,
  users,
} from "./schema";
import {
  MIGRATIONS_DIR,
  type ScratchDatabase,
  TEST_ADMIN_URL,
  createScratchDatabase,
  testClient,
} from "./testing";

/** Codul SQLSTATE al unei erori aruncate de `fn` (drizzle împachetează eroarea în `cause`). */
async function sqlState(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    let e: unknown = error;
    for (let i = 0; i < 5 && e; i++) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      e = (e as { cause?: unknown }).cause;
    }
    throw error;
  }
}

const RLS_TABLES = [
  "households",
  "household_members",
  "audit_events",
  "user_preferences",
  "consents",
];

describe("withRlsOn (fără bază)", () => {
  const noDb = new Proxy({} as Db, {
    get() {
      throw new Error("baza nu trebuia atinsă");
    },
  });

  it("refuză un userId sau householdId care nu e uuid, înainte de orice query", async () => {
    await expect(withRlsOn(noDb, { userId: "1' or '1'='1" }, async () => 1)).rejects.toBeInstanceOf(
      RlsContextError,
    );
    await expect(
      withRlsOn(noDb, { userId: randomUUID(), householdId: "abc" }, async () => 1),
    ).rejects.toThrow(/householdId/);
  });
});

describe.skipIf(!TEST_ADMIN_URL)("RLS pe PostgreSQL real (rolul finet_app)", () => {
  let scratch: ScratchDatabase;
  let app: { db: Db; client: postgres.Sql };
  let migrator: postgres.Sql;

  const A = randomUUID();
  const B = randomUUID();
  const C = randomUUID();
  let HA: string;
  let HB: string;

  async function createUser(id: string, email: string) {
    // Listă explicită de coloane: `finet_app` are INSERT doar pe ele (M5).
    await app.db.execute(
      sql`insert into finet.users (id, email, name) values (${id}, ${email}, ${email.split("@")[0]!})`,
    );
  }

  /** Crearea gospodăriei: doar prin finet.create_household (gospodăria + owner, atomic). */
  function createHousehold(userId: string, name: string): Promise<string> {
    return withRlsOn(app.db, { userId }, (tx) => createHouseholdSql(tx, { name }));
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase("finet_it_rls");
    migrator = testClient(scratch.migratorUrl, 1);
    await runMigrations(migrator, { folder: MIGRATIONS_DIR });
    app = createDb(scratch.appUrl, { ca: null, applicationName: "finet-test", max: 2 });

    await createUser(A, "ana@exemplu.ro");
    await createUser(B, "bogdan@exemplu.ro");
    await createUser(C, "cristi@exemplu.ro");
    HA = await createHousehold(A, "Casa A");
    HB = await createHousehold(B, "Casa B");
    // A (owner) îl adaugă pe C ca membru în HA.
    await withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
      tx.insert(householdMembers).values({ householdId: HA, userId: C, role: "member" }),
    );
    for (const [userId, householdId] of [
      [A, HA],
      [B, HB],
    ] as const) {
      await withRlsOn(app.db, { userId, householdId }, async (tx) => {
        await tx
          .insert(auditEvents)
          .values({ householdId, actorUserId: userId, action: "household.created" });
        await tx.insert(userPreferences).values({ userId });
        await tx.insert(consents).values({ userId, kind: "usage_stats" });
      });
    }
  });

  afterAll(async () => {
    await app?.client.end({ timeout: 5 });
    await migrator?.end({ timeout: 5 });
    await scratch?.drop();
  });

  it("RLS e activat și FORCE pe tabelele cu household_id/user_id; auth fără RLS", async () => {
    const rows = await scratch.admin<{ relname: string; on: boolean; force: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as force
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'finet' and c.relkind = 'r' order by c.relname`;
    const byName = new Map(rows.map((r) => [r.relname, r]));
    for (const t of RLS_TABLES) expect(byName.get(t)).toMatchObject({ on: true, force: true });
    for (const t of [
      "users",
      "auth_sessions",
      "auth_accounts",
      "auth_verifications",
      "auth_rate_limits",
    ]) {
      expect(byName.get(t)).toMatchObject({ on: false, force: false });
    }
  });

  it("finet_app e NOBYPASSRLS, nu e superuser", async () => {
    const [r] = await scratch.admin<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = 'finet_app'`;
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
  });

  it("un query fără context nu întoarce niciun rând", async () => {
    for (const table of RLS_TABLES) {
      const rows = await app.client.unsafe(`select * from finet.${table}`);
      expect(rows.length, table).toBe(0);
    }
    // Și într-o tranzacție cu context gol.
    const n = await withRlsOn(app.db, { userId: null }, (tx) => tx.select().from(households));
    expect(n).toEqual([]);
  });

  it("contextul e local tranzacției: după commit dispare", async () => {
    await withRlsOn(app.db, { userId: A, householdId: HA }, async (tx) => {
      const [r] = await tx.execute<{ u: string }>(
        sql`select current_setting('app.user_id', true) as u`,
      );
      expect(r?.u).toBe(A);
    });
    const rows = await app.client`select coalesce(current_setting('app.user_id', true), '') as u`;
    expect(rows[0]?.u).toBe("");
  });

  it("A vede doar gospodăria lui; B nu vede HA", async () => {
    const a = await withRlsOn(app.db, { userId: A }, (tx) =>
      tx.select({ id: households.id }).from(households),
    );
    expect(a.map((h) => h.id)).toEqual([HA]);
    const b = await withRlsOn(app.db, { userId: B, householdId: HA }, (tx) =>
      tx.select().from(households).where(eq(households.id, HA)),
    );
    expect(b).toEqual([]);
  });

  it("membrii: în contextul HA, A vede A și C; B, cu context HA, vede doar propriile apartenențe", async () => {
    const a = await withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
      tx.select({ userId: householdMembers.userId }).from(householdMembers),
    );
    expect(new Set(a.map((m) => m.userId))).toEqual(new Set([A, C]));
    const b = await withRlsOn(app.db, { userId: B, householdId: HA }, (tx) =>
      tx.select({ householdId: householdMembers.householdId }).from(householdMembers),
    );
    expect(b.map((m) => m.householdId)).toEqual([HB]);
  });

  it("audit_events: doar gospodăria curentă, și doar pentru membri", async () => {
    const own = await withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
      tx.select().from(auditEvents),
    );
    expect(own.map((e) => e.householdId)).toEqual([HA]);
    const foreign = await withRlsOn(app.db, { userId: A, householdId: HB }, (tx) =>
      tx.select().from(auditEvents),
    );
    expect(foreign).toEqual([]);
  });

  it("A nu poate modifica sau șterge HB (0 rânduri afectate)", async () => {
    for (const householdId of [HA, HB]) {
      const updated = await withRlsOn(app.db, { userId: A, householdId }, (tx) =>
        tx.update(households).set({ name: "Furată" }).where(eq(households.id, HB)).returning(),
      );
      expect(updated).toEqual([]);
      const deleted = await withRlsOn(app.db, { userId: A, householdId }, (tx) =>
        tx.delete(households).where(eq(households.id, HB)).returning(),
      );
      expect(deleted).toEqual([]);
    }
    const [hb] = await withRlsOn(app.db, { userId: B }, (tx) => tx.select().from(households));
    expect(hb?.name).toBe("Casa B");
  });

  it("inserare cu household_id-ul altei gospodării → respinsă (42501)", async () => {
    // Context HA, rând pentru HB.
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
          tx.insert(auditEvents).values({ householdId: HB, actorUserId: A, action: "x.y" }),
        ),
      ),
    ).toBe("42501");
    // Context HB (A nu e membru).
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A, householdId: HB }, (tx) =>
          tx.insert(auditEvents).values({ householdId: HB, actorUserId: A, action: "x.y" }),
        ),
      ),
    ).toBe("42501");
    // Actor fals (alt utilizator decât cel din context).
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
          tx.insert(auditEvents).values({ householdId: HA, actorUserId: C, action: "x.y" }),
        ),
      ),
    ).toBe("42501");
  });

  it("apartenență: A nu se poate adăuga în HB; un membru (C) nu poate adăuga pe nimeni", async () => {
    for (const householdId of [HA, HB]) {
      expect(
        await sqlState(() =>
          withRlsOn(app.db, { userId: A, householdId }, (tx) =>
            tx.insert(householdMembers).values({ householdId: HB, userId: A, role: "owner" }),
          ),
        ),
      ).toBe("42501");
    }
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: C, householdId: HA }, (tx) =>
          tx.insert(householdMembers).values({ householdId: HA, userId: B, role: "member" }),
        ),
      ),
    ).toBe("42501");
    // C nu își poate ridica singur rolul.
    const promoted = await withRlsOn(app.db, { userId: C, householdId: HA }, (tx) =>
      tx
        .update(householdMembers)
        .set({ role: "owner" })
        .where(eq(householdMembers.userId, C))
        .returning(),
    );
    expect(promoted).toEqual([]);
  });

  describe("create_household (singura cale de creare)", () => {
    it("(a) creează gospodăria și apartenența owner atomic, pentru utilizatorul din context", async () => {
      const H = await createHousehold(A, "Casa nouă");
      const members = await scratch.admin<{ user_id: string; role: string }[]>`
        select user_id, role from finet.household_members where household_id = ${H}`;
      expect(members).toEqual([{ user_id: A, role: "owner" }]);
      const [h] = await scratch.admin<
        { created_by: string; name: string; default_currency: string }[]
      >`
        select created_by, name, default_currency from finet.households where id = ${H}`;
      expect(h).toEqual({ created_by: A, name: "Casa nouă", default_currency: "RON" });
      // O valoare invalidă (CHECK) anulează tot: nici gospodărie, nici apartenență.
      const before = await scratch.admin`select 1 from finet.households`;
      expect(
        await sqlState(() =>
          withRlsOn(app.db, { userId: A }, (tx) => createHouseholdSql(tx, { name: "" })),
        ),
      ).toBe("23514");
      const after = await scratch.admin`select 1 from finet.households`;
      expect(after.length).toBe(before.length);
    });

    it("(b) fără utilizator în context → eroare 42501, nimic creat", async () => {
      const before = await scratch.admin`select 1 from finet.households`;
      expect(
        await sqlState(() =>
          withRlsOn(app.db, { userId: null }, (tx) => createHouseholdSql(tx, { name: "Fără" })),
        ),
      ).toBe("42501");
      expect(
        await sqlState(
          () => app.client`select finet.create_household('Fără', 'RON', 'Europe/Bucharest')`,
        ),
      ).toBe("42501");
      const after = await scratch.admin`select 1 from finet.households`;
      expect(after.length).toBe(before.length);
    });

    it("aplicația nu poate insera direct în households", async () => {
      for (const userId of [A, B]) {
        expect(
          await sqlState(() =>
            withRlsOn(app.db, { userId }, (tx) =>
              tx.insert(households).values({ name: "Direct", createdBy: userId }),
            ),
          ),
        ).toBe("42501");
      }
    });

    it("(c) nimeni nu-și poate insera singur o apartenență într-o gospodărie care nu e a lui", async () => {
      for (const householdId of [HA, HB]) {
        for (const role of ["owner", "member"] as const) {
          expect(
            await sqlState(() =>
              withRlsOn(app.db, { userId: A, householdId }, (tx) =>
                tx.insert(householdMembers).values({ householdId: HB, userId: A, role }),
              ),
            ),
          ).toBe("42501");
        }
      }
    });

    it("(d) după ce toți membrii pleacă, creatorul NU mai poate redeveni membru", async () => {
      const H = await createHousehold(B, "Rămâne goală");
      // B (singurul membru, owner) pleacă.
      const left = await withRlsOn(app.db, { userId: B, householdId: H }, (tx) =>
        tx.delete(householdMembers).where(eq(householdMembers.householdId, H)).returning(),
      );
      expect(left.length).toBe(1);
      for (const role of ["owner", "member"] as const) {
        for (const householdId of [H, null]) {
          expect(
            await sqlState(() =>
              withRlsOn(app.db, { userId: B, householdId }, (tx) =>
                tx.insert(householdMembers).values({ householdId: H, userId: B, role }),
              ),
            ),
          ).toBe("42501");
        }
      }
      // Nici setând variabila internă a funcției: politicile ei sunt doar pentru finet_migrator.
      expect(
        await sqlState(() =>
          withRlsOn(app.db, { userId: B, householdId: H }, async (tx) => {
            await tx.execute(sql`select set_config('finet.creating_household', ${H}, true)`);
            await tx.insert(householdMembers).values({ householdId: H, userId: B, role: "owner" });
          }),
        ),
      ).toBe("42501");
      const members =
        await scratch.admin`select 1 from finet.household_members where household_id = ${H}`;
      expect(members.length).toBe(0);
      // Gospodăria nu-i mai e vizibilă.
      const seen = await withRlsOn(app.db, { userId: B }, (tx) =>
        tx.select().from(households).where(eq(households.id, H)),
      );
      expect(seen).toEqual([]);
    });

    it("(e) user_id vine doar din context: nu există parametru, A creează doar pentru A", async () => {
      const [fn] = await scratch.admin<
        { args: string; definer: boolean; owner: string; config: string[] }[]
      >`
        select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as definer,
               pg_get_userbyid(p.proowner) as owner, p.proconfig as config
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'finet' and p.proname = 'create_household'`;
      expect(fn).toEqual({
        args: "p_name text, p_default_currency text, p_timezone text",
        definer: true,
        owner: "finet_migrator",
        config: ["search_path=pg_catalog"],
      });
      // A, cu context A, încercând „în numele lui B” (contextul gospodăriei lui B) → tot A.
      const H = await withRlsOn(app.db, { userId: A, householdId: HB }, (tx) =>
        createHouseholdSql(tx, { name: "A în contextul B" }),
      );
      const members = await scratch.admin<{ user_id: string }[]>`
        select user_id from finet.household_members where household_id = ${H}`;
      expect(members).toEqual([{ user_id: A }]);
      const seenByB = await withRlsOn(app.db, { userId: B }, (tx) =>
        tx.select().from(households).where(eq(households.id, H)),
      );
      expect(seenByB).toEqual([]);
      // Un utilizator dezactivat nu poate crea gospodării.
      const D = randomUUID();
      await createUser(D, "dezactivat@exemplu.ro");
      // Dezactivarea e o operație a operatorului (M5: `finet_app` nu poate scrie `status`).
      await scratch.admin`update finet.users set status = 'disabled' where id = ${D}`;
      expect(await sqlState(() => createHousehold(D, "X"))).toBe("42501");
      // PUBLIC nu are EXECUTE (doar finet_app).
      const [priv] = await scratch.admin<{ app: boolean; anon: boolean }[]>`
        select has_function_privilege('finet_app', 'finet.create_household(text,text,text)', 'EXECUTE') as app,
               has_function_privilege('anon', 'finet.create_household(text,text,text)', 'EXECUTE') as anon`;
      expect(priv).toEqual({ app: true, anon: false });
    });
  });

  it("preferințe și consimțăminte: doar ale utilizatorului curent", async () => {
    const prefs = await withRlsOn(app.db, { userId: A }, (tx) => tx.select().from(userPreferences));
    expect(prefs.map((p) => p.userId)).toEqual([A]);
    expect(prefs[0]).toMatchObject({
      locale: "ro-RO",
      timezone: "Europe/Bucharest",
      defaultCurrency: "RON",
    });
    const otherUpdate = await withRlsOn(app.db, { userId: A }, (tx) =>
      tx
        .update(userPreferences)
        .set({ theme: "dark" })
        .where(eq(userPreferences.userId, B))
        .returning(),
    );
    expect(otherUpdate).toEqual([]);
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A }, (tx) =>
          tx.insert(consents).values({ userId: B, kind: "external_ai" }),
        ),
      ),
    ).toBe("42501");
  });

  it("CHECK și unicitate: membru dublu, email dublu (indiferent de majuscule), email nenormalizat", async () => {
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
          tx.insert(householdMembers).values({ householdId: HA, userId: C, role: "member" }),
        ),
      ),
    ).toBe("23505");
    expect(await sqlState(() => createUser(randomUUID(), "Ana@Exemplu.ro"))).toBe("23514");
    expect(await sqlState(() => createUser(randomUUID(), " ana@exemplu.ro"))).toBe("23514");
    expect(await sqlState(() => createUser(randomUUID(), "ana@exemplu.ro"))).toBe("23505");
    // Indexul unic e pe lower(email), deci un rând cu majuscule (dacă CHECK-ul ar lipsi) tot ar
    // fi prins; verificăm că indexul există.
    const idx = await scratch.admin`
      select indexdef from pg_indexes where schemaname = 'finet' and indexname = 'users_email_lower_key'`;
    expect(String(idx[0]?.indexdef)).toMatch(/UNIQUE INDEX .* \(lower\(email\)\)/);
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A, householdId: HA }, (tx) =>
          tx.execute(
            sql`insert into finet.household_members (household_id, user_id, role) values (${HA}, ${B}, 'admin')`,
          ),
        ),
      ),
    ).toBe("23514");
    // Un singur consimțământ activ pe tip.
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A }, (tx) =>
          tx.insert(consents).values({ userId: A, kind: "usage_stats" }),
        ),
      ),
    ).toBe("23505");
    // Tip de consimțământ necunoscut.
    expect(
      await sqlState(() =>
        withRlsOn(app.db, { userId: A }, (tx) =>
          tx.execute(sql`insert into finet.consents (user_id, kind) values (${A}, 'marketing')`),
        ),
      ),
    ).toBe("23514");
  });

  it("audit_events e doar adăugare pentru aplicație (fără UPDATE/DELETE)", async () => {
    for (const statement of [
      "update finet.audit_events set action = 'x.z'",
      "delete from finet.audit_events",
    ]) {
      expect(await sqlState(() => app.client.unsafe(statement))).toBe("42501");
    }
  });

  it("FORCE RLS și proprietarul: finet_migrator nu vede audit/preferințe/consimțăminte", async () => {
    // Comportamentul real: proprietarul (fără BYPASSRLS) e supus politicilor. Are doar politicile
    // de citire `*_migrator_read` pe households și household_members (pentru funcțiile SECURITY
    // DEFINER), deci acolo vede tot; în rest nu vede nimic și nu poate scrie.
    for (const table of ["audit_events", "user_preferences", "consents"]) {
      const rows = await migrator.unsafe(`select * from finet.${table}`);
      expect(rows.length, table).toBe(0);
    }
    const hh = await migrator.unsafe(`select id from finet.households`);
    expect(hh.length).toBeGreaterThanOrEqual(2);
    expect(
      await sqlState(() =>
        migrator.unsafe(
          `insert into finet.audit_events (household_id, action) values ('${HA}', 'x.y')`,
        ),
      ),
    ).toBe("42501");
    // Fără FORCE, proprietarul ar ocoli RLS: verificăm explicit că e setat.
    const [r] = await scratch.admin<{ force: boolean }[]>`
      select relforcerowsecurity as force from pg_class where oid = 'finet.audit_events'::regclass`;
    expect(r?.force).toBe(true);
  });

  it("finet_app nu poate crea obiecte în finet sau public și nu poate DROP/ALTER", async () => {
    const attempts = [
      "create table finet.x (id int)",
      "create table public.x (id int)",
      "create function finet.f() returns int language sql as 'select 1'",
      "create view finet.v as select 1",
      "drop table finet.households",
      "alter table finet.households disable row level security",
      "alter table finet.households no force row level security",
      "alter table finet.users add column x int",
      "drop policy households_select on finet.households",
      "truncate finet.users",
      "select * from finet.__drizzle_migrations",
    ];
    for (const statement of attempts) {
      expect(await sqlState(() => app.client.unsafe(statement)), statement).toBe("42501");
    }
  });

  it("anon, authenticated și PUBLIC nu au niciun drept pe schema și tabelele finet", async () => {
    const rows = await scratch.admin<{ r: string; usage: boolean; any_table: boolean }[]>`
      select r,
             has_schema_privilege(r, 'finet', 'USAGE') as usage,
             exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'finet' and c.relkind in ('r', 'v', 'S')
                        and has_table_privilege(r, c.oid, 'SELECT, INSERT, UPDATE, DELETE')) as any_table
        from unnest(array['anon', 'authenticated']) as r`;
    expect(rows).toEqual([
      { r: "anon", usage: false, any_table: false },
      { r: "authenticated", usage: false, any_table: false },
    ]);
    const grants = await scratch.admin`
      select table_name from information_schema.role_table_grants
       where table_schema = 'finet' and grantee in ('PUBLIC', 'anon', 'authenticated')`;
    expect(grants.length).toBe(0);
  });

  it("ștergerea unui utilizator: apartenențele dispar (CASCADE), gospodăria rămâne (created_by NULL)", async () => {
    const U = randomUUID();
    await createUser(U, "temporar@exemplu.ro");
    const H = await createHousehold(U, "Temporară");
    await app.db.delete(users).where(eq(users.id, U));
    const [h] = await scratch.admin<{ created_by: string | null }[]>`
      select created_by from finet.households where id = ${H}`;
    expect(h).toEqual({ created_by: null });
    const members =
      await scratch.admin`select 1 from finet.household_members where household_id = ${H}`;
    expect(members.length).toBe(0);
  });
});
