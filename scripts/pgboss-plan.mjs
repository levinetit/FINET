// Construiește migrația `src/db/migrations/0007_pgboss.sql` din planul de construcție al pg-boss
// (`getConstructionPlans`), pentru versiunea pg-boss fixată în package.json (ADR 0011).
//
// De ce nu direct planul: el conține `BEGIN; … COMMIT;` și `SET LOCAL lock_timeout`, iar runner-ul
// FINET (src/db/migrate.ts) rulează TOATE migrațiile în așteptare într-o singură tranzacție, cu
// propriul lock consultativ; un COMMIT din plan ar închide tranzacția runner-ului (fără atomicitate
// și fără lock), iar `lock_timeout` s-ar scurge în restul tranzacției. De asemenea postgres.js
// trimite fiecare instrucțiune separat (protocolul extins nu acceptă mai multe comenzi într-un
// mesaj), deci instrucțiunile se despart cu `--> statement-breakpoint`, fără a tăia corpurile
// funcțiilor (`$$ … $$`, `$cmd$ … $cmd$`) sau șirurile.
//
// Schema `pgboss` NU e creată aici (`createSchema: false`): `finet_migrator` nu are CREATE pe bază;
// o creează operatorul (ops/supabase/pgboss-schema.sql), deținută de `finet_migrator`.
//
// Utilizare: `node scripts/pgboss-plan.mjs` scrie fișierul; `--check` doar verifică (CI, test).
// Migrația e imutabilă după aplicare: o versiune nouă a pg-boss cere o migrație NOUĂ (planul de
// migrare `getMigrationPlans`), nu regenerarea acesteia (testul pică dacă versiunea diferă).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { getConstructionPlans } from "pg-boss";

export const PGBOSS_SCHEMA = "pgboss";
export const MIGRATION_PATH = fileURLToPath(
  new URL("../src/db/migrations/0007_pgboss.sql", import.meta.url),
);
const BREAKPOINT = "--> statement-breakpoint";

/** Versiunea schemei pg-boss așteptată de pachetul instalat (`dist/schema.json`). */
export function installedSchemaVersion() {
  const require = createRequire(import.meta.url);
  return require("pg-boss/dist/schema.json").version;
}

/**
 * Împarte un text SQL în instrucțiuni, la `;` din afara șirurilor (`'…'`), a identificatorilor
 * (`"…"`), a comentariilor și a blocurilor dollar-quoted (`$tag$ … $tag$`).
 */
export function splitSql(text) {
  const out = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) throw new Error("splitSql: șir neînchis");
      i = end + 1;
      continue;
    }
    if (c === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        if (end < 0) throw new Error("splitSql: bloc dollar-quoted neînchis");
        i = end + m[0].length;
        continue;
      }
    }
    if (c === ";") {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s !== "");
}

/** Instrucțiunile tranzacției proprii a planului, eliminate (le înlocuiește runner-ul). */
const DROPPED = [/^BEGIN$/i, /^COMMIT$/i, /^SET LOCAL /i];

/** Instrucțiunile planului pg-boss, fără BEGIN/COMMIT/SET LOCAL, cu indentarea normalizată. */
export function pgBossStatements() {
  const plan = getConstructionPlans(PGBOSS_SCHEMA, { createSchema: false });
  return splitSql(plan)
    .filter((s) => !DROPPED.some((re) => re.test(s)))
    .map((s) => {
      const lines = s.split("\n");
      const indents = lines
        .slice(1)
        .filter((l) => l.trim() !== "")
        .map((l) => /^ */.exec(l)[0].length);
      const cut = indents.length ? Math.min(...indents) : 0;
      return [lines[0].trim(), ...lines.slice(1).map((l) => l.slice(Math.min(cut, 4)))]
        .join("\n")
        .trimEnd();
    });
}

const HEADER = (
  version,
) => `-- FINET 0007_pgboss (Faza 5, F5-A): schema cozii pg-boss (versiunea de schemă ${version}), pentru
-- workerul FINET (ADR 0011). GENERATĂ de \`node scripts/pgboss-plan.mjs\` din planul de construcție
-- al pg-boss (\`getConstructionPlans('pgboss', { createSchema: false })\`), fără \`BEGIN\`/\`COMMIT\`/
-- \`SET LOCAL\` (runner-ul rulează totul într-o tranzacție, cu lock-ul lui), urmată de drepturile
-- minime ale lui \`finet_app\` (rolul workerului), scrise în script.
-- NU modifica fișierul după aplicare: runner-ul compară hash-ul. O versiune nouă a pg-boss cere o
-- migrație NOUĂ (getMigrationPlans); testul scripts/pgboss-plan.test.ts pică dacă versiunea
-- pachetului nu mai corespunde acestei scheme.
--
-- Precondiție (operatorul, o singură dată, ÎNAINTEA migrației): schema \`pgboss\` deținută de
-- \`finet_migrator\` (ops/supabase/pgboss-schema.sql); \`finet_migrator\` nu are CREATE pe bază.
--
-- Workerul pornește cu \`migrate: false\`, \`createSchema: false\`, \`reindex: false\`,
-- \`persistQueueStats: false\`, \`persistWarnings: false\` și cozi nepartiționate: la rulare face
-- doar DML (fără DDL, fără proprietatea obiectelor). Tabelele pg-boss nu au RLS: nu conțin date
-- financiare (doar id-uri de gospodărie/utilizator în joburile la cerere); schema nu e expusă prin
-- Data API, iar \`anon\`/\`authenticated\`/PUBLIC nu primesc nimic.
--
-- Rollback (manual, de operator; workerul oprit): drop schema pgboss cascade; apoi
--   create schema pgboss authorization finet_migrator (dacă se reaplică);
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0007_pgboss>';`;

const GUARD = `do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_namespace n
     where n.nspname = 'pgboss' and n.nspowner = (select oid from pg_catalog.pg_roles where rolname = 'finet_migrator')
  ) then
    raise exception 'lipsește schema pgboss deținută de finet_migrator: rulează întâi ops/supabase/pgboss-schema.sql'
      using errcode = '3F000';
  end if;
end
$$`;

/**
 * Drepturile lui finet_app (workerul) pe schema pgboss: DML pe tabelele cozii, nimic pe `version`
 * în afara coloanelor de timp ale monitoarelor, doar citire pe `bam` (comenzile din `bam` se
 * EXECUTĂ de pg-boss: workerul nu le poate scrie) și pe `queue_stats`. Funcțiile: EXECUTE doar pe
 * cele folosite la rulare (`job_now`, `create_queue`). Rezultatul verificat de grants.test.ts.
 */
const GRANTS = [
  "revoke all on schema pgboss from public",
  `do $$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on schema pgboss from anon';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema pgboss from authenticated';
  end if;
end
$$`,
  "revoke all on all tables in schema pgboss from public",
  "revoke all on all functions in schema pgboss from public",
  "grant usage on schema pgboss to finet_app",
  "grant select, insert, update, delete on pgboss.job, pgboss.job_common, pgboss.queue, pgboss.schedule, pgboss.subscription, pgboss.job_dependency, pgboss.instance to finet_app",
  "grant select on pgboss.version, pgboss.bam, pgboss.warning, pgboss.queue_stats to finet_app",
  "grant update (cron_on, bam_on, flow_on, reindex_on, monitor_backoff_on) on pgboss.version to finet_app",
  "grant execute on function pgboss.job_now(), pgboss.create_queue(text, jsonb) to finet_app",
];

export function buildPgBossMigration() {
  const version = installedSchemaVersion();
  const body = [GUARD, ...pgBossStatements(), ...GRANTS].map((s) => `${s};`);
  return `${HEADER(version)}\n${body.join(`\n${BREAKPOINT}\n`)}\n`;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const text = buildPgBossMigration();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(MIGRATION_PATH, "utf8");
    } catch {
      current = "";
    }
    if (current !== text) {
      console.error("pgboss-plan: 0007_pgboss.sql nu corespunde pg-boss instalat");
      process.exit(1);
    }
    console.log("pgboss-plan: ok");
  } else {
    writeFileSync(MIGRATION_PATH, text);
    console.log(`pgboss-plan: scris ${MIGRATION_PATH}`);
  }
}
