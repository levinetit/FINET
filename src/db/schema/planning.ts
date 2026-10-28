import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";
import { DB_CURRENCIES, households } from "./households";
import { categories, transactions } from "./ledger";

/**
 * Faza 3 — planificare (master prompt 5.4, 6.1): etichete, bugete, obiective.
 *
 * Migrația: `src/db/migrations/0004_budgets_goals_tags.sql` (DDL-ul de aici, generat de
 * drizzle-kit, plus partea scrisă de mână: etichetele de sistem, triggerele, cheia compusă
 * `goals_account_fk` cu `ON DELETE SET NULL (account_id)`, RLS și drepturile). Deciziile: ADR 0007.
 *
 * Cheia `goals_account_fk` NU e declarată aici: drizzle-kit nu exprimă `SET NULL (coloană)` (PG 15+),
 * iar o cheie compusă cu `SET NULL` simplu ar pune NULL și pe `household_id`.
 */

export const BUDGET_PERIODS = ["monthly"] as const;
export const BUDGET_SCOPES = ["household", "personal"] as const;
export const GOAL_STATUSES = ["active", "achieved", "abandoned"] as const;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const minor = (name: string) => bigint(name, { mode: "bigint" });
const ZERO_UUID = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

/** Etichetele (5.4): de sistem (`household_id` NULL, cu `system_key`) sau ale gospodăriei. */
export const tags = finet.table(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color"),
    // Doar pentru etichetele gospodăriei; cele de sistem se ascund prin `tag_visibility`.
    hidden: boolean("hidden").notNull().default(false),
    systemKey: text("system_key"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tags_household_name_key").on(
      sql`coalesce(${t.householdId}, ${ZERO_UUID})`,
      sql`lower(${t.name})`,
    ),
    uniqueIndex("tags_system_key_key")
      .on(t.systemKey)
      .where(sql`${t.systemKey} is not null`),
    check("tags_name_length", sql`char_length(${t.name}) between 1 and 40`),
    check("tags_name_trimmed", sql`${t.name} = btrim(${t.name})`),
    check("tags_color_format", sql`${t.color} is null or ${t.color} ~ '^#[0-9a-f]{6}$'`),
    check("tags_system_shape", sql`(${t.householdId} is null) = (${t.systemKey} is not null)`),
    check(
      "tags_system_key_format",
      sql`${t.systemKey} is null or ${t.systemKey} ~ '^[a-z][a-z0-9_]{1,39}$'`,
    ),
  ],
);

/** Ascunderea etichetelor de SISTEM per gospodărie (ca `category_visibility`). */
export const tagVisibility = finet.table(
  "tag_visibility",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    hidden: boolean("hidden").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "tag_visibility_pkey", columns: [t.householdId, t.tagId] }),
    index("tag_visibility_tag_id_idx").on(t.tagId),
  ],
);

/**
 * Legătura tranzacție ↔ etichetă. `household_id` = gospodăria tranzacției (cheie compusă spre
 * `transactions(id, household_id)`); eticheta e de sistem sau a aceleiași gospodării (trigger).
 */
export const transactionTags = finet.table(
  "transaction_tags",
  {
    transactionId: uuid("transaction_id").notNull(),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    householdId: uuid("household_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "transaction_tags_pkey", columns: [t.transactionId, t.tagId] }),
    foreignKey({
      name: "transaction_tags_transaction_fk",
      columns: [t.transactionId, t.householdId],
      foreignColumns: [transactions.id, transactions.householdId],
    }).onDelete("cascade"),
    index("transaction_tags_tag_id_idx").on(t.tagId),
    index("transaction_tags_household_id_idx").on(t.householdId),
  ],
);

/**
 * Bugetele lunare (6.1): general (`category_id` NULL) sau pe o categorie de cheltuieli (cu
 * subcategoriile ei), ale gospodăriei (`household`) sau personale (`personal`, vizibile doar
 * proprietarului `user_id`). O categorie ștearsă își șterge bugetele (decizia mea, ADR 0007).
 */
export const budgets = finet.table(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "cascade" }),
    period: text("period", { enum: BUDGET_PERIODS }).notNull().default("monthly"),
    amountMinor: minor("amount_minor").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    warnPct: integer("warn_pct").notNull().default(80),
    scope: text("scope", { enum: BUDGET_SCOPES }).notNull().default("household"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("budgets_active_key")
      .on(
        t.householdId,
        sql`coalesce(${t.categoryId}, ${ZERO_UUID})`,
        t.scope,
        sql`coalesce(${t.userId}, ${ZERO_UUID})`,
        t.currency,
      )
      .where(sql`${t.archivedAt} is null`),
    index("budgets_category_id_idx").on(t.categoryId),
    index("budgets_user_id_idx").on(t.userId),
    check("budgets_period_valid", sql`${t.period} in ('monthly')`),
    check("budgets_amount_range", sql`${t.amountMinor} between 1 and 10000000000000`),
    check("budgets_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check("budgets_warn_pct_range", sql`${t.warnPct} between 1 and 100`),
    check("budgets_scope_valid", sql`${t.scope} in ('household', 'personal')`),
    check("budgets_scope_user", sql`(${t.scope} = 'personal') = (${t.userId} is not null)`),
  ],
);

/** Obiectivele de economisire (6.1). `status` e coerent cu progresul (CHECK `goals_status_progress`). */
export const goals = finet.table(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetMinor: minor("target_minor").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    savedMinor: minor("saved_minor")
      .notNull()
      .default(sql`0`),
    deadline: date("deadline", { mode: "string" }),
    status: text("status", { enum: GOAL_STATUSES }).notNull().default("active"),
    // Cheia compusă (account_id, household_id, currency) e în partea scrisă de mână a 0004.
    accountId: uuid("account_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("goals_household_status_idx").on(t.householdId, t.status),
    index("goals_account_id_idx").on(t.accountId),
    check("goals_name_length", sql`char_length(${t.name}) between 1 and 100`),
    check("goals_name_trimmed", sql`${t.name} = btrim(${t.name})`),
    check("goals_target_range", sql`${t.targetMinor} between 1 and 10000000000000`),
    check("goals_saved_range", sql`${t.savedMinor} between 0 and 10000000000000`),
    check("goals_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check("goals_status_valid", sql`${t.status} in ('active', 'achieved', 'abandoned')`),
    // Atins ⇔ economisit ≥ țintă (în afară de abandonat, care e manual).
    check(
      "goals_status_progress",
      sql`${t.status} = 'abandoned' or (${t.status} = 'achieved') = (${t.savedMinor} >= ${t.targetMinor})`,
    ),
    check(
      "goals_deadline_range",
      sql`${t.deadline} is null or ${t.deadline} between date '1900-01-01' and date '2999-12-31'`,
    ),
  ],
);
