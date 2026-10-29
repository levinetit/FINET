import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";
import { DB_CURRENCIES, households } from "./households";
import { accounts } from "./ledger";

/**
 * Faza 7 — importul extraselor bancare (master prompt Faza 7, 3.6, 5.1, 5.2, 6.1); ADR 0018.
 *
 * Migrația: `src/db/migrations/0013_statements.sql` (DDL-ul de aici, generat de drizzle-kit, plus
 * partea scrisă de mână: cheia `statement_lines_transaction_fk` cu `SET NULL (transaction_id)`,
 * RLS ENABLE + FORCE, politicile cu vizibilitatea conturilor personale și drepturile minime).
 *
 * Fișierul sursă al extrasului NU se păstrează (decizia mea, ADR 0018): rămân doar amprenta
 * SHA-256 (deduplicare la nivel de fișier), contoarele, perioada și rândurile parsate (necesare
 * între previzualizare și confirmare și pentru anulare). Tranzacțiile create poartă
 * `external_ref = 'stmt:<dedup_key>'` (indexul unic existent pe gospodărie: cheia include contul,
 * deci unicitatea e efectiv per cont).
 *
 * CHECK-uri PLATE (fără BETWEEN într-un lanț AND, fără OR imbricat), ca amprenta pg_dump să
 * rămână stabilă (lecția Fazelor 3–8).
 */

export const STATEMENT_BANKS = [
  "bt",
  "brd",
  "raiffeisen",
  "revolut",
  "ing",
  "bcr",
  "wise",
  "generic",
] as const;
export const STATEMENT_FORMATS = ["pdf", "csv", "xlsx"] as const;
export const STATEMENT_IMPORT_STATUSES = ["previewed", "imported", "failed", "cancelled"] as const;
export const STATEMENT_BALANCE_STATUSES = ["ok", "mismatch", "unknown"] as const;
export const STATEMENT_DIRECTIONS = ["debit", "credit"] as const;
export const STATEMENT_LINE_KINDS = ["movement", "fx"] as const;
export const STATEMENT_LINE_STATES = [
  "new",
  "duplicate",
  "imported",
  "skipped",
  "cancelled",
] as const;

/** Plafoanele (decizia mea, ADR 0018). */
export const STATEMENT_MAX_LINES = 5000;
export const STATEMENT_DESCRIPTION_MAX = 500;
export const STATEMENT_REFERENCE_MAX = 200;

const minor = (name: string) => bigint(name, { mode: "bigint" });
const day = (name: string) => date(name, { mode: "string" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Un import (o previzualizare care poate fi confirmată, anulată sau eșuată) pe UN cont. */
export const statementImports = finet.table(
  "statement_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    // Moneda contului (cheia compusă spre `accounts`).
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    bank: text("bank", { enum: STATEMENT_BANKS }).notNull(),
    format: text("format", { enum: STATEMENT_FORMATS }).notNull(),
    status: text("status", { enum: STATEMENT_IMPORT_STATUSES }).notNull().default("previewed"),
    parserVersion: smallint("parser_version").notNull(),
    periodStart: day("period_start"),
    periodEnd: day("period_end"),
    openingBalanceMinor: minor("opening_balance_minor"),
    closingBalanceMinor: minor("closing_balance_minor"),
    computedClosingMinor: minor("computed_closing_minor"),
    balanceStatus: text("balance_status", { enum: STATEMENT_BALANCE_STATUSES }).notNull(),
    sourceSha256: text("source_sha256").notNull(),
    lineCount: integer("line_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    pendingCount: integer("pending_count").notNull().default(0),
    importedCount: integer("imported_count").notNull().default(0),
    // Coduri fixe separate prin virgulă (fără conținut), de exemplu `pending_skipped,day_balance`.
    warningCodes: text("warning_codes"),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    importedAt: ts("imported_at"),
    cancelledAt: ts("cancelled_at"),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    unique("statement_imports_id_household_key").on(t.id, t.householdId),
    // Ținta cheii din `statement_lines`: același import, aceeași gospodărie, același cont, aceeași
    // monedă (un rând nu poate indica alt cont decât importul lui).
    unique("statement_imports_line_target_key").on(t.id, t.householdId, t.accountId, t.currency),
    foreignKey({
      name: "statement_imports_account_fk",
      columns: [t.accountId, t.householdId, t.currency],
      foreignColumns: [accounts.id, accounts.householdId, accounts.currency],
    }).onDelete("cascade"),
    // Același fișier nu se previzualizează/importă de două ori pe același cont; după anulare sau
    // eșec se poate relua.
    uniqueIndex("statement_imports_account_source_key")
      .on(t.accountId, t.sourceSha256)
      .where(sql`${t.status} = 'previewed' or ${t.status} = 'imported'`),
    index("statement_imports_household_created_idx").on(t.householdId, t.createdAt),
    index("statement_imports_account_status_idx").on(t.accountId, t.status),
    index("statement_imports_created_by_user_id_idx").on(t.createdByUserId),
    index("statement_imports_cancelled_by_user_id_idx").on(t.cancelledByUserId),
    check(
      "statement_imports_bank_valid",
      sql`${t.bank} in ('bt', 'brd', 'raiffeisen', 'revolut', 'ing', 'bcr', 'wise', 'generic')`,
    ),
    check("statement_imports_format_valid", sql`${t.format} in ('pdf', 'csv', 'xlsx')`),
    check(
      "statement_imports_status_valid",
      sql`${t.status} in ('previewed', 'imported', 'failed', 'cancelled')`,
    ),
    check(
      "statement_imports_balance_status_valid",
      sql`${t.balanceStatus} in ('ok', 'mismatch', 'unknown')`,
    ),
    check("statement_imports_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check("statement_imports_parser_version_min", sql`${t.parserVersion} >= 1`),
    check("statement_imports_parser_version_max", sql`${t.parserVersion} <= 1000`),
    check("statement_imports_source_sha256_format", sql`${t.sourceSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "statement_imports_period_start_min",
      sql`${t.periodStart} is null or ${t.periodStart} >= date '1900-01-01'`,
    ),
    check(
      "statement_imports_period_end_max",
      sql`${t.periodEnd} is null or ${t.periodEnd} <= date '2999-12-31'`,
    ),
    check(
      "statement_imports_period_order",
      sql`${t.periodStart} is null or ${t.periodEnd} is null or ${t.periodEnd} >= ${t.periodStart}`,
    ),
    check(
      "statement_imports_opening_min",
      sql`${t.openingBalanceMinor} is null or ${t.openingBalanceMinor} >= -10000000000000`,
    ),
    check(
      "statement_imports_opening_max",
      sql`${t.openingBalanceMinor} is null or ${t.openingBalanceMinor} <= 10000000000000`,
    ),
    check(
      "statement_imports_closing_min",
      sql`${t.closingBalanceMinor} is null or ${t.closingBalanceMinor} >= -10000000000000`,
    ),
    check(
      "statement_imports_closing_max",
      sql`${t.closingBalanceMinor} is null or ${t.closingBalanceMinor} <= 10000000000000`,
    ),
    check(
      "statement_imports_computed_min",
      sql`${t.computedClosingMinor} is null or ${t.computedClosingMinor} >= -10000000000000`,
    ),
    check(
      "statement_imports_computed_max",
      sql`${t.computedClosingMinor} is null or ${t.computedClosingMinor} <= 10000000000000`,
    ),
    check(
      "statement_imports_counts_min",
      sql`${t.lineCount} >= 0 and ${t.newCount} >= 0 and ${t.duplicateCount} >= 0 and ${t.pendingCount} >= 0 and ${t.importedCount} >= 0`,
    ),
    check(
      "statement_imports_counts_max",
      sql`${t.lineCount} <= 5000 and ${t.newCount} <= ${t.lineCount} and ${t.duplicateCount} <= ${t.lineCount} and ${t.pendingCount} <= 5000 and ${t.importedCount} <= 10000`,
    ),
    check(
      "statement_imports_warning_codes_format",
      sql`${t.warningCodes} is null or ${t.warningCodes} ~ '^[a-z][a-z0-9_]{1,40}(,[a-z][a-z0-9_]{1,40}){0,19}$'`,
    ),
    check(
      "statement_imports_error_code_format",
      sql`${t.errorCode} is null or ${t.errorCode} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    // Anulat ⇔ data anulării; importat (sau anulat după import) ⇒ data importului e permisă.
    check(
      "statement_imports_cancel_shape",
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} is not null)`,
    ),
    check(
      "statement_imports_cancelled_by_shape",
      sql`${t.cancelledByUserId} is null or ${t.cancelledAt} is not null`,
    ),
    check(
      "statement_imports_imported_shape",
      sql`${t.importedAt} is null or ${t.status} <> 'previewed'`,
    ),
    check(
      "statement_imports_imported_status",
      sql`${t.status} <> 'imported' or ${t.importedAt} is not null`,
    ),
  ],
);

/**
 * Rândurile parsate ale unui import (ordinea din extras). `state`: `new` (va fi importat la
 * confirmare), `duplicate` (există deja în cont), `imported`, `skipped` (exclus de utilizator sau
 * sumă zero), `cancelled` (importul a fost anulat). `transaction_id` → tranzacția creată
 * (`SET NULL` dacă utilizatorul o șterge; rândul rămâne `imported`, deci reimportul nu o
 * recreează).
 */
export const statementLines = finet.table(
  "statement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    importId: uuid("import_id").notNull(),
    accountId: uuid("account_id").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    rowNo: integer("row_no").notNull(),
    occurredOn: day("occurred_on").notNull(),
    direction: text("direction", { enum: STATEMENT_DIRECTIONS }).notNull(),
    amountMinor: minor("amount_minor").notNull(),
    description: text("description").notNull(),
    bankReference: text("bank_reference"),
    dedupKey: text("dedup_key").notNull(),
    kind: text("kind", { enum: STATEMENT_LINE_KINDS }).notNull().default("movement"),
    // Schimb valutar: suma în cealaltă monedă, dacă extrasul o arată.
    fxAmountMinor: minor("fx_amount_minor"),
    fxCurrency: text("fx_currency", { enum: DB_CURRENCIES }),
    balanceAfterMinor: minor("balance_after_minor"),
    state: text("state", { enum: STATEMENT_LINE_STATES }).notNull().default("new"),
    transactionId: uuid("transaction_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "statement_lines_import_fk",
      columns: [t.importId, t.householdId, t.accountId, t.currency],
      foreignColumns: [
        statementImports.id,
        statementImports.householdId,
        statementImports.accountId,
        statementImports.currency,
      ],
    }).onDelete("cascade"),
    unique("statement_lines_import_row_key").on(t.importId, t.rowNo),
    // Deduplicarea: o cheie importată o singură dată pe cont.
    uniqueIndex("statement_lines_account_dedup_key")
      .on(t.accountId, t.dedupKey)
      .where(sql`${t.state} = 'imported'`),
    index("statement_lines_household_id_idx").on(t.householdId),
    index("statement_lines_account_occurred_idx").on(t.accountId, t.occurredOn),
    index("statement_lines_transaction_id_idx").on(t.transactionId),
    check("statement_lines_row_no_min", sql`${t.rowNo} >= 1`),
    check("statement_lines_row_no_max", sql`${t.rowNo} <= 5000`),
    check("statement_lines_direction_valid", sql`${t.direction} in ('debit', 'credit')`),
    check("statement_lines_amount_min", sql`${t.amountMinor} >= 1`),
    check("statement_lines_amount_max", sql`${t.amountMinor} <= 10000000000000`),
    check("statement_lines_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check("statement_lines_occurred_on_min", sql`${t.occurredOn} >= date '1900-01-01'`),
    check("statement_lines_occurred_on_max", sql`${t.occurredOn} <= date '2999-12-31'`),
    check("statement_lines_description_length", sql`char_length(${t.description}) <= 500`),
    check(
      "statement_lines_bank_reference_length",
      sql`${t.bankReference} is null or char_length(${t.bankReference}) <= 200`,
    ),
    check("statement_lines_dedup_key_format", sql`${t.dedupKey} ~ '^[0-9a-f]{64}$'`),
    check("statement_lines_kind_valid", sql`${t.kind} in ('movement', 'fx')`),
    check(
      "statement_lines_state_valid",
      sql`${t.state} in ('new', 'duplicate', 'imported', 'skipped', 'cancelled')`,
    ),
    check(
      "statement_lines_fx_currency_valid",
      sql`${t.fxCurrency} is null or ${t.fxCurrency} in ('RON', 'EUR', 'USD')`,
    ),
    check("statement_lines_fx_kind", sql`${t.fxCurrency} is null or ${t.kind} = 'fx'`),
    check(
      "statement_lines_fx_amount_shape",
      sql`${t.fxAmountMinor} is null or ${t.fxCurrency} is not null`,
    ),
    check(
      "statement_lines_fx_amount_min",
      sql`${t.fxAmountMinor} is null or ${t.fxAmountMinor} >= 1`,
    ),
    check(
      "statement_lines_fx_amount_max",
      sql`${t.fxAmountMinor} is null or ${t.fxAmountMinor} <= 10000000000000`,
    ),
    check(
      "statement_lines_balance_min",
      sql`${t.balanceAfterMinor} is null or ${t.balanceAfterMinor} >= -10000000000000`,
    ),
    check(
      "statement_lines_balance_max",
      sql`${t.balanceAfterMinor} is null or ${t.balanceAfterMinor} <= 10000000000000`,
    ),
  ],
);

/**
 * Contorul zilnic al previzualizărilor de extrase per gospodărie: DOAR crescător (anularea sau
 * ștergerea unei previzualizări nu eliberează limita), ca `document_usage_daily`.
 */
export const statementUsageDaily = finet.table(
  "statement_usage_daily",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    day: day("day").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "statement_usage_daily_pkey", columns: [t.householdId, t.day] }),
    check("statement_usage_daily_count_min", sql`${t.count} >= 0`),
    check("statement_usage_daily_count_max", sql`${t.count} <= 1000000`),
    check("statement_usage_daily_day_min", sql`${t.day} >= date '2000-01-01'`),
    check("statement_usage_daily_day_max", sql`${t.day} <= date '2999-12-31'`),
  ],
);
