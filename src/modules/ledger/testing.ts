import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import type postgres from "postgres";

import { type Db, withRlsOn } from "@/db";
import { createHousehold } from "@/db/households";
import { householdMembers } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";

import type { LedgerDeps } from "./context";

/**
 * Doar pentru testele de integrare ale registrului: o bază nouă (migrată), clientul aplicației ca
 * `finet_app` și trei utilizatori: A (owner în HA), C (member în HA) și B (owner în HB).
 * Nu se importă din codul aplicației.
 */

export type LedgerFixture = Readonly<{
  fx: AuthFixture;
  db: Db;
  deps: LedgerDeps;
  /** Superuser pe baza de test (doar verificări și scenarii forțate; ocolește RLS). */
  admin: postgres.Sql;
  A: Actor;
  B: Actor;
  C: Actor;
  HA: string;
  HB: string;
  close: () => Promise<void>;
}>;

export async function createLedgerFixture(prefix: string): Promise<LedgerFixture> {
  const fx = await createAuthFixture(prefix);
  const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
  for (const [key, id] of Object.entries(ids)) {
    await fx.db.execute(
      sql`insert into finet.users (id, email, name) values (${id}, ${`${key.toLowerCase()}@exemplu.ro`}, ${key})`,
    );
  }
  const HA = await withRlsOn(fx.db, { userId: ids.A }, (tx) =>
    createHousehold(tx, { name: "Casa A" }),
  );
  const HB = await withRlsOn(fx.db, { userId: ids.B }, (tx) =>
    createHousehold(tx, { name: "Casa B" }),
  );
  await withRlsOn(fx.db, { userId: ids.A, householdId: HA }, (tx) =>
    tx.insert(householdMembers).values({ householdId: HA, userId: ids.C, role: "member" }),
  );
  return {
    fx,
    db: fx.db,
    deps: { db: fx.db },
    admin: fx.scratch.admin,
    A: { userId: ids.A },
    B: { userId: ids.B },
    C: { userId: ids.C },
    HA,
    HB,
    close: fx.close,
  };
}

/** Codul SQLSTATE al erorii aruncate de `fn` (sau `null` dacă nu aruncă). */
export async function sqlState(fn: () => Promise<unknown>): Promise<string | null> {
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

/** Id-ul unei categorii de sistem după cheia stabilă. */
export async function systemCategoryId(admin: postgres.Sql, key: string): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    select id from finet.categories where system_key = ${key}`;
  if (!row) throw new Error(`categoria de sistem ${key} lipsește`);
  return row.id;
}
