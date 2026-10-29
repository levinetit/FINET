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
  it("citește jurnalul repo-ului: 0000_core … 0012_family, fără CREATE SCHEMA", () => {
    const migrations = readMigrations(MIGRATIONS_DIR);
    expect(migrations.map((m) => m.tag)).toEqual([
      "0000_core",
      "0001_rls",
      "0002_ledger",
      "0003_idempotency_purge",
      "0004_budgets_goals_tags",
      "0005_perf_indexes",
      "0006_recurring",
      "0007_pgboss",
      "0008_documents",
      "0009_receipt_pipeline",
      "0010_worker_queue_fairness",
      "0011_document_retention",
      "0012_family",
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

  it("0006_recurring: tabele noi cu RLS ENABLE + FORCE; o singură funcție SECURITY DEFINER; transactions doar cheie + index", () => {
    const rec = readMigrations(MIGRATIONS_DIR).find((m) => m.tag === "0006_recurring")!;
    const text = rec.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((m) => m[1]!);
    expect(created.sort()).toEqual([
      "recurring_occurrences",
      "recurring_rules",
      "service_heartbeats",
    ]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    const code = text.replace(/--.*$/gm, "");
    // Singura funcție SECURITY DEFINER: selecția scadențelor (cu search_path fix).
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    expect(code).toMatch(
      /function finet\.due_recurring_rules[\s\S]*security definer\s+set search_path = pg_catalog/,
    );
    expect(code).not.toMatch(/\b(drop|truncate)\b|\bdelete\s+from\b|\bupdate\s+finet\./i);
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((m) => m[1]!);
    expect(new Set(altered.filter((t) => !created.includes(t)))).toEqual(new Set(["transactions"]));
    // Cheia nouă pe transactions: NOT VALID, apoi VALIDATE (fără rescrierea datelor).
    expect(code.indexOf("not valid")).toBeLessThan(
      code.indexOf("validate constraint transactions_recurring_rule_fk"),
    );
  });

  it("0007_pgboss: fără BEGIN/COMMIT/SET LOCAL/CREATE SCHEMA, gardă pe schemă la început, drepturi la final", () => {
    const boss = readMigrations(MIGRATIONS_DIR).find((m) => m.tag === "0007_pgboss")!;
    for (const st of boss.statements) {
      const code = st.replace(/--.*$/gm, "").trim();
      expect(code).not.toMatch(/^(begin|commit|set local)\b/i);
      expect(code).not.toMatch(/^create\s+schema/i);
    }
    expect(boss.statements[0]).toMatch(/lipsește schema pgboss/);
    const text = boss.statements.join("\n");
    expect(text).toContain("grant usage on schema pgboss to finet_app");
    expect(text).not.toMatch(
      /grant[^;]*\b(create|truncate|references|trigger)\b[^;]*to finet_app/i,
    );
  });

  it("0008_documents: tabele noi cu RLS ENABLE + FORCE; o singură funcție SECURITY DEFINER; transactions doar cheie + index", () => {
    const docs = readMigrations(MIGRATIONS_DIR).find((m) => m.tag === "0008_documents")!;
    const text = docs.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((m) => m[1]!);
    expect(created.sort()).toEqual([
      "ai_calls",
      "document_usage_daily",
      "documents",
      "processing_batches",
      "product_aliases",
      "receipt_lines",
      "receipts",
    ]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
      expect(text).toContain(`create policy ${table}_household on finet.${table}`);
    }
    const code = text.replace(/--.*$/gm, "");
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    expect(code).toMatch(
      /function finet\.queued_documents[\s\S]*security definer\s+set search_path = pg_catalog/,
    );
    // Triggerele: SECURITY INVOKER cu search_path fix.
    expect([...code.matchAll(/security invoker\s+set search_path = pg_catalog/gi)]).toHaveLength(2);
    expect(code).not.toMatch(/\b(drop|truncate)\b|\bdelete\s+from\b|\bupdate\s+finet\./i);
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((m) => m[1]!);
    expect(new Set(altered.filter((t) => !created.includes(t)))).toEqual(new Set(["transactions"]));
    expect(code.indexOf("not valid")).toBeLessThan(
      code.indexOf("validate constraint transactions_document_fk"),
    );
    // ai_calls: jurnal, fără UPDATE/DELETE pentru aplicație.
    expect(code).toContain("grant select, insert on finet.ai_calls to finet_app");
    expect(code).not.toMatch(/grant[^;]*(update|delete)[^;]*on finet\.ai_calls/i);
  });

  it("0010_worker_queue_fairness: doar funcțiile de selecție (aceleași semnături, SECURITY DEFINER, search_path fix) și o politică de citire a loturilor eșuate", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0010_worker_queue_fairness")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    expect(code).not.toMatch(
      /create\s+table|alter\s+table|\bdrop\b|\btruncate\b|\bdelete\s+from\b/i,
    );
    expect(
      [...code.matchAll(/create or replace function finet\.(\w+)\(/g)].map((x) => x[1]),
    ).toEqual(["queued_documents", "queued_document"]);
    expect([...code.matchAll(/security definer\s+set search_path = pg_catalog/gi)]).toHaveLength(2);
    expect(code).toContain("for select to finet_migrator\n  using (status = 'failed')");
    expect(code).toContain(
      "grant execute on function finet.queued_documents(integer, integer) to finet_app",
    );
    expect(code).toContain("grant execute on function finet.queued_document(uuid) to finet_app");
  });

  it("0011_document_retention: doar o funcție SECURITY DEFINER (doar identificatori) și o politică de citire a documentelor expirate", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0011_document_retention")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    expect(code).not.toMatch(
      /create\s+table|alter\s+table|\bdrop\b|\btruncate\b|\bdelete\s+from\b|\bupdate\s+finet\./i,
    );
    expect([...code.matchAll(/create function finet\.(\w+)\(/g)].map((x) => x[1])).toEqual([
      "expired_documents",
    ]);
    expect([...code.matchAll(/security definer\s+set search_path = pg_catalog/gi)]).toHaveLength(1);
    expect(code).toContain(
      "returns table (document_id uuid, household_id uuid, actor_user_id uuid)",
    );
    expect(code).toContain("revoke all on function finet.expired_documents(integer) from public");
    expect(code).toContain(
      "grant execute on function finet.expired_documents(integer) to finet_app",
    );
    expect(code).toMatch(
      /create policy documents_migrator_expired on finet\.documents\s+for select to finet_migrator/,
    );
    // CHECK-uri / filtre plate (fără BETWEEN într-un lanț AND).
    expect(code).not.toMatch(/\bbetween\b/i);
  });

  it("0012_family: tabele noi cu RLS ENABLE + FORCE; politicile existente doar restrânse (ALTER POLICY); funcțiile SECURITY DEFINER cunoscute; CHECK-uri plate", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0012_family")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created.sort()).toEqual(["household_invites", "settlements", "transaction_splits"]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    const code = text.replace(/--.*$/gm, "");
    // Nimic distrus: fără DROP/TRUNCATE/DELETE/UPDATE pe date existente.
    expect(code).not.toMatch(
      /\bdrop\b|\btruncate\b|\bdelete\s+from\b|\bupdate\s+finet\.(?!household_invites)/i,
    );
    // CHECK-uri / filtre plate (fără BETWEEN într-un lanț AND).
    expect(code).not.toMatch(/\bbetween\b/i);
    // Fără `x in (col1, col2, ...)` în politici: Postgres îl stochează ca OR imbricat, iar pg_dump
    // îl reafișează plat (amprenta restaurării diferă). Se scrie `x = a or x = b or x = c`.
    expect(code).not.toMatch(/current_user_id\(\)\)\s+in\s+\(/i);
    // Politicile existente se schimbă doar prin ALTER POLICY, cu aceleași nume.
    expect([...code.matchAll(/alter policy (\w+) on/g)].map((x) => x[1])).toEqual([
      "accounts_household",
      "transactions_household",
      "transaction_tags_household",
      "recurring_rules_household",
      "recurring_occurrences_household",
    ]);
    // Funcțiile SECURITY DEFINER: exact acestea, toate cu search_path fix.
    const definers = [
      ...code.matchAll(
        /create (?:or replace )?function finet\.(\w+)\([^)]*\)[^$]*?security definer\s+set search_path = pg_catalog/g,
      ),
    ].map((x) => x[1]);
    expect(definers).toEqual([
      "check_transfer_group",
      "due_recurring_rules",
      "category_used_elsewhere",
      "household_members_check_cap",
      "household_members_guard_owner",
      "accept_invite",
    ]);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(6);
    // Politicile noi ale proprietarului (finet_migrator): doar citiri înguste și inserarea
    // apartenenței în curs de acceptare.
    expect(
      [...code.matchAll(/create policy (\w+) on finet\.\w+\s+for (\w+) to finet_migrator/g)].map(
        (x) => `${x[1]}:${x[2]}`,
      ),
    ).toEqual([
      "transactions_migrator_transfer_check:select",
      "accounts_migrator_personal_owner:select",
      "transactions_migrator_category_check:select",
      "recurring_rules_migrator_category_check:select",
      "budgets_migrator_category_check:select",
      "household_members_migrator_join:insert",
      "household_invites_migrator_accept_read:select",
      "household_invites_migrator_accept_use:update",
    ]);
    // Tabelele existente atinse: doar user_preferences (coloana nouă + cheia).
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((x) => x[1]!);
    expect(new Set(altered.filter((t) => !created.includes(t)))).toEqual(
      new Set(["user_preferences"]),
    );
    // Hash-ul tokenului nu e citibil de aplicație.
    const grantSelect = code.match(/grant select \(([^)]*)\) on finet\.household_invites/);
    expect(grantSelect?.[1]).not.toContain("token_hash");
    expect(code).toContain("grant execute on function finet.accept_invite(text) to finet_app");
    expect(code).toContain(
      "grant execute on function finet.category_used_elsewhere(uuid) to finet_app",
    );
    // Politica pe conturile personale a proprietarului e legată de o variabilă de tranzacție.
    expect(code).toMatch(
      /accounts_migrator_personal_owner on finet\.accounts\s+for select to finet_migrator\s+using \(owner_user_id is not null\s+and current_setting\('finet\.definer_scope', true\)/,
    );
    expect(code).not.toMatch(/grant[^;]*delete[^;]*on finet\.(household_invites|settlements)/i);
  });

  it("0009_receipt_pipeline: RLS ENABLE + FORCE pe tabelele noi; 3 funcții SECURITY DEFINER; bugetul fără drepturi directe", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0009_receipt_pipeline")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created.sort()).toEqual(["ai_budget_usage", "vat_rates"]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    const code = text.replace(/--.*$/gm, "");
    expect([...code.matchAll(/security\s+definer\s+set search_path = pg_catalog/gi)]).toHaveLength(
      3,
    );
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(3);
    // finet_app nu atinge direct contorul bugetului (doar prin funcții).
    expect(code).not.toMatch(/grant[^;]*on finet\.ai_budget_usage/i);
    expect(code).toContain("grant select on finet.vat_rates to finet_app");
    expect(code).not.toMatch(/grant[^;]*(insert|update|delete)[^;]*on finet\.vat_rates/i);
    // Doar `receipts` dintre tabelele existente se modifică; nimic nu se șterge.
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((x) => x[1]!);
    expect(new Set(altered.filter((t) => !created.includes(t)))).toEqual(new Set(["receipts"]));
    expect(code).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\bdrop\s+(table|column)\b/i);
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
          "0006_recurring",
          "0007_pgboss",
          "0008_documents",
          "0009_receipt_pipeline",
          "0010_worker_queue_fairness",
          "0011_document_retention",
          "0012_family",
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
        "aplicată: 0006_recurring",
        "aplicată: 0007_pgboss",
        "aplicată: 0008_documents",
        "aplicată: 0009_receipt_pipeline",
        "aplicată: 0010_worker_queue_fairness",
        "aplicată: 0011_document_retention",
        "aplicată: 0012_family",
      ]);
      const second = await runMigrations(sql, { folder: MIGRATIONS_DIR });
      expect(second).toEqual({ applied: [], alreadyApplied: 13 });
    } finally {
      await sql.end({ timeout: 5 });
    }
    // 13 migrații pe un host încărcat: peste plafonul implicit de 5 s.
  }, 60_000);

  it("0004 (și 0005) peste o bază cu 0000–0003 deja aplicate: se aplică doar ele, apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig4");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 4);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(4);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [
          "0004_budgets_goals_tags",
          "0005_perf_indexes",
          "0006_recurring",
          "0007_pgboss",
          "0008_documents",
          "0009_receipt_pipeline",
          "0010_worker_queue_fairness",
          "0011_document_retention",
          "0012_family",
        ],
        alreadyApplied: 4,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 13,
      });
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
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 5);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(5);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [
          "0005_perf_indexes",
          "0006_recurring",
          "0007_pgboss",
          "0008_documents",
          "0009_receipt_pipeline",
          "0010_worker_queue_fairness",
          "0011_document_retention",
          "0012_family",
        ],
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

  it("0006 + 0007 peste o bază cu 0000–0005 aplicate și date (producția după Faza 4), apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig6");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 6);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(6);
      // O tranzacție existentă (ca superuser), ca VALIDATE să ruleze peste date reale.
      await fresh.admin.unsafe(`
        insert into finet.users (id, email, name) values ('00000000-0000-4000-8000-000000000001', 'x@exemplu.ro', 'X');
        insert into finet.households (id, name, created_by) values ('00000000-0000-4000-8000-000000000002', 'H', '00000000-0000-4000-8000-000000000001');
        insert into finet.accounts (id, household_id, name, type, currency) values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'C', 'cash', 'RON');
        insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on) values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'expense', 100, 'RON', date '2026-01-01');`);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [
          "0006_recurring",
          "0007_pgboss",
          "0008_documents",
          "0009_receipt_pipeline",
          "0010_worker_queue_fairness",
          "0011_document_retention",
          "0012_family",
        ],
        alreadyApplied: 6,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 13,
      });
      const [fk] = await fresh.admin<{ convalidated: boolean }[]>`
        select convalidated from pg_constraint where conname = 'transactions_recurring_rule_fk'`;
      expect(fk?.convalidated).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  }, 60_000);

  it("0008 peste o bază cu 0000–0007 aplicate și date (producția după Faza 5), apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig8");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 8);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(8);
      // Tranzacții existente (ca superuser), ca VALIDATE să ruleze peste date reale.
      await fresh.admin.unsafe(`
        insert into finet.users (id, email, name) values ('00000000-0000-4000-8000-000000000001', 'x@exemplu.ro', 'X');
        insert into finet.households (id, name, created_by) values ('00000000-0000-4000-8000-000000000002', 'H', '00000000-0000-4000-8000-000000000001');
        insert into finet.accounts (id, household_id, name, type, currency) values ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'C', 'cash', 'RON');
        insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on) values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'expense', 100, 'RON', date '2026-01-01');
        insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on, source) values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 'expense', 250, 'RON', date '2026-02-01', 'manual');`);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [
          "0008_documents",
          "0009_receipt_pipeline",
          "0010_worker_queue_fairness",
          "0011_document_retention",
          "0012_family",
        ],
        alreadyApplied: 8,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 13,
      });
      const [fk] = await fresh.admin<{ convalidated: boolean }[]>`
        select convalidated from pg_constraint where conname = 'transactions_document_fk'`;
      expect(fk?.convalidated).toBe(true);
      const [n] = await fresh.admin<
        { n: number }[]
      >`select count(*)::int as n from finet.transactions`;
      expect(n?.n).toBe(2);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  }, 60_000);

  it("0009 peste o bază cu 0000–0008 aplicate și un bon existent, apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig9");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 9);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(9);
      await fresh.admin.unsafe(`
        insert into finet.users (id, email, name) values ('00000000-0000-4000-8000-000000000001', 'x@exemplu.ro', 'X');
        insert into finet.households (id, name, created_by) values ('00000000-0000-4000-8000-000000000002', 'H', '00000000-0000-4000-8000-000000000001');
        insert into finet.processing_batches (id, household_id, kind) values ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000002', 'single');
        insert into finet.receipts (household_id, batch_id, fallback_reason) values ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000004', 'external_failed');`);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [
          "0009_receipt_pipeline",
          "0010_worker_queue_fairness",
          "0011_document_retention",
          "0012_family",
        ],
        alreadyApplied: 9,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 13,
      });
      const [r] = await fresh.admin<{ issues: unknown; fallback_reason: string }[]>`
        select issues, fallback_reason from finet.receipts`;
      expect(r).toEqual({ issues: [], fallback_reason: "external_failed" });
      const [v] = await fresh.admin<
        { n: number }[]
      >`select count(*)::int as n from finet.vat_rates`;
      expect(v?.n).toBe(7);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  }, 60_000);

  it("0011 peste o bază cu 0000–0010 aplicate și un document expirat, apoi nimic; funcția întoarce doar identificatori", async () => {
    const fresh = await createScratchDatabase("finet_it_mig11");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 11);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(11);
      const H = "00000000-0000-4000-8000-000000000002";
      const D1 = "00000000-0000-4000-8000-0000000000d1";
      const D2 = "00000000-0000-4000-8000-0000000000d2";
      await fresh.admin.unsafe(`
        insert into finet.users (id, email, name) values ('00000000-0000-4000-8000-000000000001', 'x@exemplu.ro', 'X');
        insert into finet.households (id, name, created_by) values ('${H}', 'H', '00000000-0000-4000-8000-000000000001');
        insert into finet.household_members (household_id, user_id, role) values ('${H}', '00000000-0000-4000-8000-000000000001', 'owner');
        insert into finet.documents (id, household_id, uploaded_by_user_id, status, storage_key, detected_mime, size_bytes, sha256, expires_at)
          values ('${D1}', '${H}', '00000000-0000-4000-8000-000000000001', 'needs_review', 'households/${H}/documents/${D1}', 'image/jpeg', 10, repeat('a', 64), now() - interval '1 day'),
                 ('${D2}', '${H}', '00000000-0000-4000-8000-000000000001', 'needs_review', 'households/${H}/documents/${D2}', 'image/jpeg', 10, repeat('b', 64), now() + interval '1 day');`);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: ["0011_document_retention", "0012_family"],
        alreadyApplied: 11,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 13,
      });
      const app = testClient(fresh.appUrl, 1);
      try {
        const rows = await app<
          Record<string, unknown>[]
        >`select * from finet.expired_documents(10)`;
        expect(rows).toEqual([
          {
            document_id: D1,
            household_id: H,
            actor_user_id: "00000000-0000-4000-8000-000000000001",
          },
        ]);
        // finet_app nu vede direct documentele fără contextul gospodăriei.
        expect(await app`select id from finet.documents`).toHaveLength(0);
        expect(await app`select * from finet.expired_documents(-5)`).toHaveLength(0);
      } finally {
        await app.end({ timeout: 5 });
      }
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  }, 60_000);

  it("0012 peste o bază cu 0000–0011 aplicate și date (producția după Faza 6): contul cu proprietar devine personal, apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig12");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 12);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(12);
      const U1 = "00000000-0000-4000-8000-000000000001";
      const U2 = "00000000-0000-4000-8000-000000000002";
      const H = "00000000-0000-4000-8000-0000000000a1";
      const ACOM = "00000000-0000-4000-8000-0000000000c1";
      const APERS = "00000000-0000-4000-8000-0000000000c2";
      await fresh.admin.unsafe(`
        insert into finet.users (id, email, name) values ('${U1}', 'u1@exemplu.ro', 'U1'), ('${U2}', 'u2@exemplu.ro', 'U2');
        insert into finet.households (id, name, created_by) values ('${H}', 'H', '${U1}');
        insert into finet.household_members (household_id, user_id, role) values ('${H}', '${U1}', 'owner'), ('${H}', '${U2}', 'member');
        insert into finet.user_preferences (user_id) values ('${U1}');
        insert into finet.accounts (id, household_id, owner_user_id, name, type, currency)
          values ('${ACOM}', '${H}', null, 'Comun', 'bank', 'RON'), ('${APERS}', '${H}', '${U2}', 'Al lui U2', 'cash', 'RON');
        insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on)
          values ('${H}', '${ACOM}', 'expense', 100, 'RON', '2026-10-01'), ('${H}', '${APERS}', 'expense', 200, 'RON', '2026-10-01');`);
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: ["0012_family"],
        alreadyApplied: 12,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 13,
      });
      // Datele existente rămân neatinse; preferința nouă e NULL.
      const [pref] = await fresh.admin<{ active_household_id: string | null }[]>`
        select active_household_id from finet.user_preferences where user_id = ${U1}`;
      expect(pref?.active_household_id).toBeNull();
      const app = testClient(fresh.appUrl, 1);
      try {
        const visible = (user: string) =>
          app.begin(async (t) => {
            await t`select set_config('app.user_id', ${user}, true), set_config('app.household_id', ${H}, true)`;
            const accounts = await t<{ id: string }[]>`select id from finet.accounts order by id`;
            const txs = await t<{ amount_minor: string }[]>`
              select amount_minor::text from finet.transactions order by amount_minor`;
            return { accounts: accounts.map((r) => r.id), txs: txs.map((r) => r.amount_minor) };
          });
        expect(await visible(U1)).toEqual({ accounts: [ACOM], txs: ["100"] });
        expect(await visible(U2)).toEqual({ accounts: [ACOM, APERS], txs: ["100", "200"] });
      } finally {
        await app.end({ timeout: 5 });
      }
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  }, 60_000);

  it("0007 fără schema pgboss creată de operator: eșuează explicit, nimic aplicat", async () => {
    const fresh = await createScratchDatabase("finet_it_mig7");
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      await fresh.admin`drop schema pgboss`;
      await expect(runMigrations(sql, { folder: MIGRATIONS_DIR })).rejects.toThrow(
        /lipsește schema pgboss/,
      );
      const tables = await fresh.admin`select 1 from pg_tables where schemaname = 'finet'`;
      expect(tables.length).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
      await fresh.drop();
    }
  }, 60_000);

  it("schema pgboss: deținută de finet_migrator, cu tabelele pg-boss și versiunea așteptată", async () => {
    const [owner] = await db.admin<{ owner: string }[]>`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'`;
    expect(owner?.owner).toBe("finet_migrator");
    const owners = await db.admin<{ tableowner: string }[]>`
      select distinct tableowner from pg_tables where schemaname = 'pgboss'`;
    expect(owners).toEqual([{ tableowner: "finet_migrator" }]);
    const [v] = await db.admin<{ version: number }[]>`select version from pgboss.version`;
    expect(v?.version).toBe(46);
  });

  it("evidența stă în finet.__drizzle_migrations (nu în public sau în schema drizzle)", async () => {
    const rows = await db.admin<{ schemaname: string; tablename: string; tableowner: string }[]>`
      select schemaname, tablename, tableowner from pg_tables
       where tablename = '__drizzle_migrations'`;
    expect(rows).toEqual([
      { schemaname: "finet", tablename: "__drizzle_migrations", tableowner: "finet_migrator" },
    ]);
    const [counted] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from finet.__drizzle_migrations`;
    expect(counted?.n).toBe(13);
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
      "ai_budget_usage",
      "ai_calls",
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
      "document_usage_daily",
      "documents",
      "goals",
      "household_invites",
      "household_members",
      "households",
      "idempotency_keys",
      "processing_batches",
      "product_aliases",
      "receipt_lines",
      "receipts",
      "recurring_occurrences",
      "recurring_rules",
      "service_heartbeats",
      "settlements",
      "tag_visibility",
      "tags",
      "transaction_splits",
      "transaction_tags",
      "transactions",
      "user_preferences",
      "users",
      "vat_rates",
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
      expect(counted?.n).toBe(13);
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
    expect(out).toEqual(["finet-migrate: gata; aplicate acum 0, deja aplicate 13"]);
    expect(out.join("\n")).not.toContain("finet_migrator_ci");
  });
});
