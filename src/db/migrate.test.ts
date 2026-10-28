import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeError, main } from "./migrate-cli";
import { MigrationError, readMigrations, runMigrations } from "./migrate";
import {
  MIGRATIONS_DIR,
  type ScratchDatabase,
  TEST_ADMIN_URL,
  createScratchDatabase,
  testClient,
} from "./testing";

function copyMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "finet-mig-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

describe("readMigrations (fără bază)", () => {
  it("citește jurnalul repo-ului: 0000_core … 0005_perf_indexes, fără CREATE SCHEMA", () => {
    const migrations = readMigrations(MIGRATIONS_DIR);
    expect(migrations.map((m) => m.tag)).toEqual([
      "0000_core",
      "0001_rls",
      "0002_ledger",
      "0003_idempotency_purge",
      "0004_budgets_goals_tags",
      "0005_perf_indexes",
    ]);
    for (const m of migrations) {
      expect(m.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(m.statements.length).toBeGreaterThan(0);
      expect(m.statements.join("\n")).not.toMatch(/^\s*create\s+schema/im);
    }
  });

  it("orice tabel creat are RLS în 0001, cu excepția tabelelor de autentificare", () => {
    const [core, rls] = readMigrations(MIGRATIONS_DIR);
    const created = [...core!.statements.join("\n").matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map(
      (m) => m[1],
    );
    const rlsText = rls!.statements.join("\n");
    const noRls = new Set([
      "users",
      "auth_sessions",
      "auth_accounts",
      "auth_verifications",
      "auth_rate_limits",
    ]);
    for (const table of created) {
      if (noRls.has(table!)) continue;
      expect(rlsText).toContain(`alter table finet.${table} enable row level security`);
      expect(rlsText).toContain(`alter table finet.${table} force row level security`);
    }
  });

  it("0002_ledger: fiecare tabel creat are RLS ENABLE și FORCE în aceeași migrație, fără excepții", () => {
    const ledger = readMigrations(MIGRATIONS_DIR).find((m) => m.tag === "0002_ledger")!;
    const text = ledger.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((m) => m[1]!);
    expect(created.sort()).toEqual([
      "accounts",
      "app_downloads",
      "app_events",
      "categories",
      "category_visibility",
      "client_installations",
      "idempotency_keys",
      "transactions",
    ]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    // Categoriile de sistem se inserează ÎNAINTE de activarea RLS (FORCE se aplică și
    // proprietarului).
    expect(text.indexOf("insert into finet.categories")).toBeLessThan(
      text.indexOf("alter table finet.categories enable row level security"),
    );
    // Nicio funcție nouă SECURITY DEFINER: triggerele rulează cu drepturile apelantului.
    expect(text).not.toMatch(/security\s+definer/i);
  });

  it("0004_budgets_goals_tags: tabele noi cu RLS ENABLE + FORCE în aceeași migrație, seed înainte de RLS", () => {
    const planning = readMigrations(MIGRATIONS_DIR).find(
      (m) => m.tag === "0004_budgets_goals_tags",
    )!;
    const text = planning.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((m) => m[1]!);
    expect(created.sort()).toEqual([
      "budgets",
      "goals",
      "tag_visibility",
      "tags",
      "transaction_tags",
    ]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    expect(text.indexOf("insert into finet.tags")).toBeLessThan(
      text.indexOf("alter table finet.tags enable row level security"),
    );
    // Constrângerea unică țintă e creată înaintea cheii străine compuse care o folosește.
    expect(text.indexOf('"transactions_id_household_key" UNIQUE')).toBeLessThan(
      text.indexOf('"transaction_tags_transaction_fk" FOREIGN KEY'),
    );
    expect(text).not.toMatch(/security\s+definer/i);
    // Singura atingere a unui tabel existent: constrângerea unică pe transactions (nedistructivă).
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\b(drop|truncate)\b|\bdelete\s+from\b|\bupdate\s+finet\./i);
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((m) => m[1]!);
    expect(new Set(altered.filter((t) => !created.includes(t)))).toEqual(new Set(["transactions"]));
  });

  it("refuză un director fără jurnal", () => {
    const dir = mkdtempSync(join(tmpdir(), "finet-mig-"));
    try {
      expect(() => readMigrations(dir)).toThrow(MigrationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuză un jurnal cu fișier lipsă sau ordine greșită", () => {
    const dir = copyMigrations();
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries[1].when = journal.entries[0].when - 1;
      writeFileSync(journalPath, JSON.stringify(journal));
      expect(() => readMigrations(dir)).toThrow(/nu e mai nouă/);
      rmSync(join(dir, "0001_rls.sql"));
      journal.entries[1].when = journal.entries[0].when + 1;
      writeFileSync(journalPath, JSON.stringify(journal));
      expect(() => readMigrations(dir)).toThrow(/lipsește fișierul 0001_rls.sql/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI finet-migrate (fără bază)", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { cwd: process.cwd(), out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    };
  };

  it("refuză alt rol decât migrate și nu afișează URL-ul", async () => {
    const t = io();
    const secret = "parolaSecretaDeTest123";
    const code = await main({
      ...t.io,
      env: { APP_MODE: "personal", FINET_ROLE: "web", DATABASE_URL: `postgres://u:${secret}@h/db` },
    });
    expect(code).toBe(1);
    expect(t.err.join("\n")).toContain("FINET_ROLE");
    expect([...t.out, ...t.err].join("\n")).not.toContain(secret);
  });

  it("refuză rolul migrate fără URL (eroare de configurare, cod 1)", async () => {
    const t = io();
    const code = await main({ ...t.io, env: { APP_MODE: "personal", FINET_ROLE: "migrate" } });
    expect(code).toBe(1);
    expect(t.err.join("\n")).toContain("MIGRATOR_DATABASE_URL");
  });

  it("o eroare de conexiune dă cod 1, fără parolă în mesaj", async () => {
    const t = io();
    const secret = "altaParolaDeTest456";
    const code = await main({
      ...t.io,
      env: {
        APP_MODE: "personal",
        FINET_ROLE: "migrate",
        // Port închis pe localhost: conexiunea e refuzată imediat.
        MIGRATOR_DATABASE_URL: `postgres://finet_migrator:${secret}@127.0.0.1:1/finet`,
      },
    });
    expect(code).toBe(1);
    expect([...t.out, ...t.err].join("\n")).not.toContain(secret);
    expect(t.err.join("\n")).toContain("EȘEC");
  });

  it("describeError nu întoarce mesajele erorilor necunoscute", () => {
    expect(describeError(new Error("postgres://u:secret@h/db"))).toBe("eroare neașteptată");
    expect(describeError({ code: "ECONNREFUSED", message: "x secret" })).toBe(
      "eroare de conexiune sau de sistem (ECONNREFUSED)",
    );
  });
});

describe.skipIf(!TEST_ADMIN_URL)("runner pe PostgreSQL real (finet_migrator)", () => {
  let db: ScratchDatabase;

  beforeAll(async () => {
    db = await createScratchDatabase("finet_it_mig");
  });
  afterAll(async () => {
    await db?.drop();
  });

  it("aplică migrațiile de la zero, apoi a doua rulare nu mai aplică nimic", async () => {
    const sql = testClient(db.migratorUrl, 1);
    try {
      const lines: string[] = [];
      const first = await runMigrations(sql, { folder: MIGRATIONS_DIR, log: (l) => lines.push(l) });
      expect(first).toEqual({
        applied: [
          "0000_core",
          "0001_rls",
          "0002_ledger",
          "0003_idempotency_purge",
          "0004_budgets_goals_tags",
          "0005_perf_indexes",
        ],
        alreadyApplied: 0,
      });
      expect(lines).toEqual([
        "aplicată: 0000_core",
        "aplicată: 0001_rls",
        "aplicată: 0002_ledger",
        "aplicată: 0003_idempotency_purge",
        "aplicată: 0004_budgets_goals_tags",
        "aplicată: 0005_perf_indexes",
      ]);
      const second = await runMigrations(sql, { folder: MIGRATIONS_DIR });
      expect(second).toEqual({ applied: [], alreadyApplied: 6 });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("0004 (și 0005) peste o bază cu 0000–0003 deja aplicate: se aplică doar ele, apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig4");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter(
        (e: { tag: string }) =>
          e.tag !== "0004_budgets_goals_tags" && e.tag !== "0005_perf_indexes",
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(4);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: ["0004_budgets_goals_tags", "0005_perf_indexes"],
        alreadyApplied: 4,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({ applied: [], alreadyApplied: 6 });
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
    // O bază nouă + trei rulări: peste plafonul implicit de 5 s pe un host încărcat.
  }, 60_000);

  it("0005 peste o bază cu 0000–0004 deja aplicate (producția după Faza 3): doar indexul nou", async () => {
    const fresh = await createScratchDatabase("finet_it_mig5");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter(
        (e: { tag: string }) => e.tag !== "0005_perf_indexes",
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(5);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: ["0005_perf_indexes"],
        alreadyApplied: 5,
      });
      const idx = await fresh.admin<{ indexdef: string }[]>`
        select indexdef from pg_indexes
         where schemaname = 'finet' and indexname = 'transactions_household_date_idx'`;
      expect(idx[0]?.indexdef).toContain("occurred_on DESC, id DESC");
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  }, 60_000);

  it("evidența stă în finet.__drizzle_migrations (nu în public sau în schema drizzle)", async () => {
    const rows = await db.admin<{ schemaname: string; tablename: string; tableowner: string }[]>`
      select schemaname, tablename, tableowner from pg_tables
       where tablename = '__drizzle_migrations'`;
    expect(rows).toEqual([
      { schemaname: "finet", tablename: "__drizzle_migrations", tableowner: "finet_migrator" },
    ]);
    const [counted] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from finet.__drizzle_migrations`;
    expect(counted?.n).toBe(6);
    const schemas = await db.admin<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname = 'drizzle'`;
    expect(schemas).toEqual([]);
  });

  it("toate tabelele FINET sunt în schema finet, deținute de finet_migrator", async () => {
    const rows = await db.admin<{ tablename: string; tableowner: string }[]>`
      select tablename, tableowner from pg_tables where schemaname = 'finet' order by tablename`;
    expect(rows.map((r) => r.tablename)).toEqual([
      "__drizzle_migrations",
      "accounts",
      "app_downloads",
      "app_events",
      "audit_events",
      "auth_accounts",
      "auth_rate_limits",
      "auth_sessions",
      "auth_verifications",
      "bootstrap_state",
      "budgets",
      "categories",
      "category_visibility",
      "client_installations",
      "consents",
      "goals",
      "household_members",
      "households",
      "idempotency_keys",
      "tag_visibility",
      "tags",
      "transaction_tags",
      "transactions",
      "user_preferences",
      "users",
    ]);
    expect(new Set(rows.map((r) => r.tableowner))).toEqual(new Set(["finet_migrator"]));
    const publicTables = await db.admin`select 1 from pg_tables where schemaname = 'public'`;
    expect(publicTables.length).toBe(0);
  });

  it("refuză o migrație aplicată și modificată ulterior", async () => {
    const dir = copyMigrations();
    const sql = testClient(db.migratorUrl, 1);
    try {
      const file = join(dir, "0001_rls.sql");
      writeFileSync(file, readFileSync(file, "utf8") + "\n-- modificare\n");
      await expect(runMigrations(sql, { folder: dir })).rejects.toThrow(/modificată după aplicare/);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuză o bază cu migrații necunoscute codului", async () => {
    const dir = copyMigrations();
    const sql = testClient(db.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      journal.entries = journal.entries.slice(0, 1);
      writeFileSync(journalPath, JSON.stringify(journal));
      await expect(runMigrations(sql, { folder: dir })).rejects.toThrow(/lipsește din jurnal/);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o migrație care eșuează nu lasă nimic aplicat (o singură tranzacție)", async () => {
    const dir = copyMigrations();
    const sql = testClient(db.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const last = journal.entries[journal.entries.length - 1];
      journal.entries.push(
        { idx: last.idx + 1, version: "7", when: last.when + 1, tag: "0002_ok", breakpoints: true },
        {
          idx: last.idx + 2,
          version: "7",
          when: last.when + 2,
          tag: "0003_bad",
          breakpoints: true,
        },
      );
      writeFileSync(journalPath, JSON.stringify(journal));
      writeFileSync(join(dir, "0002_ok.sql"), "create table finet.t_ok (id int);");
      writeFileSync(join(dir, "0003_bad.sql"), "select * from finet.nu_exista;");
      await expect(runMigrations(sql, { folder: dir })).rejects.toThrow();
      const rows =
        await db.admin`select 1 from pg_tables where schemaname = 'finet' and tablename = 't_ok'`;
      expect(rows.length).toBe(0);
      const [counted] = await db.admin<{ n: number }[]>`
        select count(*)::int as n from finet.__drizzle_migrations`;
      expect(counted?.n).toBe(6);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: rulează ca rol migrate, cod 0, fără URL în ieșire", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main({
      env: { APP_MODE: "personal", FINET_ROLE: "migrate", MIGRATOR_DATABASE_URL: db.migratorUrl },
      cwd: process.cwd(),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out).toEqual(["finet-migrate: gata; aplicate acum 0, deja aplicate 6"]);
    expect(out.join("\n")).not.toContain("finet_migrator_ci");
  });
});
