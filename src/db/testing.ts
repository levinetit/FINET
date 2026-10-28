import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

/**
 * Doar pentru testele de integrare (Vitest): o bază de date nouă, creată de la zero pe
 * PostgreSQL-ul de test din `DATABASE_URL` (superuser, de exemplu serviciul Postgres din CI),
 * cu rolurile din `ops/postgres/test-bootstrap.sql`. Testele se conectează apoi cu rolurile reale
 * `finet_migrator` și `finet_app` (nu ca superuser), altfel RLS nu ar fi testat.
 * Nu se importă din codul aplicației.
 */

export const TEST_ADMIN_URL = process.env.DATABASE_URL || null;

export const MIGRATIONS_DIR = join(process.cwd(), "src/db/migrations");
const BOOTSTRAP_SQL = join(process.cwd(), "ops/postgres/test-bootstrap.sql");

/** Parolele fictive din test-bootstrap.sql (doar containerul de test). */
const TEST_PASSWORDS = { finet_migrator: "finet_migrator_ci", finet_app: "finet_app_ci" } as const;

export type ScratchDatabase = Readonly<{
  name: string;
  adminUrl: string;
  migratorUrl: string;
  appUrl: string;
  /** Un client ca superuser, conectat la baza nouă (pentru verificări din catalog). */
  admin: postgres.Sql;
  drop: () => Promise<void>;
}>;

function withCredentials(base: string, database: string, user?: keyof typeof TEST_PASSWORDS) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = TEST_PASSWORDS[user];
  }
  return url.toString();
}

const quiet = { onnotice: () => {}, max: 1, prepare: false } as const;

/** Creează o bază nouă, cu schema `finet` și rolurile de test. */
export async function createScratchDatabase(prefix: string): Promise<ScratchDatabase> {
  if (!TEST_ADMIN_URL) throw new Error("DATABASE_URL lipsește (testele DB ar trebui sărite)");
  const name = `${prefix}_${randomBytes(4).toString("hex")}`;
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) throw new Error("nume de bază invalid");

  const server = postgres(TEST_ADMIN_URL, quiet);
  try {
    await server.unsafe(`create database "${name}"`);
  } finally {
    await server.end({ timeout: 5 });
  }

  const adminUrl = withCredentials(TEST_ADMIN_URL, name);
  const admin = postgres(adminUrl, quiet);
  await admin.unsafe(readFileSync(BOOTSTRAP_SQL, "utf8"));

  return {
    name,
    adminUrl,
    migratorUrl: withCredentials(TEST_ADMIN_URL, name, "finet_migrator"),
    appUrl: withCredentials(TEST_ADMIN_URL, name, "finet_app"),
    admin,
    drop: async () => {
      await admin.end({ timeout: 5 });
      const s = postgres(TEST_ADMIN_URL, quiet);
      try {
        await s.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  };
}

/** Un client postgres.js pentru un URL de test (un singur pool mic, fără notificări). */
export function testClient(url: string, max = 2): postgres.Sql {
  return postgres(url, { ...quiet, max });
}
