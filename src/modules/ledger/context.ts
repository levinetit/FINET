import "server-only";

import { type DbOrTx, type Tx } from "@/db";
import { pgErrorInfo } from "@/db/pg-errors";
import { type Actor, type Membership, NotFoundError, withMember } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";

/**
 * Cadrul comun al serviciilor registrului: verificarea apartenenței și accesul la date în
 * ACEEAȘI tranzacție, cu contextul RLS al gospodăriei (`withMember`), plus traducerea erorilor
 * Postgres care scapă validării din serviciu (curse între cereri, apărarea din bază) în erori de
 * domeniu. Orice gospodărie străină sau inexistentă dă `NotFoundError` (404 uniform).
 *
 * `householdId` vine din sesiune sau din ruta validată, niciodată din body (6.2).
 */

/** `db` poate fi și o tranzacție deschisă (API-ul cu `Idempotency-Key`, ADR 0005). */
export type LedgerDeps = Readonly<{ db: DbOrTx }>;

/** Numele constrângerilor unice → motivul conflictului. */
const UNIQUE_REASONS: Readonly<Record<string, string>> = {
  accounts_household_name_active_key: "account_name_taken",
  categories_household_parent_name_key: "category_name_taken",
  transactions_household_external_ref_key: "external_ref_taken",
};

export function translateDbError(error: unknown): never {
  if (
    error instanceof NotFoundError ||
    error instanceof ConflictError ||
    error instanceof ValidationError
  ) {
    throw error;
  }
  const info = pgErrorInfo(error);
  switch (info?.code) {
    case "23505":
      throw new ConflictError(UNIQUE_REASONS[info.constraint ?? ""] ?? "duplicate");
    case "23503":
      // O referință (cont, categorie) inexistentă sau invizibilă sub RLS; ori un rând încă
      // folosit (ștergere): ambele sunt conflicte de stare, nu erori interne.
      throw new ConflictError("reference_conflict");
    case "23514":
      throw new ConflictError("integrity_check_failed");
    case "42501":
      // RLS a refuzat scrierea (de exemplu `household_id` străin): același răspuns ca 404.
      throw new NotFoundError();
    default:
      throw error;
  }
}

/** Rulează `fn` ca membru al gospodăriei (rol minim `member`), cu erorile traduse. */
export async function inHousehold<T>(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  fn: (tx: Tx, membership: Membership) => Promise<T>,
): Promise<T> {
  try {
    return await withMember(actor, householdId, "member", fn, { db: deps.db });
  } catch (error) {
    return translateDbError(error);
  }
}
