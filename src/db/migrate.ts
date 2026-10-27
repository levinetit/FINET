import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type postgres from "postgres";
import { z } from "zod";

/**
 * Runner-ul de migrații FINET (rolul `migrate`, ca `finet_migrator`). Aplică migrațiile SQL din
 * `src/db/migrations/` (generate de drizzle-kit sau scrise de mână), în ordinea jurnalului
 * `meta/_journal.json`.
 *
 * De ce nu `migrate()` din drizzle-orm: acela rulează întâi `CREATE SCHEMA IF NOT EXISTS`, care
 * cere dreptul CREATE pe bază chiar dacă schema există (verificat pe PostgreSQL 17), iar
 * `finet_migrator` nu îl are (ops/supabase/roles.sql). Formatul tabelului de evidență e același
 * cu al drizzle (`id serial, hash text, created_at bigint` = `when` din jurnal), în schema
 * `finet`: `finet.__drizzle_migrations`.
 *
 * Garanții:
 * - idempotent: o migrație deja aplicată (după `created_at`) nu se mai rulează;
 * - o migrație aplicată al cărei fișier s-a schimbat (alt hash) oprește rularea, la fel o
 *   migrație din bază care lipsește din jurnal (baza e mai nouă decât codul);
 * - toate migrațiile în așteptare rulează într-o singură tranzacție (totul sau nimic);
 * - un lock consultativ (`pg_advisory_xact_lock`) serializează două rulări simultane;
 * - mesajele nu conțin URL-ul, parola sau SQL-ul migrațiilor.
 */

export const MIGRATIONS_SCHEMA = "finet";
export const MIGRATIONS_TABLE = "__drizzle_migrations";
/** Cheia lock-ului consultativ (constantă arbitrară, doar pentru migrațiile FINET). */
export const MIGRATIONS_LOCK_KEY = 4_602_011;

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export type MigrationFile = Readonly<{
  tag: string;
  /** `when` din jurnal (ms); identitatea migrației în tabelul de evidență. */
  createdAt: number;
  /** sha256 al fișierului întreg (același calcul ca drizzle-orm). */
  hash: string;
  statements: readonly string[];
}>;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const journalSchema = z.object({
  dialect: z.literal("postgresql"),
  entries: z
    .array(
      z.object({
        idx: z.number().int().nonnegative(),
        when: z.number().int().positive(),
        tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
        breakpoints: z.boolean(),
      }),
    )
    .min(1),
});

/** Citește jurnalul și fișierele SQL. Aruncă `MigrationError` la orice inconsecvență. */
export function readMigrations(folder: string): MigrationFile[] {
  let journalText: string;
  try {
    journalText = readFileSync(join(folder, "meta", "_journal.json"), "utf8");
  } catch {
    throw new MigrationError("lipsește meta/_journal.json în directorul migrațiilor");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(journalText);
  } catch {
    throw new MigrationError("meta/_journal.json nu e JSON valid");
  }
  const journal = journalSchema.safeParse(parsedJson);
  if (!journal.success) throw new MigrationError("meta/_journal.json are un format neașteptat");

  const out: MigrationFile[] = [];
  let previous = 0;
  for (const [i, entry] of journal.data.entries.entries()) {
    if (entry.idx !== i) throw new MigrationError(`jurnal: idx ${entry.idx} în afara ordinii`);
    if (entry.when <= previous) {
      throw new MigrationError(`jurnal: ${entry.tag} nu e mai nouă decât migrația anterioară`);
    }
    previous = entry.when;
    let text: string;
    try {
      text = readFileSync(join(folder, `${entry.tag}.sql`), "utf8");
    } catch {
      throw new MigrationError(`lipsește fișierul ${entry.tag}.sql`);
    }
    const statements = text
      .split(STATEMENT_BREAKPOINT)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (statements.length === 0) throw new MigrationError(`${entry.tag}.sql e gol`);
    out.push({
      tag: entry.tag,
      createdAt: entry.when,
      hash: createHash("sha256").update(text).digest("hex"),
      statements,
    });
  }
  return out;
}

export type MigrateResult = Readonly<{
  /** Tag-urile aplicate acum, în ordine. */
  applied: readonly string[];
  /** Câte erau deja aplicate. */
  alreadyApplied: number;
}>;

type AppliedRow = { hash: string; created_at: string };

/**
 * Aplică migrațiile în așteptare. `sql` trebuie să fie o conexiune în modul sesiune (conexiune
 * directă sau pooler-ul pe 5432), cu rolul `finet_migrator`.
 */
export async function runMigrations(
  sql: postgres.Sql,
  options: Readonly<{ folder: string; log?: (line: string) => void }>,
): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const migrations = readMigrations(options.folder);
  const table = sql(`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`);

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATIONS_LOCK_KEY})`;
    // Tabelul de evidență, în schema `finet` (deținută de migrator; nu cere CREATE pe bază).
    await tx`
      create table if not exists ${table} (
        id serial primary key,
        hash text not null,
        created_at bigint
      )`;
    const rows = await tx<AppliedRow[]>`select hash, created_at::text from ${table}`;
    const appliedByTime = new Map(rows.map((r) => [Number(r.created_at), r.hash]));
    const known = new Set(migrations.map((m) => m.createdAt));
    for (const time of appliedByTime.keys()) {
      if (!known.has(time)) {
        throw new MigrationError(
          `baza are o migrație aplicată (created_at=${time}) care lipsește din jurnal; codul e mai vechi decât baza`,
        );
      }
    }

    const newestApplied = Math.max(0, ...appliedByTime.keys());
    const applied: string[] = [];
    let alreadyApplied = 0;
    for (const migration of migrations) {
      const existing = appliedByTime.get(migration.createdAt);
      if (existing !== undefined) {
        if (existing !== migration.hash) {
          throw new MigrationError(
            `${migration.tag} a fost modificată după aplicare (hash diferit); scrie o migrație nouă`,
          );
        }
        alreadyApplied += 1;
        continue;
      }
      if (migration.createdAt < newestApplied) {
        // O migrație nouă înaintea uneia deja aplicate (jurnal reordonat): refuz.
        throw new MigrationError(`${migration.tag} e anterioară unor migrații deja aplicate`);
      }
      for (const statement of migration.statements) {
        await tx.unsafe(statement);
      }
      await tx`insert into ${table} (hash, created_at) values (${migration.hash}, ${migration.createdAt})`;
      applied.push(migration.tag);
      log(`aplicată: ${migration.tag}`);
    }
    return { applied, alreadyApplied };
  });
}
