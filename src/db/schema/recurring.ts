import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";
import { DB_CURRENCIES, households } from "./households";
import { accounts, categories } from "./ledger";

/**
 * Faza 5 — recurențe (master prompt 6.1, Faza 5 din 7) și starea workerului.
 *
 * Migrația: `src/db/migrations/0006_recurring.sql` (DDL-ul de aici, generat de drizzle-kit, plus
 * partea scrisă de mână: cheile cu `SET NULL (coloană)` / `DEFERRABLE`, triggerul de integritate,
 * funcția `due_recurring_rules`, RLS și drepturile). Deciziile: ADR 0011.
 *
 * Nu sunt declarate aici (drizzle-kit nu le exprimă), ci în partea scrisă de mână a 0006:
 * - `recurring_occurrences_transaction_fk`: (transaction_id, household_id) → transactions,
 *   `ON DELETE SET NULL (transaction_id)`, `DEFERRABLE INITIALLY DEFERRED` (ocurența se inserează
 *   înaintea tranzacției, cu id-ul ei generat în aplicație);
 * - `transactions_recurring_rule_fk`: (recurring_rule_id, household_id) → recurring_rules,
 *   `ON DELETE SET NULL (recurring_rule_id)` (`NOT VALID` + `VALIDATE`).
 */

export const RECURRING_TYPES = ["income", "expense"] as const;
export const RECURRING_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export const RECURRING_STATUSES = ["active", "paused", "completed"] as const;

/** Plafoanele (decizia mea, ADR 0011): intervalul și numărul de rate. */
export const RECURRING_MAX_INTERVAL = 100;
export const RECURRING_MAX_OCCURRENCES = 1200;

const minor = (name: string) => bigint(name, { mode: "bigint" });
const day = (name: string) => date(name, { mode: "string" });

/**
 * Regulile recurente (abonamente, chirie, rate). Moneda = a contului (cheia compusă spre
 * `accounts`); `next_run_on` = următoarea scadență negenerată; `occurrences_count` = câte
 * tranzacții a generat regula (pentru `max_occurrences`).
 */
export const recurringRules = finet.table(
  "recurring_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    categoryId: uuid("category_id"),
    type: text("type", { enum: RECURRING_TYPES }).notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    description: text("description").notNull(),
    merchant: text("merchant"),
    frequency: text("frequency", { enum: RECURRING_FREQUENCIES }).notNull(),
    interval: integer("interval").notNull().default(1),
    dayOfMonth: integer("day_of_month"),
    startOn: day("start_on").notNull(),
    nextRunOn: day("next_run_on").notNull(),
    endOn: day("end_on"),
    maxOccurrences: integer("max_occurrences"),
    occurrencesCount: integer("occurrences_count").notNull().default(0),
    status: text("status", { enum: RECURRING_STATUSES }).notNull().default("active"),
    // Ultima generare eșuată (cod fix, fără detalii) și pauza de reîncercare: o regulă care pică
    // la fiecare rulare nu ocupă fereastra `LIMIT` a workerului înaintea celor sănătoase.
    lastErrorCode: text("last_error_code"),
    retryAfter: timestamp("retry_after", { withTimezone: true, mode: "date" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Ținta cheilor compuse din `recurring_occurrences` și `transactions`: aceeași gospodărie.
    unique("recurring_rules_id_household_key").on(t.id, t.householdId),
    foreignKey({
      name: "recurring_rules_account_fk",
      columns: [t.accountId, t.householdId, t.currency],
      foreignColumns: [accounts.id, accounts.householdId, accounts.currency],
    }).onDelete("cascade"),
    foreignKey({
      name: "recurring_rules_category_id_fk",
      columns: [t.categoryId],
      foreignColumns: [categories.id],
    }).onDelete("set null"),
    index("recurring_rules_household_status_idx").on(t.householdId, t.status),
    index("recurring_rules_account_id_idx").on(t.accountId),
    index("recurring_rules_category_id_idx").on(t.categoryId),
    index("recurring_rules_created_by_user_id_idx").on(t.createdByUserId),
    // Selecția workerului (`due_recurring_rules`): regulile active, după scadență.
    index("recurring_rules_due_idx")
      .on(t.nextRunOn, t.id)
      .where(sql`${t.status} = 'active'`),
    check("recurring_rules_type_valid", sql`${t.type} in ('income', 'expense')`),
    check("recurring_rules_amount_range", sql`${t.amountMinor} between 1 and 10000000000000`),
    check("recurring_rules_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check(
      "recurring_rules_description_length",
      sql`char_length(${t.description}) >= 1 and char_length(${t.description}) <= 500 and ${t.description} = btrim(${t.description})`,
    ),
    check(
      "recurring_rules_merchant_length",
      sql`${t.merchant} is null or char_length(${t.merchant}) <= 200`,
    ),
    check(
      "recurring_rules_frequency_valid",
      sql`${t.frequency} in ('daily', 'weekly', 'monthly', 'yearly')`,
    ),
    check("recurring_rules_interval_range", sql`${t.interval} between 1 and 100`),
    // Ziua din lună: obligatorie la lunar/anual, interzisă la zilnic/săptămânal.
    check(
      "recurring_rules_day_of_month_shape",
      sql`(${t.frequency} in ('monthly', 'yearly')) = (${t.dayOfMonth} is not null) and (${t.dayOfMonth} is null or ${t.dayOfMonth} between 1 and 31)`,
    ),
    check(
      "recurring_rules_dates_range",
      sql`${t.startOn} >= date '1900-01-01' and ${t.startOn} <= date '2999-12-31' and ${t.nextRunOn} >= date '1900-01-01' and ${t.nextRunOn} <= date '2999-12-31' and (${t.endOn} is null or ${t.endOn} between date '1900-01-01' and date '2999-12-31')`,
    ),
    check(
      "recurring_rules_dates_order",
      sql`${t.nextRunOn} >= ${t.startOn} and (${t.endOn} is null or ${t.endOn} >= ${t.startOn})`,
    ),
    check(
      "recurring_rules_max_occurrences_range",
      sql`${t.maxOccurrences} is null or ${t.maxOccurrences} between 1 and 1200`,
    ),
    check(
      "recurring_rules_occurrences_count_range",
      sql`${t.occurrencesCount} >= 0 and (${t.maxOccurrences} is null or ${t.occurrencesCount} <= ${t.maxOccurrences})`,
    ),
    check(
      "recurring_rules_last_error_code_format",
      sql`${t.lastErrorCode} is null or ${t.lastErrorCode} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    check("recurring_rules_status_valid", sql`${t.status} in ('active', 'paused', 'completed')`),
  ],
);

/**
 * Ocurențele generate: o regulă are cel mult o ocurență pe dată (cheia primară
 * `(rule_id, occurrence_date)` = garanția de idempotență). `transaction_id` devine NULL dacă
 * utilizatorul șterge tranzacția generată; ocurența rămâne, deci data nu se regenerează.
 */
export const recurringOccurrences = finet.table(
  "recurring_occurrences",
  {
    ruleId: uuid("rule_id").notNull(),
    householdId: uuid("household_id").notNull(),
    occurrenceDate: day("occurrence_date").notNull(),
    transactionId: uuid("transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "recurring_occurrences_pkey", columns: [t.ruleId, t.occurrenceDate] }),
    foreignKey({
      name: "recurring_occurrences_rule_fk",
      columns: [t.ruleId, t.householdId],
      foreignColumns: [recurringRules.id, recurringRules.householdId],
    }).onDelete("cascade"),
    index("recurring_occurrences_household_id_idx").on(t.householdId),
    index("recurring_occurrences_transaction_id_idx").on(t.transactionId),
  ],
);

/**
 * Semnalul de viață al proceselor de fundal (`/api/health` → `queue`), fără date de gospodărie:
 * un rând pe serviciu (`worker`), actualizat periodic de worker și citit de `finet-web`. Așa
 * serverul web nu depinde de pg-boss (ADR 0011).
 */
export const serviceHeartbeats = finet.table(
  "service_heartbeats",
  {
    service: text("service").primaryKey(),
    beatAt: timestamp("beat_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [check("service_heartbeats_service_valid", sql`${t.service} in ('worker')`)],
);
