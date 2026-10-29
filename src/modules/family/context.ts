import "server-only";

import type { Db, DbOrTx, Tx } from "@/db";
import { type Actor, type HouseholdRole, type Membership, withMember } from "@/lib/authz";
import type { RateLimitRule } from "@/lib/config";
import { translateDbError } from "@/modules/ledger/context";

/**
 * Cadrul serviciilor familiei (Faza 8): ca `inHousehold` din registru (apartenența verificată ÎN
 * BAZĂ și accesul la date în aceeași tranzacție, cu contextul RLS), dar cu rolul minim cerut
 * (`owner` pentru invitații, roluri, eliminări) și cu erorile Postgres traduse în erori de
 * domeniu cu cod fix (`last_owner`, `household_full`, `split_sum_mismatch`, ...).
 */

export type FamilyDeps = Readonly<{
  db: DbOrTx;
  /** Ceasul (testele îl fixează). */
  now?: () => Date;
}>;

/** Acceptarea are nevoie de un client (nu de o tranzacție): limita de rată e în afara ei. */
export type AcceptDeps = Readonly<{
  db: Db;
  now?: () => Date;
  /** Limita încercărilor de acceptare per utilizator (implicit 10 / 15 min). */
  acceptLimit?: RateLimitRule;
}>;

export const nowOf = (deps: { now?: () => Date }): Date => (deps.now ? deps.now() : new Date());

export async function inFamily<T>(
  deps: FamilyDeps,
  actor: Actor,
  householdId: string,
  minRole: HouseholdRole,
  fn: (tx: Tx, membership: Membership) => Promise<T>,
): Promise<T> {
  try {
    return await withMember(actor, householdId, minRole, fn, { db: deps.db });
  } catch (error) {
    return translateDbError(error);
  }
}
