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
  tags_household_name_key: "tag_name_taken",
  budgets_active_key: "budget_exists",
  // Faza 6: aceeași cheie de bon (CUI + număr + dată + total) există deja în gospodărie.
  receipts_household_dedup_key: "duplicate_receipt",
  // Faza 10 (0017): o linie de bon propusă/confirmată pentru cel mult UN articol al listei.
  shopping_list_items_line_key: "line_already_matched",
};

/**
 * Numele constrângerilor ridicate de triggerele scrise de mână (`RAISE ... CONSTRAINT = ...`,
 * 0012_family) → motivul conflictului. Fără mesajul Postgres (poate conține valori).
 */
const CHECK_REASONS: Readonly<Record<string, string>> = {
  transaction_splits_sum: "split_sum_mismatch",
  household_members_last_owner: "last_owner",
  accounts_owner_change: "account_owner_change",
  household_invites_final: "invite_not_active",
  settlements_cancel_once: "settlement_already_cancelled",
  // Faza 10 (0017): o listă comună nu devine personală.
  shopping_lists_owner_change: "list_owner_change",
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
      throw new ConflictError(CHECK_REASONS[info.constraint ?? ""] ?? "integrity_check_failed");
    case "54000":
      // Plafonul de membri ai gospodăriei (0012, triggerul household_members_check_cap).
      if (info.constraint === "household_members_cap") throw new ConflictError("household_full");
      // Plafoanele listelor de cumpărături (0017): cod fix, fără mesajul Postgres.
      if (info.constraint === "shopping_lists_cap") throw new ConflictError("shopping_list_limit");
      if (info.constraint === "shopping_list_items_cap") {
        throw new ConflictError("shopping_item_limit");
      }
      throw error;
    case "22021":
      // Caracter invalid în text (de exemplu NUL, `\u0000`, sau UTF-8 invalid): 400 cu mesaj fix,
      // fără parametrii interogării sau conținutul primit (mesajul Postgres le-ar cita).
      throw new ValidationError(
        { _: "Textul conține caractere nepermise." },
        "Textul conține caractere nepermise.",
      );
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
