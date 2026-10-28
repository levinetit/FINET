import "server-only";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type * as schema from "./schema";

/**
 * Contextul RLS per tranzacție (master prompt 6.2, stratul 2). Politicile din
 * `src/db/migrations/0001_rls.sql` citesc `app.user_id` și `app.household_id`; `withRlsOn`
 * deschide o tranzacție, le setează LOCAL (`set_config(..., true)`, echivalentul `SET LOCAL`,
 * compatibil cu pooler-ul Supabase în modul tranzacție) și rulează `fn(tx)`. La sfârșitul
 * tranzacției contextul dispare, deci o conexiune refolosită din pool nu îl moștenește.
 *
 * Valorile se trimit ca parametri (niciodată concatenate în SQL) și se validează ca uuid
 * înainte de orice query. `userId` vine din sesiunea verificată, iar `householdId` dintr-o
 * rută validată și verificat prin `requireMember` (src/lib/authz.ts) — niciodată direct din body.
 */

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type RlsContext = Readonly<{
  /** Utilizatorul autentificat; `null` doar pentru operații fără utilizator (nu vede nimic). */
  userId: string | null;
  /** Gospodăria curentă, dacă operația e în contextul unei gospodării. */
  householdId?: string | null;
}>;

/** Context RLS invalid (de exemplu un id care nu e uuid). Nu conține valoarea. */
export class RlsContextError extends Error {
  constructor(readonly field: "userId" | "householdId") {
    super(`context RLS invalid: ${field} nu e un uuid`);
    this.name = "RlsContextError";
  }
}

const uuidSchema = z.uuid();

/** `true` dacă valoarea e un uuid valid (forma canonică, orice versiune). */
export function isUuid(value: unknown): value is string {
  return uuidSchema.safeParse(value).success;
}

function checkId(value: string | null | undefined, field: "userId" | "householdId"): string {
  if (value === null || value === undefined) return "";
  if (!isUuid(value)) throw new RlsContextError(field);
  return value.toLowerCase();
}

/** Rulează `fn` într-o tranzacție cu contextul RLS dat, pe clientul `db`. */
export async function withRlsOn<T>(
  db: Db,
  context: RlsContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const userId = checkId(context.userId, "userId");
  const householdId = checkId(context.householdId, "householdId");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.user_id', ${userId}, true), set_config('app.household_id', ${householdId}, true)`,
    );
    return fn(tx);
  });
}
