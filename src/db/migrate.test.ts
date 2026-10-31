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

/**
 * Amprenta schemei `finet` (fără date): tabele și coloane, constrângeri, indecși, politici,
 * funcții (definiția), triggere, ACL-uri. Două baze cu aceeași amprentă au aceeași schemă.
 */
async function schemaFingerprint(admin: ScratchDatabase["admin"]): Promise<string[]> {
  const rows = await admin.unsafe<{ line: string }[]>(`
    select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || ' ' || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') as line
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where c.relnamespace = 'finet'::regnamespace and c.relkind = 'r' and a.attnum > 0
       and not a.attisdropped
    union all
    select 'rel ' || c.relname || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity || ' '
           || coalesce(c.relacl::text, '')
      from pg_class c where c.relnamespace = 'finet'::regnamespace
    union all
    select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'finet'::regnamespace
    union all
    select 'idx ' || pg_get_indexdef(indexrelid) from pg_index
     where indrelid in (select oid from pg_class where relnamespace = 'finet'::regnamespace)
    union all
    select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || roles::text || ' '
           || coalesce(qual, '') || ' ' || coalesce(with_check, '')
      from pg_policies where schemaname = 'finet'
    union all
    select 'fun ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
           || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '')
      from pg_proc p where p.pronamespace = 'finet'::regnamespace
    union all
    select 'trg ' || pg_get_triggerdef(oid) from pg_trigger
     where not tgisinternal
       and tgrelid in (select oid from pg_class where relnamespace = 'finet'::regnamespace)
    order by 1`);
  return rows.map((r) => r.line);
}

function copyMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "finet-mig-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

describe("readMigrations (fără bază)", () => {
  it("citește jurnalul repo-ului: 0000_core … 0012_family, 0016_gdpr_stats, 0013_statements, 0014_statement_uploads, 0017_shopping_lists, 0018_report_definitions, 0019_ask_finet_task, 0020_admin_feedback, 0021_purge_unverified, 0022_admin_guard, 0023_plans_subscriptions, 0024_queue_priority, 0025_referrals, 0026_feedback_reward, fără CREATE SCHEMA", () => {
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
      // 0016 (Faza 9) e aplicată pe producție înaintea Fazei 7: 0013 și 0014 au `when` ridicat peste ea
      // (ordinea de aplicare din jurnal: … 0012, 0016, 0013, 0014; ADR 0018 §12).
      "0016_gdpr_stats",
      "0013_statements",
      "0014_statement_uploads",
      "0017_shopping_lists",
      "0018_report_definitions",
      "0019_ask_finet_task",
      "0020_admin_feedback",
      "0021_purge_unverified",
      "0022_admin_guard",
      "0023_plans_subscriptions",
      "0024_queue_priority",
      "0025_referrals",
      "0026_feedback_reward",
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

  it("0016_gdpr_stats: tabelul nou cu RLS ENABLE + FORCE și fără drepturi pentru aplicație; 4 funcții SECURITY DEFINER; politicile proprietarului legate de `finet.definer_scope`; CHECK-uri plate", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0016_gdpr_stats")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created).toEqual(["app_event_daily"]);
    expect(text).toContain("alter table finet.app_event_daily enable row level security");
    expect(text).toContain("alter table finet.app_event_daily force row level security");
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bdrop\b|\btruncate\b|\balter policy\b/i);
    expect(code).not.toMatch(/\bbetween\b/i);
    expect(code).not.toMatch(/current_user_id\(\)\)\s+in\s+\(/i);
    // Fără niciun drept direct al aplicației pe tabelul nou și fără coloane noi pe tabele existente.
    expect(code).not.toMatch(/grant [^;]*on finet\.app_event_daily/i);
    expect(code).not.toMatch(/alter table "?finet"?\."?(?!app_event_daily)\w+"? add/i);
    const definers = [
      ...code.matchAll(
        /create function finet\.(\w+)\([^)]*\)[^$]*?security definer\s+set search_path = pg_catalog/g,
      ),
    ].map((x) => x[1]);
    expect(definers).toEqual([
      "erase_current_user",
      "aggregate_app_events",
      "usage_stats",
      "existing_households",
    ]);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(4);
    const policies = [
      ...code.matchAll(
        /create policy (\w+) on finet\.\w+\s+for (\w+) to (\w+)\s+(?:using|with check) \(([^\n]*)/g,
      ),
    ];
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      // Doar pentru proprietar și doar în interiorul funcțiilor (variabila tranzacției).
      expect(p[3]).toBe("finet_migrator");
      expect(p[4]).toMatch(/^current_setting\('finet\.definer_scope', true\)/);
    }
    expect(code).toContain(
      "revoke all on function finet.erase_current_user(), finet.aggregate_app_events(integer),\n  finet.usage_stats(boolean), finet.existing_households(uuid[]) from public",
    );
    // Administratorul e verificat în funcția statisticilor; ștergerea cere utilizatorul fără apartenențe.
    expect(code).toMatch(/u\.is_platform_admin and u\.status = 'active'/);
    expect(code).toMatch(
      /exists \(select 1 from finet\.household_members m where m\.user_id = v_user\)/,
    );
  });

  it("0013_statements: tabele noi cu RLS ENABLE + FORCE; fără ALTER pe tabelele existente; fără SECURITY DEFINER; CHECK-uri plate; drepturi pe coloane", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0013_statements")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created.sort()).toEqual([
      "statement_imports",
      "statement_lines",
      "statement_usage_daily",
    ]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bdrop\b|\btruncate\b|\bdelete\s+from\b|\bupdate\s+finet\./i);
    expect(code).not.toMatch(/\bbetween\b/i);
    expect(code).not.toMatch(/security\s+definer/i);
    // Triggerele de integritate (SECURITY INVOKER: RLS-ul apelantului se aplică și în ele).
    expect(
      [
        ...code.matchAll(
          /create function finet\.(\w+)\(\)[^$]*?security invoker\s+set search_path = pg_catalog/g,
        ),
      ].map((x) => x[1]),
    ).toEqual([
      "statement_lines_check_transaction",
      "statement_imports_check_update",
      "statement_lines_check_update",
    ]);
    expect(code).not.toMatch(/alter policy/i);
    // Doar tabelele noi sunt modificate (cheile străine noi indică spre tabelele existente).
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((x) => x[1]!);
    expect(new Set(altered)).toEqual(new Set(created));
    // Politicile: fiecare repetă vizibilitatea contului (personal ⇒ doar proprietarul).
    const policies = [
      ...code.matchAll(/create policy (\w+) on finet\.(\w+)\s+for (\w+) to (\w+)/g),
    ];
    expect(policies.map((x) => `${x[1]}:${x[3]}:${x[4]}`)).toEqual([
      "statement_imports_select:select:finet_app",
      "statement_imports_insert:insert:finet_app",
      "statement_imports_update:update:finet_app",
      "statement_imports_delete:delete:finet_app",
      "statement_lines_select:select:finet_app",
      "statement_lines_insert:insert:finet_app",
      "statement_lines_update:update:finet_app",
      "statement_lines_delete:delete:finet_app",
      "statement_usage_daily_household:all:finet_app",
    ]);
    expect([
      ...code.matchAll(
        /a\.owner_user_id is null\s+or a\.owner_user_id = \(select finet\.current_user_id\(\)\)/g,
      ),
    ]).toHaveLength(10);
    expect(code).not.toMatch(/grant[^;]*\bupdate\b(?!\s*\()[^;]*on finet\.statement/i);
    expect(code).not.toMatch(/grant[^;]*delete[^;]*on finet\.statement_usage_daily/i);
    expect(code).toContain("on delete set null (transaction_id)");
  });

  it("0014_statement_uploads: tabele noi cu RLS ENABLE + FORCE; 5 funcții SECURITY DEFINER doar cu identificatori; politici pe comandă; CHECK-uri plate; drepturi pe coloane", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0014_statement_uploads")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created.sort()).toEqual([
      "receipt_match_rejections",
      "recurring_suggestion_dismissals",
      "statement_uploads",
    ]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bbetween\b/i);
    expect(code).not.toMatch(/\bdrop\b|\btruncate\b|alter policy/i);
    // Funcțiile SECURITY DEFINER: toate cu `search_path = pg_catalog`, REVOKE de la public.
    const definers = [
      ...code.matchAll(
        /create function finet\.(\w+)\([^)]*\)[^$]*?security definer\s+set search_path = pg_catalog/g,
      ),
    ].map((x) => x[1]);
    expect(definers).toEqual([
      "queued_statement_uploads",
      "queued_statement_upload",
      "cleanable_statement_uploads",
      "forget_statement_upload_file",
      "purge_stale_statement_previews",
    ]);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(5);
    expect(
      [
        ...code.matchAll(
          /create function finet\.(\w+)\(\)[^$]*?security invoker\s+set search_path = pg_catalog/g,
        ),
      ].map((x) => x[1]),
    ).toEqual([
      "statement_uploads_check_update",
      "statement_usage_daily_check_update",
      "receipts_check_transaction",
    ]);
    // Dintre tabelele existente: doar triggere și indexul unic pe `receipts`, triggerul contorului.
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((x) => x[1]!);
    expect(new Set(altered)).toEqual(new Set(created));
    expect(code).toContain(
      "create unique index receipts_transaction_key on finet.receipts (transaction_id)",
    );
    const policies = [
      ...code.matchAll(/create policy (\w+) on finet\.(\w+)\s+for (\w+) to (\w+)/g),
    ];
    expect(policies.map((x) => `${x[1]}:${x[3]}:${x[4]}`)).toEqual([
      "statement_uploads_select:select:finet_app",
      "statement_uploads_insert:insert:finet_app",
      "statement_uploads_update:update:finet_app",
      "statement_uploads_delete:delete:finet_app",
      "statement_uploads_migrator_pending:select:finet_migrator",
      "statement_uploads_migrator_cleanup:select:finet_migrator",
      "statement_uploads_migrator_forgotten:select:finet_migrator",
      "statement_uploads_migrator_forget:update:finet_migrator",
      "statement_imports_migrator_stale_select:select:finet_migrator",
      "statement_imports_migrator_stale_delete:delete:finet_migrator",
      "receipt_match_rejections_select:select:finet_app",
      "receipt_match_rejections_insert:insert:finet_app",
      "receipt_match_rejections_delete:delete:finet_app",
      "recurring_suggestion_dismissals_select:select:finet_app",
      "recurring_suggestion_dismissals_insert:insert:finet_app",
      "recurring_suggestion_dismissals_delete:delete:finet_app",
    ]);
    expect(code).not.toMatch(/grant[^;]*\bupdate\b(?!\s*\()[^;]*on finet\./i);
    expect(code).not.toMatch(
      /grant[^;]*update[^;]*on finet\.(receipt_match_rejections|recurring_suggestion_dismissals)/i,
    );
    expect(code).toContain("on delete set null (import_id)");
  });

  it("0017_shopping_lists: tabele noi cu RLS ENABLE + FORCE; 3 funcții SECURITY DEFINER doar cu identificatori; politici pe comandă; CHECK-uri plate; drepturi pe coloane", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0017_shopping_lists")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created.sort()).toEqual([
      "shopping_list_ai_requests",
      "shopping_list_items",
      "shopping_lists",
    ]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bbetween\b/i);
    expect(code).not.toMatch(
      /\bdrop\b|\btruncate\b|alter policy|\bdelete\s+from\s+finet\.(?!shopping_lists)/i,
    );
    // Funcțiile SECURITY DEFINER: exact acestea, toate cu `search_path = pg_catalog`.
    const definers = [
      ...code.matchAll(
        /create function finet\.(\w+)\([^)]*\)[^$]*?security definer\s+set search_path = pg_catalog/g,
      ),
    ].map((x) => x[1]);
    expect(definers).toEqual([
      "queued_list_matches",
      "queued_list_match",
      "erase_user_shopping_lists",
    ]);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(3);
    for (const fn of [
      "queued_list_matches(integer, integer)",
      "queued_list_match(uuid)",
      "erase_user_shopping_lists()",
    ]) {
      expect(code).toContain(`revoke all on function finet.${fn} from public`);
      expect(code).toContain(`grant execute on function finet.${fn} to finet_app`);
    }
    // Triggerele de integritate: SECURITY INVOKER, cu `search_path = pg_catalog`.
    expect(
      [
        ...code.matchAll(
          /create function finet\.(\w+)\(\)[^$]*?security invoker\s+set search_path = pg_catalog/g,
        ),
      ].map((x) => x[1]),
    ).toEqual([
      "shopping_lists_check_cap",
      "shopping_list_items_check_cap",
      "shopping_lists_check_owner_change",
      "shopping_list_items_check_match",
    ]);
    // Dintre tabelele existente: doar cheia unică pe `receipt_lines` (ținta cheii compuse).
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((x) => x[1]!);
    expect(new Set(altered.filter((t) => !created.includes(t)))).toEqual(
      new Set(["receipt_lines"]),
    );
    expect(code).toContain(
      'ALTER TABLE "finet"."receipt_lines" ADD CONSTRAINT "receipt_lines_id_household_key" UNIQUE("id","household_id")',
    );
    expect(code).toContain("on delete set null (matched_receipt_line_id)");
    // Listele personale ale unui utilizator șters dispar (CASCADE), nu devin comune.
    expect(code).toMatch(
      /"shopping_lists_owner_user_id_users_id_fk" FOREIGN KEY \("owner_user_id"\)[^;]*ON DELETE cascade/,
    );
    const policies = [
      ...code.matchAll(/create policy (\w+) on finet\.(\w+)\s+for (\w+) to (\w+)/g),
    ];
    expect(policies.map((x) => `${x[1]}:${x[3]}:${x[4]}`)).toEqual([
      "shopping_lists_select:select:finet_app",
      "shopping_lists_insert:insert:finet_app",
      "shopping_lists_update:update:finet_app",
      "shopping_lists_delete:delete:finet_app",
      "shopping_list_items_household:all:finet_app",
      "shopping_list_ai_requests_select:select:finet_app",
      "shopping_list_ai_requests_insert:insert:finet_app",
      "shopping_list_ai_requests_update:update:finet_app",
      "shopping_list_ai_requests_migrator_pending:select:finet_migrator",
      "shopping_lists_migrator_erase_select:select:finet_migrator",
      "shopping_lists_migrator_erase_delete:delete:finet_migrator",
    ]);
    // Drepturile de UPDATE sunt doar pe coloane; coada AI nu se șterge din aplicație.
    expect(code).not.toMatch(/grant[^;]*\bupdate\b(?!\s*\()[^;]*on finet\./i);
    expect(code).not.toMatch(/grant[^;]*delete[^;]*on finet\.shopping_list_ai_requests/i);
  });

  it("0018_report_definitions: tabel nou cu RLS ENABLE + FORCE; fără ALTER pe tabele existente; fără SECURITY DEFINER; politici pe comandă; CHECK-uri plate; drepturi pe coloane; seed de sistem înaintea RLS", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0018_report_definitions")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created).toEqual(["report_definitions"]);
    expect(text).toContain("alter table finet.report_definitions enable row level security");
    expect(text).toContain("alter table finet.report_definitions force row level security");
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bbetween\b/i);
    expect(code).not.toMatch(/\bdrop\b|\btruncate\b|alter policy/i);
    expect(code).not.toMatch(/security\s+definer/i);
    expect(
      [
        ...code.matchAll(
          /create function finet\.(\w+)\(\)[^$]*?security invoker\s+set search_path = pg_catalog/g,
        ),
      ].map((x) => x[1]),
    ).toEqual(["report_definitions_check_cap"]);
    // Doar tabelul nou este modificat.
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((x) => x[1]!);
    expect(new Set(altered)).toEqual(new Set(created));
    const policies = [
      ...code.matchAll(/create policy (\w+) on finet\.(\w+)\s+for (\w+) to (\w+)/g),
    ];
    expect(policies.map((x) => `${x[1]}:${x[3]}:${x[4]}`)).toEqual([
      "report_definitions_select:select:finet_app",
      "report_definitions_insert:insert:finet_app",
      "report_definitions_update:update:finet_app",
      "report_definitions_delete:delete:finet_app",
    ]);
    // Scrierile cer gospodăria curentă și interzic rândurile de sistem.
    for (const name of ["insert", "update", "delete"]) {
      const block = code
        .slice(code.indexOf(`create policy report_definitions_${name}`))
        .split(";")[0]!;
      expect(block).toContain("household_id = (select finet.current_household_id())");
      expect(block).toContain("not is_system");
    }
    // Drepturi: SELECT/INSERT/DELETE + UPDATE doar pe coloanele permise (nu household_id/is_system).
    expect(code).toContain("grant select, insert, delete on finet.report_definitions to finet_app");
    expect(code).toMatch(
      /grant update \(name, description, rules, advice, archived, updated_at\)\s+on finet\.report_definitions to finet_app/,
    );
    expect(code).not.toMatch(/grant[^;]*\bupdate\b(?!\s*\()[^;]*on finet\./i);
    // Rapoartele de sistem se inserează ÎNAINTE de activarea RLS (FORCE se aplică și proprietarului).
    expect(code.indexOf("insert into finet.report_definitions")).toBeGreaterThan(-1);
    expect(code.lastIndexOf("insert into finet.report_definitions")).toBeLessThan(
      code.indexOf("alter table finet.report_definitions enable row level security"),
    );
  });

  it("0019_ask_finet_task: doar înlocuirea constrângerilor `ai_calls_task_valid` (+ `ask_finet`) și `consents_kind_valid` (+ `external_ai_ask`), fără alte efecte", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0019_ask_finet_task")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    expect(m.statements).toHaveLength(4);
    // Nicio altă comandă: fără tabele noi, coloane, politici, funcții, date sau drepturi.
    expect(code).not.toMatch(
      /create\s|insert\s|update\s|delete\s|truncate|grant\s|revoke\s|policy/i,
    );
    expect(code).toMatch(/ALTER TABLE "finet"\."ai_calls" DROP CONSTRAINT "ai_calls_task_valid"/);
    expect(code).toMatch(/ADD CONSTRAINT "ai_calls_task_valid" CHECK/);
    expect(code).toMatch(/ALTER TABLE "finet"\."consents" DROP CONSTRAINT "consents_kind_valid"/);
    expect(code).toMatch(/ADD CONSTRAINT "consents_kind_valid" CHECK/);
    for (const kind of [
      "external_ai",
      "external_ai_statements",
      "usage_stats",
      "external_ai_ask",
    ]) {
      expect(code).toContain(`'${kind}'`);
    }
    // Valorile vechi rămân, se adaugă exact `ask_finet`; CHECK plat (fără BETWEEN, fără AND imbricat).
    for (const task of [
      "receipt_extract",
      "categorize",
      "statement_extract",
      "list_match",
      "monthly_summary",
      "ask_finet",
    ]) {
      expect(code).toContain(`'${task}'`);
    }
    expect(code).not.toMatch(/\bbetween\b/i);
    expect(code).not.toMatch(
      /\bdrop\b(?![^;]*CONSTRAINT "(ai_calls_task_valid|consents_kind_valid)")/i,
    );
  });

  it("0021_purge_unverified: doar o funcție SECURITY DEFINER de citire, cu search_path fix și drepturi doar pentru finet_app", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0021_purge_unverified")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    expect(code).toMatch(
      /create function finet\.stale_unverified_users\(p_days integer, p_limit integer\)[^$]*?security definer\s+set search_path = pg_catalog/,
    );
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    // Fără scrieri și fără alte obiecte.
    expect(code).not.toMatch(/\b(insert|update|delete|truncate|drop|alter)\b/i);
    expect(code).toContain(
      "revoke all on function finet.stale_unverified_users(integer, integer) from public",
    );
    expect(code).toContain(
      "grant execute on function finet.stale_unverified_users(integer, integer) to finet_app",
    );
  });

  it("0026_feedback_reward: RLS ENABLE + FORCE, finet_app doar SELECT, o funcție SECURITY DEFINER doar pentru administrator, fără valori inventate", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0026_feedback_reward")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    expect(code).toContain("alter table finet.feedback_rewards enable row level security");
    expect(code).toContain("alter table finet.feedback_rewards force row level security");
    expect(code).toContain("revoke all on finet.feedback_rewards from public");
    expect(code).toContain("grant select on finet.feedback_rewards to finet_app");
    expect(code).not.toMatch(
      /grant[^;]*\b(insert|update|delete|truncate|all)\b[^;]*on finet\.feedback_rewards/i,
    );
    expect([...code.matchAll(/security\s+definer\s+set search_path = pg_catalog/gi)]).toHaveLength(
      1,
    );
    expect(code).toMatch(
      /if not finet\.is_platform_admin\(\) then\s+raise exception[^;]*errcode = '42501'/,
    );
    expect(code).toContain("revoke all on function finet.admin_reward_feedback(uuid) from public");
    expect(code).toContain(
      "grant execute on function finet.admin_reward_feedback(uuid) to finet_app",
    );
    // Politica pentru proprietar nu dă nimic aplicației.
    expect(code).toContain("create policy feedback_migrator_select on finet.feedback");
    // Nicio valoare de recompensă inserată sau modificată de migrație.
    expect(code).not.toMatch(
      /\b(insert\s+into\s+finet\.referral_settings|update\s+finet\.referral_settings)/i,
    );
    expect(code).toMatch(/default 0/i);
  });

  it("0025_referrals: RLS ENABLE + FORCE, finet_app doar SELECT pe codes/referrals și nimic pe settings, funcții SECURITY DEFINER cu search_path fix, grant_reward fără drept pentru aplicație, recompense oprite implicit", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0025_referrals")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    for (const table of ["referral_settings", "referral_codes", "referrals"]) {
      expect(code).toContain(`alter table finet.${table} enable row level security`);
      expect(code).toContain(`alter table finet.${table} force row level security`);
      expect(code).toContain(`revoke all on finet.${table} from public`);
    }
    expect(code).toContain("grant select on finet.referral_codes to finet_app");
    expect(code).toContain("grant select on finet.referrals to finet_app");
    expect(code).not.toMatch(/grant[^;]*on finet\.referral_settings/i);
    expect(code).not.toMatch(
      /grant[^;]*\b(insert|update|delete|truncate|all)\b[^;]*on finet\.(referral_codes|referrals)/i,
    );
    // household_plan (redefinită), grant_reward, my_referral_code, redeem_referral.
    expect([...code.matchAll(/security\s+definer\s+set search_path = pg_catalog/gi)]).toHaveLength(
      4,
    );
    expect(code).toContain("revoke all on function finet.grant_reward(uuid, integer) from public");
    expect(code).not.toMatch(/grant execute on function finet\.grant_reward/i);
    expect(code).toContain("grant execute on function finet.my_referral_code() to finet_app");
    expect(code).toContain("grant execute on function finet.redeem_referral(text) to finet_app");
    // Singurul rând inserat de migrație: setările goale (recompense oprite).
    expect(code).toContain("insert into finet.referral_settings (id) values (true)");
  });

  it("0024_queue_priority: doar redefinește queued_documents (SECURITY DEFINER, search_path fix, drepturi neschimbate), fără scrieri și fără obiecte noi", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0024_queue_priority")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    expect(code).toMatch(
      /create or replace function finet\.queued_documents\(p_limit integer, p_stale_seconds integer\)[^$]*?security definer\s+set search_path = pg_catalog/,
    );
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    expect(code).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create table)\b/i);
    expect(code).toContain("finet.household_plan(q.household_id)");
    // Echitatea din 0010 rămâne prima în ordonare; prioritatea doar departajează în același rând.
    expect(code).toContain("order by q.rn, p.prio desc, q.created_at, q.id");
    expect(code).toContain(
      "revoke all on function finet.queued_documents(integer, integer) from public",
    );
    expect(code).toContain(
      "grant execute on function finet.queued_documents(integer, integer) to finet_app",
    );
  });

  it("0023_plans_subscriptions: RLS ENABLE + FORCE, finet_app doar SELECT, o singură funcție SECURITY DEFINER de citire, fără planuri inserate", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0023_plans_subscriptions")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    for (const table of ["plans", "subscriptions"]) {
      expect(code).toContain(`alter table finet.${table} enable row level security`);
      expect(code).toContain(`alter table finet.${table} force row level security`);
      expect(code).toContain(`grant select on finet.${table} to finet_app`);
      expect(code).toContain(`revoke all on finet.${table} from public`);
    }
    // Aplicația nu scrie niciodată planurile sau abonamentele.
    expect(code).not.toMatch(
      /grant[^;]*\b(insert|update|delete|truncate|all)\b[^;]*on finet\.(plans|subscriptions)/i,
    );
    expect(code).not.toMatch(/\binsert\s+into\b/i);
    expect(code).toMatch(
      /create function finet\.household_plan\(p_household uuid\)[^$]*?security definer\s+set search_path = pg_catalog/,
    );
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    expect(code).toContain("revoke all on function finet.household_plan(uuid) from public");
    expect(code).toContain("grant execute on function finet.household_plan(uuid) to finet_app");
    // Scrierea o face doar operatorul, prin politici explicite pe finet_migrator.
    expect(code).toContain("create policy plans_operator on finet.plans");
    expect(code).toContain("create policy subscriptions_operator on finet.subscriptions");
  });

  it("0022_admin_guard: înlocuiește doar admin_set_user_status, păstrând SECURITY DEFINER, search_path fix și drepturile", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0022_admin_guard")!;
    const code = m.statements.join("\n").replace(/--.*$/gm, "");
    expect(code).toMatch(
      /create or replace function finet\.admin_set_user_status\(p_user uuid, p_status text\)[^$]*?security definer\s+set search_path = pg_catalog/,
    );
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    expect(code).toContain("finet.is_platform_admin()");
    expect(code).toContain("u.is_platform_admin");
    // Garda nu depinde de sensul schimbării (nici dezactivare, nici reactivare).
    expect(code).not.toMatch(/p_status = 'disabled' and exists/);
    expect(code).not.toMatch(/\b(delete|truncate|drop|alter)\b/i);
    expect(code).toContain(
      "revoke all on function finet.admin_set_user_status(uuid, text) from public",
    );
    expect(code).toContain(
      "grant execute on function finet.admin_set_user_status(uuid, text) to finet_app",
    );
  });

  it("0020_admin_feedback: 3 tabele noi cu RLS ENABLE + FORCE; funcții SECURITY DEFINER doar cu identificatori; CHECK-uri plate; drepturi pe coloane", () => {
    const m = readMigrations(MIGRATIONS_DIR).find((x) => x.tag === "0020_admin_feedback")!;
    const text = m.statements.join("\n");
    const created = [...text.matchAll(/CREATE TABLE "finet"\."(\w+)"/g)].map((x) => x[1]!);
    expect(created.sort()).toEqual(["announcements", "app_errors", "feedback"]);
    for (const table of created) {
      expect(text).toContain(`alter table finet.${table} enable row level security`);
      expect(text).toContain(`alter table finet.${table} force row level security`);
    }
    const code = text.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bbetween\b/i);
    expect(code).not.toMatch(/\btruncate\b|alter policy/i);
    // Nicio modificare a tabelelor existente (în afară de cheile străine ale celor noi).
    const altered = [...code.matchAll(/alter table "?finet"?\."?(\w+)"?/gi)].map((x) => x[1]!);
    expect(new Set(altered.filter((t) => !created.includes(t)))).toEqual(new Set());
    // Funcțiile SECURITY DEFINER: exact acestea, toate cu `search_path = pg_catalog`.
    const definers = [
      ...code.matchAll(
        /create function finet\.(\w+)\([^)]*\)[^$]*?security definer\s+set search_path = pg_catalog/g,
      ),
    ].map((x) => x[1]);
    expect(definers.sort()).toEqual([
      "admin_households",
      "admin_jobs",
      "admin_set_user_status",
      "admin_users",
      "is_platform_admin",
      "record_app_error",
    ]);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(6);
    // Fiecare funcție de administrare verifică administratorul.
    for (const fn of ["admin_users", "admin_households", "admin_jobs", "admin_set_user_status"]) {
      const body = code
        .slice(code.indexOf(`create function finet.${fn}(`))
        .split("--> statement-breakpoint")[0]!;
      expect(body, fn).toContain("finet.is_platform_admin()");
    }
    // Feedback: INSERT cu politica `status = 'new'`, UPDATE doar `status`.
    expect(code).toContain(
      "with check (user_id = (select finet.current_user_id()) and status = 'new')",
    );
    expect(code).toContain("grant update (status, updated_at) on finet.feedback to finet_app");
    expect(code).not.toMatch(/grant[^;]*\bupdate\b(?!\s*\()[^;]*on finet\./i);
    // app_errors: scris doar de funcție (politicile finet_migrator, cu variabila de domeniu).
    expect(code).not.toMatch(/grant[^;]*(insert|update|delete)[^;]*on finet\.app_errors/i);
    expect(code).toContain("finet.definer_scope', true) = 'app_error'");
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
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
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
        "aplicată: 0016_gdpr_stats",
        "aplicată: 0013_statements",
        "aplicată: 0014_statement_uploads",
        "aplicată: 0017_shopping_lists",
        "aplicată: 0018_report_definitions",
        "aplicată: 0019_ask_finet_task",
        "aplicată: 0020_admin_feedback",
        "aplicată: 0021_purge_unverified",
        "aplicată: 0022_admin_guard",
        "aplicată: 0023_plans_subscriptions",
        "aplicată: 0024_queue_priority",
        "aplicată: 0025_referrals",
        "aplicată: 0026_feedback_reward",
      ]);
      const second = await runMigrations(sql, { folder: MIGRATIONS_DIR });
      expect(second).toEqual({ applied: [], alreadyApplied: 26 });
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
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 4,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
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
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
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
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 6,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
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
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 8,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
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
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 9,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
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
        applied: [
          "0011_document_retention",
          "0012_family",
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 11,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
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
        applied: [
          "0012_family",
          "0016_gdpr_stats",
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 12,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
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

  it("0013 + 0014 peste o bază cu 0000–0012 + 0016 aplicate și date (producția după Faza 9): aplicate după 0016, schema identică cu cea de la zero, apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig13");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 14);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(14);
      const U1 = "00000000-0000-4000-8000-000000000001";
      const H = "00000000-0000-4000-8000-0000000000a1";
      const A = "00000000-0000-4000-8000-0000000000c1";
      await fresh.admin.unsafe(`
        insert into finet.users (id, email, name) values ('${U1}', 'u1@exemplu.ro', 'U1');
        insert into finet.households (id, name, created_by) values ('${H}', 'H', '${U1}');
        insert into finet.household_members (household_id, user_id, role) values ('${H}', '${U1}', 'owner');
        insert into finet.accounts (id, household_id, name, type, currency) values ('${A}', '${H}', 'Banca', 'bank', 'RON');
        insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on, external_ref)
          values ('${H}', '${A}', 'expense', 100, 'RON', '2026-10-01', 'manual-1');`);
      const before =
        await fresh.admin`select md5(string_agg(t::text, '|' order by t::text)) as h from finet.transactions t`;
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [
          "0013_statements",
          "0014_statement_uploads",
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 14,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
      });
      const after =
        await fresh.admin`select md5(string_agg(t::text, '|' order by t::text)) as h from finet.transactions t`;
      expect(after[0]!.h).toBe(before[0]!.h);
      const [n] = await fresh.admin<{ n: number }[]>`
        select count(*)::int as n from finet.statement_imports`;
      expect(n!.n).toBe(0);
      // Baza obținută incremental = baza creată de la zero (tabele, coloane, constrângeri,
      // indecși, politici, funcții, triggere, ACL-uri), în ordinea jurnalului.
      const scratch = await createScratchDatabase("finet_it_mig13z");
      const zsql = testClient(scratch.migratorUrl, 1);
      try {
        await runMigrations(zsql, { folder: MIGRATIONS_DIR });
        expect(await schemaFingerprint(fresh.admin)).toEqual(
          await schemaFingerprint(scratch.admin),
        );
      } finally {
        await zsql.end({ timeout: 5 });
        await scratch.drop();
      }
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(dir, { recursive: true, force: true });
      await fresh.drop();
    }
  }, 60_000);

  it("0017–0020 peste o bază cu 0000–0014 + 0016 aplicate și date (producția după Faza 7): se aplică doar ele, datele rămân, schema identică cu cea de la zero, apoi nimic", async () => {
    const fresh = await createScratchDatabase("finet_it_mig18");
    const dir = copyMigrations();
    const sql = testClient(fresh.migratorUrl, 1);
    try {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      const full = JSON.stringify(journal);
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 16);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect((await runMigrations(sql, { folder: dir })).applied).toHaveLength(16);
      const U1 = "00000000-0000-4000-8000-000000000001";
      const H = "00000000-0000-4000-8000-0000000000a1";
      await fresh.admin.unsafe(`
        insert into finet.users (id, email, name) values ('${U1}', 'u1@exemplu.ro', 'U1');
        insert into finet.households (id, name, created_by) values ('${H}', 'H', '${U1}');
        insert into finet.household_members (household_id, user_id, role) values ('${H}', '${U1}', 'owner');`);
      const before =
        await fresh.admin`select md5(string_agg(t::text, '|' order by t::text)) as h from finet.households t`;
      writeFileSync(journalPath, full);
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [
          "0017_shopping_lists",
          "0018_report_definitions",
          "0019_ask_finet_task",
          "0020_admin_feedback",
          "0021_purge_unverified",
          "0022_admin_guard",
          "0023_plans_subscriptions",
          "0024_queue_priority",
          "0025_referrals",
          "0026_feedback_reward",
        ],
        alreadyApplied: 16,
      });
      expect(await runMigrations(sql, { folder: dir })).toEqual({
        applied: [],
        alreadyApplied: 26,
      });
      const after =
        await fresh.admin`select md5(string_agg(t::text, '|' order by t::text)) as h from finet.households t`;
      expect(after[0]!.h).toBe(before[0]!.h);
      const [n] = await fresh.admin<{ n: number }[]>`
        select count(*)::int as n from finet.report_definitions where is_system and household_id is null`;
      expect(n!.n).toBe(6);
      const scratch = await createScratchDatabase("finet_it_mig18z");
      const zsql = testClient(scratch.migratorUrl, 1);
      try {
        await runMigrations(zsql, { folder: MIGRATIONS_DIR });
        expect(await schemaFingerprint(fresh.admin)).toEqual(
          await schemaFingerprint(scratch.admin),
        );
      } finally {
        await zsql.end({ timeout: 5 });
        await scratch.drop();
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
    expect(counted?.n).toBe(26);
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
      "announcements",
      "app_downloads",
      "app_errors",
      "app_event_daily",
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
      "feedback",
      "feedback_rewards",
      "goals",
      "household_invites",
      "household_members",
      "households",
      "idempotency_keys",
      "plans",
      "processing_batches",
      "product_aliases",
      "receipt_lines",
      "receipt_match_rejections",
      "receipts",
      "recurring_occurrences",
      "recurring_rules",
      "recurring_suggestion_dismissals",
      "referral_codes",
      "referral_settings",
      "referrals",
      "report_definitions",
      "service_heartbeats",
      "settlements",
      "shopping_list_ai_requests",
      "shopping_list_items",
      "shopping_lists",
      "statement_imports",
      "statement_lines",
      "statement_uploads",
      "statement_usage_daily",
      "subscriptions",
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
      expect(counted?.n).toBe(26);
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
    expect(out).toEqual(["finet-migrate: gata; aplicate acum 0, deja aplicate 26"]);
    expect(out.join("\n")).not.toContain("finet_migrator_ci");
  });
});
