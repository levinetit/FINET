import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { receipts } from "./documents";
import { createdAt, finet, updatedAt } from "./finet";
import { households } from "./households";

/**
 * Faza 10 (F10-A) — listele de cumpărături și comparația listă ↔ bon (master prompt 6.1 „Liste de
 * cumpărături”, Faza 10, 3.6); ADR 0022.
 *
 * Migrația: `src/db/migrations/0017_shopping_lists.sql` (DDL-ul de aici, generat de drizzle-kit,
 * plus partea scrisă de mână: cheia `shopping_list_items_line_fk` cu `ON DELETE SET NULL
 * (matched_receipt_line_id)`, cheia unică `receipt_lines_id_household_key`, triggerele de
 * plafon/schimbare de proprietar, funcțiile SECURITY DEFINER ale cozii AI și ale ștergerii
 * contului, RLS ENABLE + FORCE, politicile cu vizibilitatea personal/comun și drepturile minime).
 *
 * Cheia `shopping_list_items_line_fk` NU e declarată aici: drizzle-kit nu exprimă `SET NULL
 * (coloană)` (PG 15+), iar un `SET NULL` simplu ar pune NULL și pe `household_id` (precedent:
 * `goals_account_fk`, `statement_uploads_import_fk`).
 *
 * CHECK-urile sunt comparații PLATE (fără BETWEEN într-un lanț AND, fără operator imbricat de
 * același tip), ca amprenta pg_dump să rămână stabilă (lecția Fazelor 3–9).
 */

export const SHOPPING_LIST_STATUSES = ["active", "archived"] as const;
export const SHOPPING_MATCH_STATUSES = ["none", "suggested", "confirmed", "rejected"] as const;
export const SHOPPING_MATCH_SOURCES = ["code", "learned", "ai", "manual"] as const;
export const SHOPPING_AI_REQUEST_STATUSES = [
  "queued",
  "processing",
  "done",
  "failed",
  "skipped",
] as const;

/** Plafoanele (decizia mea, ADR 0022): protejează resursele, nu sunt limite de produs. */
export const SHOPPING_LIST_NAME_MAX = 100;
export const SHOPPING_ITEM_NAME_MAX = 120;
export const SHOPPING_ITEM_UNIT_MAX = 20;
export const SHOPPING_ITEM_NOTE_MAX = 200;
/** Liste pe gospodărie, numărate din cele VIZIBILE celui care creează (comune + ale lui). */
export const SHOPPING_MAX_LISTS = 100;
export const SHOPPING_MAX_ITEMS_PER_LIST = 300;
export const SHOPPING_AI_MAX_ATTEMPTS = 3;

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * O listă de cumpărături. `owner_user_id` NULL = listă COMUNĂ (o văd și o schimbă toți membrii);
 * = X = listă PERSONALĂ a lui X, vizibilă DOAR lui (ca la conturi, ADR 0016). Ștergerea
 * utilizatorului șterge listele lui personale (CASCADE): SET NULL le-ar face comune.
 */
export const shoppingLists = finet.table(
  "shopping_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: SHOPPING_LIST_STATUSES }).notNull().default("active"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("shopping_lists_id_household_key").on(t.id, t.householdId),
    index("shopping_lists_household_status_idx").on(t.householdId, t.status),
    index("shopping_lists_owner_user_id_idx").on(t.ownerUserId),
    index("shopping_lists_created_by_idx").on(t.createdByUserId),
    check(
      "shopping_lists_name_length",
      sql`char_length(${t.name}) >= 1 and char_length(${t.name}) <= 100`,
    ),
    check("shopping_lists_name_trimmed", sql`${t.name} = btrim(${t.name})`),
    check("shopping_lists_status_valid", sql`${t.status} in ('active', 'archived')`),
  ],
);

/**
 * Un articol al listei. `quantity` e `numeric(9,3)` (șir în TypeScript, niciodată `Number`).
 * `matched_receipt_line_id` + `match_*`: rezultatul comparației cu un bon (propunere, confirmare,
 * respingere); NICIODATĂ nu modifică bonul sau tranzacția. Când linia de bon dispare (bon
 * șters), cheia compusă pune NULL doar pe `matched_receipt_line_id`, iar starea rămâne.
 */
export const shoppingListItems = finet.table(
  "shopping_list_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listId: uuid("list_id").notNull(),
    householdId: uuid("household_id").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    quantity: numeric("quantity", { precision: 9, scale: 3 }).notNull().default("1"),
    unit: text("unit"),
    note: text("note"),
    checked: boolean("checked").notNull().default(false),
    checkedByUserId: uuid("checked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    checkedAt: ts("checked_at"),
    position: integer("position").notNull().default(0),
    matchedReceiptLineId: uuid("matched_receipt_line_id"),
    matchStatus: text("match_status", { enum: SHOPPING_MATCH_STATUSES }).notNull().default("none"),
    matchScore: smallint("match_score"),
    matchSource: text("match_source", { enum: SHOPPING_MATCH_SOURCES }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "shopping_list_items_list_fk",
      columns: [t.listId, t.householdId],
      foreignColumns: [shoppingLists.id, shoppingLists.householdId],
    }).onDelete("cascade"),
    index("shopping_list_items_list_position_idx").on(t.listId, t.position),
    index("shopping_list_items_household_id_idx").on(t.householdId),
    index("shopping_list_items_checked_by_idx").on(t.checkedByUserId),
    index("shopping_list_items_line_idx")
      .on(t.matchedReceiptLineId)
      .where(sql`${t.matchedReceiptLineId} is not null`),
    // O linie de bon e propusă/confirmată pentru cel mult UN articol al aceleiași liste.
    uniqueIndex("shopping_list_items_line_key")
      .on(t.listId, t.matchedReceiptLineId)
      .where(sql`${t.matchStatus} = 'suggested' or ${t.matchStatus} = 'confirmed'`),
    check(
      "shopping_list_items_name_length",
      sql`char_length(${t.name}) >= 1 and char_length(${t.name}) <= 120`,
    ),
    check("shopping_list_items_name_trimmed", sql`${t.name} = btrim(${t.name})`),
    check(
      "shopping_list_items_normalized_name_length",
      sql`char_length(${t.normalizedName}) >= 1 and char_length(${t.normalizedName}) <= 300`,
    ),
    check("shopping_list_items_quantity_range", sql`${t.quantity} > 0 and ${t.quantity} < 1000000`),
    check(
      "shopping_list_items_unit_length",
      sql`${t.unit} is null or (char_length(${t.unit}) >= 1 and char_length(${t.unit}) <= 20)`,
    ),
    check(
      "shopping_list_items_note_length",
      sql`${t.note} is null or (char_length(${t.note}) >= 1 and char_length(${t.note}) <= 200)`,
    ),
    check(
      "shopping_list_items_position_range",
      sql`${t.position} >= 0 and ${t.position} <= 100000`,
    ),
    // `checked_at` există exact cât timp articolul e bifat (`checked_by` poate fi NULL după
    // ștergerea utilizatorului).
    check("shopping_list_items_checked_shape", sql`(${t.checkedAt} is not null) = ${t.checked}`),
    check(
      "shopping_list_items_match_status_valid",
      sql`${t.matchStatus} in ('none', 'suggested', 'confirmed', 'rejected')`,
    ),
    check(
      "shopping_list_items_match_source_valid",
      sql`${t.matchSource} is null or ${t.matchSource} in ('code', 'learned', 'ai', 'manual')`,
    ),
    check(
      "shopping_list_items_match_score_range",
      sql`${t.matchScore} is null or (${t.matchScore} >= 0 and ${t.matchScore} <= 100)`,
    ),
    // Fără potrivire (`none`) nu există linie, scor sau sursă. Sens unic, ca `SET NULL` pe linie
    // (la ștergerea bonului) să nu poată încălca niciodată constrângerea.
    check(
      "shopping_list_items_none_shape",
      sql`${t.matchStatus} <> 'none' or (${t.matchedReceiptLineId} is null and ${t.matchScore} is null and ${t.matchSource} is null)`,
    ),
  ],
);

/**
 * Coada pasului OPȚIONAL cu LLM al comparației (3.6: perechile ambigue). Un rând per (listă,
 * bon); nu conține nume, texte sau răspunsuri, doar starea. Workerul (singurul care are cheia
 * AI) le găsește prin `finet.queued_list_matches` (doar identificatori) și lucrează în contextul
 * RLS al gospodăriei, în numele celui care a cerut comparația.
 */
export const shoppingListAiRequests = finet.table(
  "shopping_list_ai_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id").notNull(),
    listId: uuid("list_id").notNull(),
    receiptId: uuid("receipt_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: SHOPPING_AI_REQUEST_STATUSES }).notNull().default("queued"),
    attempts: smallint("attempts").notNull().default(0),
    errorCode: text("error_code"),
    processingStartedAt: ts("processing_started_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "shopping_list_ai_requests_list_fk",
      columns: [t.listId, t.householdId],
      foreignColumns: [shoppingLists.id, shoppingLists.householdId],
    }).onDelete("cascade"),
    foreignKey({
      name: "shopping_list_ai_requests_receipt_fk",
      columns: [t.receiptId, t.householdId],
      foreignColumns: [receipts.id, receipts.householdId],
    }).onDelete("cascade"),
    unique("shopping_list_ai_requests_list_receipt_key").on(t.listId, t.receiptId),
    index("shopping_list_ai_requests_status_created_idx").on(t.status, t.createdAt),
    index("shopping_list_ai_requests_household_id_idx").on(t.householdId),
    index("shopping_list_ai_requests_receipt_id_idx").on(t.receiptId),
    index("shopping_list_ai_requests_requested_by_idx").on(t.requestedByUserId),
    check(
      "shopping_list_ai_requests_status_valid",
      sql`${t.status} in ('queued', 'processing', 'done', 'failed', 'skipped')`,
    ),
    check(
      "shopping_list_ai_requests_attempts_range",
      sql`${t.attempts} >= 0 and ${t.attempts} <= 3`,
    ),
    check(
      "shopping_list_ai_requests_error_code_format",
      sql`${t.errorCode} is null or ${t.errorCode} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
  ],
);
