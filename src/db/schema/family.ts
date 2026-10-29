import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet } from "./finet";
import { DB_CURRENCIES, households } from "./households";
import { transactions } from "./ledger";

/**
 * Faza 8 — familie (master prompt 6.1 „Familie”, Faza 8): invitațiile, împărțirea cheltuielilor
 * și decontările. Migrația: `src/db/migrations/0012_family.sql` (DDL-ul de aici, generat de
 * drizzle-kit, plus partea scrisă de mână: triggerele de integritate, verificarea amânată a sumei
 * părților, funcția `finet.accept_invite`, protecția ultimului owner, noile politici de
 * vizibilitate personal/comun, RLS și drepturile). Deciziile: ADR 0016.
 *
 * CHECK-urile sunt comparații PLATE (fără BETWEEN într-un lanț AND), ca amprenta pg_dump să
 * rămână stabilă (lecția Fazelor 3–6).
 */

const minor = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Rolurile pe care le poate da o invitație (aceleași ca `HOUSEHOLD_ROLES`). */
export const INVITE_ROLES = ["member", "owner"] as const;

/**
 * Invitațiile într-o gospodărie (`/join/[token]`). Tokenul în clar NU se stochează: doar
 * SHA-256 (hex). De unică folosință (`used_at`), expirabilă (`expires_at`, cel mult 7 zile),
 * revocabilă (`revoked_at`). Fără DELETE pentru aplicație: rândurile rămân ca istoric și ca
 * contor al limitei zilnice de invitații (doar crescător).
 */
export const householdInvites = finet.table(
  "household_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    role: text("role", { enum: INVITE_ROLES }).notNull().default("member"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    usedByUserId: uuid("used_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    unique("household_invites_token_hash_key").on(t.tokenHash),
    index("household_invites_household_created_idx").on(t.householdId, t.createdAt),
    check("household_invites_token_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("household_invites_role_valid", sql`${t.role} in ('owner', 'member')`),
    check("household_invites_expires_after_created", sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      "household_invites_expires_max",
      sql`${t.expiresAt} <= ${t.createdAt} + interval '168 hours'`,
    ),
    // `used_at` și `used_by_user_id` se completează împreună (`used_by` poate deveni NULL doar
    // la ștergerea utilizatorului, deci forma e „folosit ⇒ data există”).
    check(
      "household_invites_used_shape",
      sql`${t.usedByUserId} is null or ${t.usedAt} is not null`,
    ),
    // O invitație folosită nu mai poate fi revocată și invers.
    check("household_invites_used_or_revoked", sql`${t.usedAt} is null or ${t.revokedAt} is null`),
  ],
);

/**
 * Împărțirea unei cheltuieli între membri (5.1: sume `bigint` în unități minore). Un rând pe
 * participant (inclusiv plătitorul, pentru partea lui). Plătitorul (`payer_user_id`) e
 * proprietarul contului PERSONAL din care s-a plătit (ADR 0016): constant pe tranzacție, stocat
 * ca soldurile să poată fi calculate de orice membru fără să vadă tranzacția sau contul.
 * Suma părților = totalul tranzacției: verificată în serviciu și de un trigger amânat la COMMIT.
 */
export const transactionSplits = finet.table(
  "transaction_splits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id").notNull(),
    payerUserId: uuid("payer_user_id")
      .notNull()
      .references(() => users.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    shareMinor: minor("share_minor").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("transaction_splits_transaction_user_key").on(t.transactionId, t.userId),
    foreignKey({
      name: "transaction_splits_transaction_fk",
      columns: [t.transactionId, t.householdId],
      foreignColumns: [transactions.id, transactions.householdId],
    }).onDelete("cascade"),
    index("transaction_splits_household_id_idx").on(t.householdId),
    index("transaction_splits_user_id_idx").on(t.userId),
    index("transaction_splits_payer_user_id_idx").on(t.payerUserId),
    check("transaction_splits_share_min", sql`${t.shareMinor} >= 0`),
    check("transaction_splits_share_max", sql`${t.shareMinor} <= 10000000000000`),
    check("transaction_splits_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
  ],
);

/**
 * Decontările între membri: `from_user_id` i-a dat lui `to_user_id` suma (o decontare parțială
 * = mai multe rânduri). Anularea pune `cancelled_at` (istoricul rămâne; fără DELETE). Membrii se
 * verifică la inserare (trigger), FĂRĂ cheie compusă spre `household_members`: istoricul rămâne
 * și după plecarea unui membru.
 */
export const settlements = finet.table(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id),
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id),
    amountMinor: minor("amount_minor").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    settledOn: date("settled_on", { mode: "string" }).notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    cancelledAt: ts("cancelled_at"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("settlements_household_settled_idx").on(t.householdId, t.settledOn),
    index("settlements_from_user_id_idx").on(t.fromUserId),
    index("settlements_to_user_id_idx").on(t.toUserId),
    check("settlements_distinct_users", sql`${t.fromUserId} <> ${t.toUserId}`),
    check("settlements_amount_min", sql`${t.amountMinor} >= 1`),
    check("settlements_amount_max", sql`${t.amountMinor} <= 10000000000000`),
    check("settlements_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check("settlements_settled_on_min", sql`${t.settledOn} >= date '1900-01-01'`),
    check("settlements_settled_on_max", sql`${t.settledOn} <= date '2999-12-31'`),
    check("settlements_note_length", sql`${t.note} is null or char_length(${t.note}) <= 200`),
    check(
      "settlements_cancel_shape",
      sql`${t.cancelledByUserId} is null or ${t.cancelledAt} is not null`,
    ),
  ],
);
