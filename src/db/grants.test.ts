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

/** Faza 5 (0006, 0007): drepturile `finet_app` pe recurențe, pe semnalul workerului și pe pgboss. */
describe.skipIf(!TEST_ADMIN_URL)(
  "drepturile finet_app pe recurențe și pe coada pg-boss (0006, 0007)",
  () => {
    let fx: AuthFixture;
    beforeAll(async () => {
      fx = await createAuthFixture("finet_it_grants6");
    });
    afterAll(async () => {
      await fx?.close();
    });

    const tablePrivileges = async (
      schema: string,
      tables: readonly string[],
      grantee = "finet_app",
    ) => {
      const rows = await fx.scratch.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = ${schema} and grantee = ${grantee} and table_name = any(${tables as string[]})
       order by table_name, privilege_type`;
      return (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.privilege_type);
    };
    const updateColumns = async (schema: string, tables: readonly string[]) => {
      const rows = await fx.scratch.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.column_privileges
       where table_schema = ${schema} and grantee = 'finet_app' and privilege_type = 'UPDATE'
         and table_name = any(${tables as string[]})
       order by table_name, column_name`;
      return (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.column_name);
    };

    it("recurențe: SELECT/INSERT, DELETE doar pe reguli, UPDATE doar pe coloanele permise", async () => {
      const tables = ["recurring_rules", "recurring_occurrences", "service_heartbeats"] as const;
      const by = await tablePrivileges("finet", tables);
      expect(by("recurring_rules")).toEqual(["DELETE", "INSERT", "SELECT"]);
      expect(by("recurring_occurrences")).toEqual(["INSERT", "SELECT"]);
      expect(by("service_heartbeats")).toEqual(["INSERT", "SELECT"]);
      const cols = await updateColumns("finet", tables);
      expect(cols("recurring_rules")).toEqual([
        "account_id",
        "amount_minor",
        "category_id",
        "currency",
        "day_of_month",
        "description",
        "end_on",
        "frequency",
        "interval",
        "last_error_code",
        "max_occurrences",
        "merchant",
        "next_run_on",
        "occurrences_count",
        "retry_after",
        "status",
        "updated_at",
      ]);
      expect(cols("recurring_occurrences")).toEqual([]);
      expect(cols("service_heartbeats")).toEqual(["beat_at", "started_at", "stopped_at"]);
    });

    it("câmpurile fixe ale regulii și ocurențele nu se pot modifica (42501)", async () => {
      for (const statement of [
        sql`update finet.recurring_rules set household_id = household_id`,
        sql`update finet.recurring_rules set type = 'income'`,
        sql`update finet.recurring_rules set start_on = start_on`,
        sql`update finet.recurring_rules set created_by_user_id = null`,
        sql`update finet.recurring_occurrences set transaction_id = null`,
        sql`delete from finet.recurring_occurrences`,
        sql`delete from finet.service_heartbeats`,
      ]) {
        expect(await sqlState(() => fx.db.execute(statement))).toBe("42501");
      }
    });

    it("anon/authenticated/PUBLIC: nimic pe tabelele noi și pe schema pgboss", async () => {
      const [r] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee in ('anon', 'authenticated', 'PUBLIC')
         and (table_schema = 'pgboss'
              or table_name in ('recurring_rules', 'recurring_occurrences', 'service_heartbeats'))`;
      expect(r?.n).toBe(0);
      const [s] = await fx.scratch.admin<
        { anon: boolean; auth: boolean; app: boolean; appCreate: boolean }[]
      >`
      select has_schema_privilege('anon', 'pgboss', 'USAGE') as anon,
             has_schema_privilege('authenticated', 'pgboss', 'USAGE') as auth,
             has_schema_privilege('finet_app', 'pgboss', 'USAGE') as app,
             has_schema_privilege('finet_app', 'pgboss', 'CREATE') as "appCreate"`;
      expect(s).toEqual({ anon: false, auth: false, app: true, appCreate: false });
      const fns = await fx.scratch.admin<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where n.nspname = 'pgboss' and a.grantee = 0 and a.privilege_type = 'EXECUTE'`;
      expect(fns).toEqual([]);
    });

    it("pgboss: DML pe tabelele cozii, doar citire pe version/bam/warning/queue_stats, EXECUTE minim", async () => {
      const tables = [
        "job",
        "job_common",
        "queue",
        "schedule",
        "subscription",
        "job_dependency",
        "instance",
        "version",
        "bam",
        "warning",
        "queue_stats",
      ] as const;
      const by = await tablePrivileges("pgboss", tables);
      for (const t of [
        "job",
        "job_common",
        "queue",
        "schedule",
        "subscription",
        "job_dependency",
        "instance",
      ]) {
        expect(by(t)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
      }
      for (const t of ["version", "bam", "warning", "queue_stats"])
        expect(by(t)).toEqual(["SELECT"]);
      const cols = await updateColumns("pgboss", ["version"]);
      expect(cols("version")).toEqual([
        "bam_on",
        "cron_on",
        "flow_on",
        "monitor_backoff_on",
        "reindex_on",
      ]);
      const exec = await fx.scratch.admin<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'pgboss' and has_function_privilege('finet_app', p.oid, 'EXECUTE')
       order by p.proname`;
      expect(exec.map((e) => e.proname)).toEqual(["create_queue", "job_now"]);
      // Nicio altă tabelă din pgboss (de exemplu partițiile zilnice ale queue_stats) nu e accesibilă.
      const others = await fx.scratch.admin<{ table_name: string }[]>`
      select distinct table_name from information_schema.role_table_grants
       where table_schema = 'pgboss' and grantee = 'finet_app'
         and not (table_name = any(${tables as unknown as string[]}))`;
      expect(others).toEqual([]);
    });
  },
);

/** Faza 6 (0008): drepturile `finet_app` pe documente, bonuri, alias-uri și jurnalul AI. */
describe.skipIf(!TEST_ADMIN_URL)("drepturile finet_app pe documente și bonuri (0008)", () => {
  let fx: AuthFixture;
  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_grants8");
  });
  afterAll(async () => {
    await fx?.close();
  });

  const TABLES = [
    "documents",
    "processing_batches",
    "receipts",
    "receipt_lines",
    "product_aliases",
    "ai_calls",
    "document_usage_daily",
  ];

  it("SELECT/INSERT/DELETE pe tabele; ai_calls doar SELECT + INSERT; UPDATE doar pe coloanele permise", async () => {
    const rows = await fx.scratch.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and grantee = 'finet_app' and table_name = any(${TABLES})
       order by table_name, privilege_type`;
    const by = (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.privilege_type);
    for (const t of TABLES.filter((t) => t !== "ai_calls" && t !== "document_usage_daily")) {
      expect(by(t), t).toEqual(["DELETE", "INSERT", "SELECT"]);
    }
    expect(by("ai_calls")).toEqual(["INSERT", "SELECT"]);
    // Contorul zilnic doar crește: fără DELETE (revizuirea F6-A, M3).
    expect(by("document_usage_daily")).toEqual(["INSERT", "SELECT"]);
    const cols = await fx.scratch.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.column_privileges
       where table_schema = 'finet' and grantee = 'finet_app' and privilege_type = 'UPDATE'
         and table_name = any(${TABLES})
       order by table_name, column_name`;
    const updatable = (t: string) =>
      cols.filter((r) => r.table_name === t).map((r) => r.column_name);
    expect(updatable("documents")).toEqual([
      "attempts",
      "batch_id",
      "document_order",
      "error_code",
      "expires_at",
      "file_deleted_at",
      "kind",
      "pages",
      "perceptual_hash",
      "possible_duplicate_of_id",
      "processing_started_at",
      "status",
      "storage_key",
      "updated_at",
    ]);
    expect(updatable("processing_batches")).toEqual(["status", "updated_at"]);
    expect(updatable("product_aliases")).toEqual(["category_id", "tag_ids", "updated_at"]);
    expect(updatable("ai_calls")).toEqual([]);
    expect(updatable("document_usage_daily")).toEqual(["count", "updated_at"]);
    expect(updatable("receipts")).not.toContain("household_id");
    expect(updatable("receipts")).not.toContain("document_id");
    expect(updatable("receipt_lines")).not.toContain("receipt_id");
    expect(updatable("receipt_lines")).not.toContain("household_id");
  });

  it("câmpurile fixe și jurnalul AI nu se pot modifica (42501)", async () => {
    for (const statement of [
      sql`update finet.documents set household_id = household_id`,
      sql`update finet.documents set sha256 = sha256`,
      sql`update finet.documents set size_bytes = size_bytes`,
      sql`update finet.documents set detected_mime = detected_mime`,
      sql`update finet.documents set uploaded_by_user_id = null`,
      sql`update finet.receipts set household_id = household_id`,
      sql`update finet.receipts set document_id = document_id`,
      sql`update finet.receipt_lines set receipt_id = receipt_id`,
      sql`update finet.product_aliases set normalized_name = normalized_name`,
      sql`update finet.ai_calls set result = 'ok'`,
      sql`delete from finet.ai_calls`,
      sql`delete from finet.document_usage_daily`,
      sql`update finet.document_usage_daily set day = day`,
      sql`update finet.document_usage_daily set household_id = household_id`,
    ]) {
      expect(await sqlState(() => fx.db.execute(statement))).toBe("42501");
    }
  });

  it("anon/authenticated/PUBLIC: nimic; queued_documents doar pentru finet_app", async () => {
    const [r] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
       where grantee in ('anon', 'authenticated', 'PUBLIC') and table_name = any(${TABLES})`;
    expect(r?.n).toBe(0);
    const [f] = await fx.scratch.admin<
      { app: boolean; anon: boolean; auth: boolean; pub: boolean }[]
    >`
      select has_function_privilege('finet_app', 'finet.queued_documents(integer, integer)', 'EXECUTE') as app,
             has_function_privilege('anon', 'finet.queued_documents(integer, integer)', 'EXECUTE') as anon,
             has_function_privilege('authenticated', 'finet.queued_documents(integer, integer)', 'EXECUTE') as auth,
             exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where p.proname = 'queued_documents' and a.grantee = 0) as pub`;
    expect(f).toEqual({ app: true, anon: false, auth: false, pub: false });
    const [owner] = await fx.scratch.admin<{ owner: string; definer: boolean; config: string[] }[]>`
      select pg_get_userbyid(proowner) as owner, prosecdef as definer, proconfig as config
        from pg_proc where proname = 'queued_documents'`;
    expect(owner).toEqual({
      owner: "finet_migrator",
      definer: true,
      config: ["search_path=pg_catalog"],
    });
  });
});

/** Faza 6 (0009): cotele TVA (doar citire), bugetul AI (doar prin funcții), `queued_document`. */
describe.skipIf(!TEST_ADMIN_URL)(
  "drepturile finet_app pe TVA, buget AI și coloanele noi (0009)",
  () => {
    let fx: AuthFixture;
    beforeAll(async () => {
      fx = await createAuthFixture("finet_it_grants9");
    });
    afterAll(async () => {
      await fx?.close();
    });

    const FUNCTIONS = [
      "finet.ai_budget_reserve(bigint, bigint, text)",
      "finet.ai_budget_spent(text)",
      "finet.queued_document(uuid)",
    ];

    it("vat_rates: doar SELECT; ai_budget_usage: niciun drept direct; receipts: coloanele noi actualizabile", async () => {
      const rows = await fx.scratch.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where table_schema = 'finet' and grantee in ('finet_app', 'anon', 'authenticated', 'PUBLIC')
         and table_name in ('vat_rates', 'ai_budget_usage')
       order by table_name, privilege_type`;
      expect(rows).toEqual([{ table_name: "vat_rates", privilege_type: "SELECT" }]);
      const cols = await fx.scratch.admin<{ column_name: string }[]>`
      select column_name from information_schema.column_privileges
       where table_schema = 'finet' and grantee = 'finet_app' and privilege_type = 'UPDATE'
         and table_name = 'receipts' and column_name in ('issues', 'duplicate_of_receipt_id', 'merge_report')
       order by column_name`;
      expect(cols.map((c) => c.column_name)).toEqual([
        "duplicate_of_receipt_id",
        "issues",
        "merge_report",
      ]);
      for (const statement of [
        sql`select * from finet.ai_budget_usage`,
        sql`insert into finet.ai_budget_usage (month, currency) values (date '2026-10-01', 'USD')`,
        sql`update finet.vat_rates set rate_bp = 0`,
        sql`delete from finet.vat_rates`,
        sql`insert into finet.vat_rates (rate_bp, valid_from) values (1, date '2026-01-01')`,
      ]) {
        expect(await sqlState(() => fx.db.execute(statement))).toBe("42501");
      }
      const [n] = (await fx.db.execute(
        sql`select count(*)::int as n from finet.vat_rates`,
      )) as unknown as { n: number }[];
      expect(n?.n).toBe(7);
    });

    it("funcțiile: SECURITY DEFINER, proprietar finet_migrator, search_path fix, EXECUTE doar finet_app", async () => {
      for (const fn of FUNCTIONS) {
        const [f] = await fx.scratch.admin<{ app: boolean; anon: boolean; auth: boolean }[]>`
        select has_function_privilege('finet_app', ${fn}, 'EXECUTE') as app,
               has_function_privilege('anon', ${fn}, 'EXECUTE') as anon,
               has_function_privilege('authenticated', ${fn}, 'EXECUTE') as auth`;
        expect(f, fn).toEqual({ app: true, anon: false, auth: false });
        const [o] = await fx.scratch.admin<
          { owner: string; definer: boolean; config: string[]; pub: boolean }[]
        >`
        select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.proconfig as config,
               exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where a.grantee = 0) as pub
          from pg_proc p where p.oid = ${fn}::regprocedure`;
        expect(o, fn).toEqual({
          owner: "finet_migrator",
          definer: true,
          config: ["search_path=pg_catalog"],
          pub: false,
        });
      }
    });

    it("ai_budget_reserve: atomic, doar crește, refuză bugetul 0 și costurile invalide", async () => {
      const reserve = async (cost: bigint, budget: bigint, cur = "USD") => {
        const [r] = (await fx.db.execute(
          sql`select finet.ai_budget_reserve(${cost.toString()}::bigint, ${budget.toString()}::bigint, ${cur}) as ok`,
        )) as unknown as { ok: boolean }[];
        return r!.ok;
      };
      const spent = async (cur = "USD") => {
        const [r] = (await fx.db.execute(
          sql`select finet.ai_budget_spent(${cur})::text as s`,
        )) as unknown as { s: string }[];
        return BigInt(r!.s);
      };
      expect(await reserve(1n, 0n)).toBe(false);
      expect(await spent()).toBe(0n);
      expect(await reserve(60n, 100n)).toBe(true);
      expect(await reserve(40n, 100n)).toBe(true);
      expect(await reserve(1n, 100n)).toBe(false);
      expect(await spent()).toBe(100n);
      expect(await spent("EUR")).toBe(0n);
      expect(await sqlState(() => reserve(0n, 100n))).toBe("22023");
      expect(await sqlState(() => reserve(-5n, 100n))).toBe("22023");
      expect(await sqlState(() => reserve(1n, 100n, "XYZ"))).toBe("22023");
      // 10 rezervări paralele de 10 dintr-un buget de 150 (100 deja consumat): exact 5 trec.
      const results = await Promise.all(Array.from({ length: 10 }, () => reserve(10n, 150n)));
      expect(results.filter(Boolean)).toHaveLength(5);
      expect(await spent()).toBe(150n);
    });
  },
);
