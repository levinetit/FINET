import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { createdAt, finet, updatedAt } from "./finet";
import { DB_CURRENCIES, households } from "./households";

/**
 * Faza 2 — registrul financiar (master prompt 5.1, 5.4, 5.6, 6.1, 6.5): conturi, categorii,
 * tranzacții (inclusiv transferuri), chei de idempotență și statisticile de utilizare.
 *
 * Migrația: `src/db/migrations/0002_ledger.sql` (DDL-ul de aici, generat de drizzle-kit, plus
 * partea scrisă de mână: RLS, drepturi, triggere, categoriile de sistem). Deciziile: ADR 0004.
 *
 * Bani: `*_minor` sunt `bigint` în unități minore, citite ca `bigint` în JS (`mode: "bigint"`);
 * `amount_minor > 0`, semnul vine din `type`. Datele calendaristice (`occurred_on`) sunt `date`
 * citite ca text `YYYY-MM-DD` (`mode: "string"`), ca să nu treacă prin fusul orar al procesului.
 *
 * Cheile străine spre conturi și categorii sunt `NO ACTION` (verificate la sfârșitul
 * instrucțiunii), nu `RESTRICT`: ștergerea unei gospodării șterge în cascadă, în aceeași
 * instrucțiune, și conturile, și tranzacțiile, iar verificarea trece. Pentru aplicație efectul e
 * același: un cont cu tranzacții sau o categorie folosită nu se pot șterge (5.6).
 */

export const ACCOUNT_TYPES = ["cash", "bank", "savings", "credit_card"] as const;
export const CATEGORY_KINDS = ["income", "expense"] as const;
export const TRANSACTION_TYPES = ["income", "expense", "transfer"] as const;
export const TRANSACTION_SOURCES = ["manual", "receipt", "statement", "recurring"] as const;
/** Sensul unui rând de transfer: `out` = ieșire din cont, `in` = intrare în cont. */
export const TRANSFER_DIRECTIONS = ["out", "in"] as const;
export const CLIENT_PLATFORMS = ["android", "web"] as const;
export const DOWNLOAD_SOURCES = ["finet_page", "qr"] as const;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const minor = (name: string) => bigint(name, { mode: "bigint" });

export const accounts = finet.table(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    // NULL = cont comun al gospodăriei; altfel contul personal al unui membru.
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    // Poate fi negativ (card de credit, descoperit de cont).
    openingBalanceMinor: minor("opening_balance_minor").notNull().default(sql`0`),
    bankCode: text("bank_code"),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Ținta cheii compuse din `transactions`: aceeași gospodărie ȘI aceeași monedă.
    unique("accounts_id_household_currency_key").on(t.id, t.householdId, t.currency),
    uniqueIndex("accounts_household_name_active_key")
      .on(t.householdId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index("accounts_owner_user_id_idx").on(t.ownerUserId),
    check("accounts_name_length", sql`char_length(${t.name}) between 1 and 100`),
    check("accounts_name_trimmed", sql`${t.name} = btrim(${t.name})`),
    check("accounts_type_valid", sql`${t.type} in ('cash', 'bank', 'savings', 'credit_card')`),
    check("accounts_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check(
      "accounts_bank_code_format",
      sql`${t.bankCode} is null or ${t.bankCode} ~ '^[a-z0-9_]{2,32}$'`,
    ),
  ],
);

export const categories = finet.table(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL = categorie de sistem (5.4), comună tuturor gospodăriilor, doar citire.
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    // Ierarhie pe un singur nivel (trigger `categories_check_parent` în 0002_ledger.sql).
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    kind: text("kind", { enum: CATEGORY_KINDS }).notNull(),
    icon: text("icon"),
    color: text("color"),
    // Doar pentru categoriile personalizate; cele de sistem se ascund prin `category_visibility`.
    hidden: boolean("hidden").notNull().default(false),
    // Cheia stabilă a categoriilor de sistem (de exemplu `expense.groceries`).
    systemKey: text("system_key"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "categories_parent_id_fk",
      columns: [t.parentId],
      foreignColumns: [t.id],
    }),
    uniqueIndex("categories_system_key_key")
      .on(t.systemKey)
      .where(sql`${t.systemKey} is not null`),
    uniqueIndex("categories_household_parent_name_key").on(
      t.householdId,
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
    index("categories_parent_id_idx").on(t.parentId),
    check("categories_name_length", sql`char_length(${t.name}) between 1 and 60`),
    check("categories_name_trimmed", sql`${t.name} = btrim(${t.name})`),
    check("categories_kind_valid", sql`${t.kind} in ('income', 'expense')`),
    check("categories_icon_format", sql`${t.icon} is null or ${t.icon} ~ '^[a-z0-9-]{1,40}$'`),
    check("categories_color_format", sql`${t.color} is null or ${t.color} ~ '^#[0-9a-f]{6}$'`),
    check("categories_not_own_parent", sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
    // Sistem ⇔ fără gospodărie ⇔ cu cheie stabilă; categoriile de sistem nu au părinte.
    check(
      "categories_system_shape",
      sql`(${t.householdId} is null) = (${t.systemKey} is not null) and (${t.householdId} is not null or ${t.parentId} is null)`,
    ),
    check(
      "categories_system_key_format",
      sql`${t.systemKey} is null or ${t.systemKey} ~ '^(income|expense)[.][a-z0-9_]{2,40}$'`,
    ),
  ],
);

/** Ascunderea categoriilor de SISTEM per gospodărie (rândurile de sistem rămân neatinse). */
export const categoryVisibility = finet.table(
  "category_visibility",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    hidden: boolean("hidden").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "category_visibility_pkey", columns: [t.householdId, t.categoryId] }),
    index("category_visibility_category_id_idx").on(t.categoryId),
  ],
);

export const transactions = finet.table(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").notNull(),
    categoryId: uuid("category_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: text("type", { enum: TRANSACTION_TYPES }).notNull(),
    amountMinor: minor("amount_minor").notNull(),
    // Aceeași cu moneda contului (cheia compusă spre `accounts`).
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    occurredOn: date("occurred_on", { mode: "string" }).notNull(),
    description: text("description"),
    merchant: text("merchant"),
    notes: text("notes"),
    source: text("source", { enum: TRANSACTION_SOURCES }).notNull().default("manual"),
    transferGroupId: uuid("transfer_group_id"),
    transferDirection: text("transfer_direction", { enum: TRANSFER_DIRECTIONS }),
    // Legăturile din fazele 5 și 6 (fără cheie străină până atunci).
    recurringRuleId: uuid("recurring_rule_id"),
    documentId: uuid("document_id"),
    externalRef: text("external_ref"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "transactions_account_fk",
      columns: [t.accountId, t.householdId, t.currency],
      foreignColumns: [accounts.id, accounts.householdId, accounts.currency],
    }),
    foreignKey({
      name: "transactions_category_id_fk",
      columns: [t.categoryId],
      foreignColumns: [categories.id],
    }),
    index("transactions_household_occurred_idx").on(
      t.householdId,
      t.occurredOn.desc(),
      t.id.desc(),
    ),
    index("transactions_account_id_idx").on(t.accountId),
    index("transactions_category_id_idx").on(t.categoryId),
    index("transactions_created_by_user_id_idx").on(t.createdByUserId),
    uniqueIndex("transactions_household_external_ref_key")
      .on(t.householdId, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
    // Cel mult un rând `out` și unul `in` pe grup de transfer.
    uniqueIndex("transactions_transfer_group_direction_key")
      .on(t.transferGroupId, t.transferDirection)
      .where(sql`${t.transferGroupId} is not null`),
    check("transactions_amount_positive", sql`${t.amountMinor} > 0`),
    check("transactions_type_valid", sql`${t.type} in ('income', 'expense', 'transfer')`),
    check("transactions_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check(
      "transactions_source_valid",
      sql`${t.source} in ('manual', 'receipt', 'statement', 'recurring')`,
    ),
    // Transfer ⇔ grup + sens, fără categorie.
    check(
      "transactions_transfer_shape",
      sql`(${t.type} = 'transfer') = (${t.transferGroupId} is not null) and (${t.type} = 'transfer') = (${t.transferDirection} is not null) and (${t.type} <> 'transfer' or ${t.categoryId} is null)`,
    ),
    check(
      "transactions_transfer_direction_valid",
      sql`${t.transferDirection} is null or ${t.transferDirection} in ('out', 'in')`,
    ),
    check(
      "transactions_occurred_on_range",
      sql`${t.occurredOn} between date '1900-01-01' and date '2999-12-31'`,
    ),
    check(
      "transactions_description_length",
      sql`${t.description} is null or char_length(${t.description}) <= 500`,
    ),
    check(
      "transactions_merchant_length",
      sql`${t.merchant} is null or char_length(${t.merchant}) <= 200`,
    ),
    check("transactions_notes_length", sql`${t.notes} is null or char_length(${t.notes}) <= 2000`),
    check(
      "transactions_external_ref_length",
      sql`${t.externalRef} is null or char_length(${t.externalRef}) between 1 and 200`,
    ),
  ],
);

/** Cheile `Idempotency-Key` ale mutațiilor `POST` (6.4); folosite de API în F2-B. */
export const idempotencyKeys = finet.table(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // sha256 hex al cererii (metodă, cale, corp normalizat).
    requestHash: text("request_hash").notNull(),
    // NULL cât timp cererea e în curs.
    response: jsonb("response"),
    statusCode: integer("status_code"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("idempotency_keys_household_key_key").on(t.householdId, t.key),
    index("idempotency_keys_created_at_idx").on(t.createdAt),
    check("idempotency_keys_key_format", sql`${t.key} ~ '^[A-Za-z0-9_-]{8,128}$'`),
    check("idempotency_keys_request_hash_format", sql`${t.requestHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "idempotency_keys_status_code_range",
      sql`${t.statusCode} is null or ${t.statusCode} between 100 and 599`,
    ),
  ],
);

/** Instalările clienților (6.5), actualizate din antetul `X-FINET-Client` (F2-B). */
export const clientInstallations = finet.table(
  "client_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: CLIENT_PLATFORMS }).notNull(),
    appVersion: text("app_version"),
    versionCode: integer("version_code"),
    osVersion: text("os_version"),
    deviceModel: text("device_model"),
    locale: text("locale"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    // Unic per utilizator, nu global: un utilizator nu poate „ocupa” id-ul instalării altuia și nu
    // află din conflict că acel id există (decizia revizuirii F2-A).
    unique("client_installations_user_installation_key").on(t.userId, t.installationId),
    check("client_installations_platform_valid", sql`${t.platform} in ('android', 'web')`),
    check(
      "client_installations_app_version_format",
      sql`${t.appVersion} is null or ${t.appVersion} ~ '^[0-9A-Za-z.+_-]{1,32}$'`,
    ),
    check(
      "client_installations_version_code_range",
      sql`${t.versionCode} is null or ${t.versionCode} between 0 and 2100000000`,
    ),
    check(
      "client_installations_os_version_length",
      sql`${t.osVersion} is null or char_length(${t.osVersion}) <= 64`,
    ),
    check(
      "client_installations_device_model_length",
      sql`${t.deviceModel} is null or char_length(${t.deviceModel}) <= 64`,
    ),
    check(
      "client_installations_locale_format",
      sql`${t.locale} is null or ${t.locale} ~ '^[a-z]{2}(-[A-Z]{2})?$'`,
    ),
    check("client_installations_seen_order", sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
  ],
);

/**
 * Evenimentele de utilizare (6.5): doar identificatori tehnici, fără sume, descrieri,
 * comercianți sau text liber (CHECK-uri pe format; lista fixă de nume e validată cu Zod în F2-B).
 */
export const appEvents = finet.table(
  "app_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    householdId: uuid("household_id").references(() => households.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id"),
    name: text("name").notNull(),
    screen: text("screen"),
    errorCode: text("error_code"),
    appVersion: text("app_version"),
    occurredAt: ts("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("app_events_occurred_at_idx").on(t.occurredAt),
    index("app_events_user_id_idx").on(t.userId),
    index("app_events_household_id_idx").on(t.householdId),
    check("app_events_name_format", sql`${t.name} ~ '^[a-z][a-z0-9_.]{1,63}$'`),
    check("app_events_screen_format", sql`${t.screen} is null or ${t.screen} ~ '^[a-z][a-z0-9_.]{0,63}$'`),
    check(
      "app_events_error_code_format",
      sql`${t.errorCode} is null or ${t.errorCode} ~ '^[a-z][a-z0-9_.]{0,63}$'`,
    ),
    check(
      "app_events_app_version_format",
      sql`${t.appVersion} is null or ${t.appVersion} ~ '^[0-9A-Za-z.+_-]{1,32}$'`,
    ),
  ],
);

/** Descărcările APK din pagina FINET (6.5). */
export const appDownloads = finet.table(
  "app_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    version: text("version").notNull(),
    source: text("source", { enum: DOWNLOAD_SOURCES }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("app_downloads_created_at_idx").on(t.createdAt),
    index("app_downloads_user_id_idx").on(t.userId),
    check("app_downloads_version_format", sql`${t.version} ~ '^[0-9A-Za-z.+_-]{1,32}$'`),
    check("app_downloads_source_valid", sql`${t.source} in ('finet_page', 'qr')`),
  ],
);
