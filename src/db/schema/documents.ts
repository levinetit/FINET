import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
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
import { categories } from "./ledger";

/**
 * Faza 6 — ingestia documentelor (bonuri): master prompt 3.6, 5.5, 6.1, 6.3; ADR 0013.
 *
 * Migrația: `src/db/migrations/0008_documents.sql` (DDL-ul de aici, generat de drizzle-kit, plus
 * partea scrisă de mână: cheile compuse cu `SET NULL (coloană)`, cheia
 * `transactions.document_id` → documente, triggerele de integritate, funcția
 * `queued_documents` (SECURITY DEFINER), RLS (ENABLE + FORCE) și drepturile minime).
 *
 * Nu sunt declarate aici (drizzle-kit nu exprimă `SET NULL (coloană)`), ci în partea de mână:
 * - `documents_batch_fk`: (batch_id, household_id) → processing_batches, `SET NULL (batch_id)`;
 * - `documents_duplicate_of_fk`: (possible_duplicate_of_id, household_id) → documents,
 *   `SET NULL (possible_duplicate_of_id)`;
 * - `receipts_transaction_fk`: (transaction_id, household_id) → transactions,
 *   `SET NULL (transaction_id)`;
 * - `ai_calls_document_fk`: (document_id, household_id) → documents, `SET NULL (document_id)`;
 * - `transactions_document_fk`: (document_id, household_id) → documents, `SET NULL (document_id)`
 *   (`NOT VALID` + `VALIDATE`; 5.6: tranzacțiile create din document rămân, fără legătură).
 */

export const DOCUMENT_KINDS = ["receipt", "statement", "other"] as const;
export const DOCUMENT_STATUSES = [
  "uploaded",
  "awaiting_consent",
  "queued",
  "processing",
  "needs_review",
  "done",
  "failed",
  "rejected",
] as const;
/** Tipurile acceptate, detectate după conținut (magic bytes), nu după extensie. */
export const DOCUMENT_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const BATCH_KINDS = ["single", "long_receipt"] as const;
export const BATCH_STATUSES = ["queued", "processing", "needs_review", "done", "failed"] as const;
export const RECEIPT_STATUSES = ["queued", "needs_review", "saved", "failed"] as const;
export const AI_PROVIDERS_USED = ["none", "local", "external"] as const;
/** De ce s-a trecut (sau nu) la furnizorul extern (3.6, „fiecare bon păstrează motivul”). */
export const FALLBACK_REASONS = [
  "local_unavailable",
  "local_timeout",
  "local_failed_validation",
  "low_confidence",
  "no_local_model",
  "consent_missing",
  "budget_exceeded",
  "daily_limit",
  "external_failed",
  // 0009 (F6-B): AI neconfigurat (`AI_BASE_URL`/cheia lipsesc) → introducere manuală.
  "ai_unconfigured",
] as const;
export const RECEIPT_LINE_KINDS = ["product", "discount", "deposit_sgr", "bag", "other"] as const;
export const PAYMENT_METHODS = ["cash", "card", "voucher", "mixed", "other"] as const;
export const AI_TASKS = [
  "receipt_extract",
  "categorize",
  "statement_extract",
  "list_match",
  "monthly_summary",
  "ask_finet",
] as const;
export const AI_PROVIDERS = ["local", "external"] as const;
export const AI_UNIT_KINDS = ["tokens", "pages"] as const;
export const AI_RESULTS = ["ok", "failed_validation", "timeout", "fallback", "error"] as const;

/** Plafoanele (decizia mea, ADR 0013). */
export const DOCUMENT_MAX_SIZE_BYTES = 100 * 1024 * 1024;
export const DOCUMENT_MAX_PAGES = 100;
export const DOCUMENT_MAX_ATTEMPTS = 10;
export const BATCH_MAX_DOCUMENTS = 4;
export const RECEIPT_MAX_LINES = 500;
export const PRODUCT_ALIAS_MAX_TAGS = 10;

const minor = (name: string) => bigint(name, { mode: "bigint" });
const day = (name: string) => date(name, { mode: "string" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Loturile de procesare: 1 document (`single`) sau 2–4 poze ale aceluiași bon lung
 * (`long_receipt`), în ordinea `documents.document_order`.
 */
export const processingBatches = finet.table(
  "processing_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: text("kind", { enum: BATCH_KINDS }).notNull(),
    status: text("status", { enum: BATCH_STATUSES }).notNull().default("queued"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("processing_batches_id_household_key").on(t.id, t.householdId),
    index("processing_batches_household_status_idx").on(t.householdId, t.status),
    index("processing_batches_created_by_user_id_idx").on(t.createdByUserId),
    check("processing_batches_kind_valid", sql`${t.kind} in ('single', 'long_receipt')`),
    check(
      "processing_batches_status_valid",
      sql`${t.status} in ('queued', 'processing', 'needs_review', 'done', 'failed')`,
    ),
  ],
);

/**
 * Documentele încărcate (bonuri; extrasele din Faza 7). Fișierul stă în storage sub cheia
 * `households/<household_id>/documents/<id>` (legată de rând printr-un CHECK, deci un rând nu
 * poate indica fișierul altei gospodării). `storage_key` devine NULL când fișierul e șters la
 * expirarea retenției (`file_deleted_at`); datele extrase rămân.
 */
export const documents = finet.table(
  "documents",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull().default("receipt"),
    status: text("status", { enum: DOCUMENT_STATUSES }).notNull().default("uploaded"),
    storageKey: text("storage_key"),
    /** Tipul declarat de client (doar informativ; NU decide nimic). */
    originalMime: text("original_mime"),
    /** Tipul detectat de server după conținut. */
    detectedMime: text("detected_mime", { enum: DOCUMENT_MIMES }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    pages: integer("pages"),
    sha256: text("sha256").notNull(),
    /** dHash pe 64 de biți (ca `bigint` cu semn), calculat de worker la preprocesare. */
    perceptualHash: bigint("perceptual_hash", { mode: "bigint" }),
    possibleDuplicateOfId: uuid("possible_duplicate_of_id"),
    batchId: uuid("batch_id"),
    documentOrder: smallint("document_order"),
    errorCode: text("error_code"),
    attempts: smallint("attempts").notNull().default(0),
    processingStartedAt: ts("processing_started_at"),
    expiresAt: ts("expires_at"),
    fileDeletedAt: ts("file_deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Ținta cheilor compuse (receipts, ai_calls, transactions, duplicatele): aceeași gospodărie.
    unique("documents_id_household_key").on(t.id, t.householdId),
    // Deduplicarea exactă (6.1): același fișier o singură dată pe gospodărie.
    unique("documents_household_sha256_key").on(t.householdId, t.sha256),
    unique("documents_storage_key_key").on(t.storageKey),
    unique("documents_batch_order_key").on(t.batchId, t.documentOrder),
    index("documents_household_status_idx").on(t.householdId, t.status),
    index("documents_household_created_idx").on(t.householdId, t.createdAt.desc()),
    index("documents_uploaded_by_user_id_idx").on(t.uploadedByUserId),
    index("documents_batch_id_idx").on(t.batchId),
    index("documents_possible_duplicate_of_id_idx").on(t.possibleDuplicateOfId),
    index("documents_perceptual_idx")
      .on(t.householdId)
      .where(sql`${t.perceptualHash} is not null`),
    // Selecția workerului (`queued_documents`).
    index("documents_pending_idx")
      .on(t.createdAt, t.id)
      .where(sql`${t.status} in ('queued', 'processing')`),
    check("documents_kind_valid", sql`${t.kind} in ('receipt', 'statement', 'other')`),
    check(
      "documents_status_valid",
      sql`${t.status} in ('uploaded', 'awaiting_consent', 'queued', 'processing', 'needs_review', 'done', 'failed', 'rejected')`,
    ),
    check(
      "documents_storage_key_shape",
      sql`${t.storageKey} is null or ${t.storageKey} = 'households/' || ${t.householdId}::text || '/documents/' || ${t.id}::text`,
    ),
    check(
      "documents_file_deleted_shape",
      sql`(${t.storageKey} is null) = (${t.fileDeletedAt} is not null)`,
    ),
    check(
      "documents_original_mime_shape",
      sql`${t.originalMime} is null or (char_length(${t.originalMime}) <= 100 and ${t.originalMime} ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$')`,
    ),
    check(
      "documents_detected_mime_valid",
      sql`${t.detectedMime} in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')`,
    ),
    check("documents_size_range", sql`${t.sizeBytes} between 1 and 104857600`),
    check("documents_pages_range", sql`${t.pages} is null or ${t.pages} between 1 and 100`),
    check("documents_sha256_format", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "documents_duplicate_not_self",
      sql`${t.possibleDuplicateOfId} is null or ${t.possibleDuplicateOfId} <> ${t.id}`,
    ),
    check(
      "documents_batch_order_shape",
      sql`(${t.batchId} is null) = (${t.documentOrder} is null) and (${t.documentOrder} is null or ${t.documentOrder} between 1 and 4)`,
    ),
    check(
      "documents_error_code_format",
      sql`${t.errorCode} is null or ${t.errorCode} ~ '^[a-z][a-z0-9_]{1,63}$'`,
    ),
    check("documents_attempts_range", sql`${t.attempts} between 0 and 10`),
  ],
);

/**
 * Bonurile extrase (5.5). Sumele în unități minore; `confidence` 0..100 (scorul calculat în
 * cod, nu de LLM). `dedup_key` = rezumatul (CUI, număr, dată, total), completat după extragere
 * (F6-B): unic pe gospodărie, deci același bon fotografiat din nou nu se salvează de două ori.
 */
export const receipts = finet.table(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    documentId: uuid("document_id"),
    batchId: uuid("batch_id"),
    merchantName: text("merchant_name"),
    merchantTaxId: text("merchant_tax_id"),
    storeAddress: text("store_address"),
    receiptNumber: text("receipt_number"),
    occurredOn: day("occurred_on"),
    paymentMethod: text("payment_method", { enum: PAYMENT_METHODS }),
    totalMinor: minor("total_minor"),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull().default("RON"),
    vatTotalMinor: minor("vat_total_minor"),
    status: text("status", { enum: RECEIPT_STATUSES }).notNull().default("queued"),
    confidence: smallint("confidence"),
    providerUsed: text("provider_used", { enum: AI_PROVIDERS_USED }).notNull().default("none"),
    fallbackReason: text("fallback_reason", { enum: FALLBACK_REASONS }),
    transactionId: uuid("transaction_id"),
    dedupKey: text("dedup_key"),
    /** Textul citit (pentru căutare, 6.1); nu apare în loguri. */
    ocrText: text("ocr_text"),
    /**
     * 0009 (F6-B): problemele găsite de verificările din cod (coduri stabile, `checks.ts`), afișate
     * pe ecranul de verificare. Listă JSON de `{ code, field?, line? }`, ≤ 100.
     */
    issues: jsonb("issues")
      .$type<ReadonlyArray<{ code: string; field?: string; line?: number }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** 0009: „același bon fotografiat din nou” (CUI + număr + dată + total) → bonul original. */
    duplicateOfReceiptId: uuid("duplicate_of_receipt_id"),
    /** 0009: raportul unirii unui bon lung (liniile eliminate și motivul, ordinea propusă). */
    mergeReport: jsonb("merge_report").$type<Readonly<Record<string, unknown>>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("receipts_id_household_key").on(t.id, t.householdId),
    // Ștergerea documentului (sau a lotului) șterge bonul extras; tranzacția rămâne.
    foreignKey({
      name: "receipts_document_fk",
      columns: [t.documentId, t.householdId],
      foreignColumns: [documents.id, documents.householdId],
    }).onDelete("cascade"),
    foreignKey({
      name: "receipts_batch_fk",
      columns: [t.batchId, t.householdId],
      foreignColumns: [processingBatches.id, processingBatches.householdId],
    }).onDelete("cascade"),
    uniqueIndex("receipts_document_key")
      .on(t.documentId)
      .where(sql`${t.documentId} is not null`),
    uniqueIndex("receipts_batch_key")
      .on(t.batchId)
      .where(sql`${t.batchId} is not null`),
    uniqueIndex("receipts_household_dedup_key")
      .on(t.householdId, t.dedupKey)
      .where(sql`${t.dedupKey} is not null`),
    index("receipts_household_status_idx").on(t.householdId, t.status),
    index("receipts_transaction_id_idx").on(t.transactionId),
    index("receipts_ocr_text_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${t.ocrText}, ''))`,
    ),
    check("receipts_source_present", sql`${t.documentId} is not null or ${t.batchId} is not null`),
    check(
      "receipts_merchant_name_length",
      sql`${t.merchantName} is null or char_length(${t.merchantName}) <= 200`,
    ),
    check(
      "receipts_merchant_tax_id_format",
      sql`${t.merchantTaxId} is null or ${t.merchantTaxId} ~ '^(RO)?[0-9]{2,10}$'`,
    ),
    check(
      "receipts_store_address_length",
      sql`${t.storeAddress} is null or char_length(${t.storeAddress}) <= 300`,
    ),
    check(
      "receipts_receipt_number_length",
      sql`${t.receiptNumber} is null or char_length(${t.receiptNumber}) between 1 and 64`,
    ),
    check(
      "receipts_occurred_on_range",
      sql`${t.occurredOn} is null or ${t.occurredOn} between date '1900-01-01' and date '2999-12-31'`,
    ),
    check(
      "receipts_payment_method_valid",
      sql`${t.paymentMethod} is null or ${t.paymentMethod} in ('cash', 'card', 'voucher', 'mixed', 'other')`,
    ),
    check(
      "receipts_total_range",
      sql`${t.totalMinor} is null or ${t.totalMinor} between 0 and 10000000000000`,
    ),
    check(
      "receipts_vat_total_range",
      sql`${t.vatTotalMinor} is null or ${t.vatTotalMinor} between 0 and 10000000000000`,
    ),
    check("receipts_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check(
      "receipts_status_valid",
      sql`${t.status} in ('queued', 'needs_review', 'saved', 'failed')`,
    ),
    check(
      "receipts_confidence_range",
      sql`${t.confidence} is null or ${t.confidence} between 0 and 100`,
    ),
    check("receipts_provider_used_valid", sql`${t.providerUsed} in ('none', 'local', 'external')`),
    check(
      "receipts_fallback_reason_valid",
      sql`${t.fallbackReason} is null or ${t.fallbackReason} in ('local_unavailable', 'local_timeout', 'local_failed_validation', 'low_confidence', 'no_local_model', 'consent_missing', 'budget_exceeded', 'daily_limit', 'external_failed', 'ai_unconfigured')`,
    ),
    check(
      "receipts_dedup_key_format",
      sql`${t.dedupKey} is null or ${t.dedupKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "receipts_ocr_text_length",
      sql`${t.ocrText} is null or char_length(${t.ocrText}) <= 20000`,
    ),
    index("receipts_duplicate_of_receipt_id_idx").on(t.duplicateOfReceiptId),
    check(
      "receipts_issues_shape",
      sql`jsonb_typeof(${t.issues}) = 'array' and jsonb_array_length(${t.issues}) <= 100 and pg_column_size(${t.issues}) <= 16384`,
    ),
    check(
      "receipts_merge_report_shape",
      sql`${t.mergeReport} is null or (jsonb_typeof(${t.mergeReport}) = 'object' and pg_column_size(${t.mergeReport}) <= 32768)`,
    ),
    check(
      "receipts_duplicate_not_self",
      sql`${t.duplicateOfReceiptId} is null or ${t.duplicateOfReceiptId} <> ${t.id}`,
    ),
  ],
);

/**
 * Liniile bonului (5.5). `line_total_minor` vine de pe bon (nu se recalculează din cantitate ×
 * preț) și e mereu ≥ 0; semnul îl dă `kind` (o reducere scade). Cantitatea: `numeric(12,3)`.
 */
export const receiptLines = finet.table(
  "receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id").notNull(),
    householdId: uuid("household_id").notNull(),
    position: smallint("position").notNull(),
    rawName: text("raw_name").notNull(),
    normalizedName: text("normalized_name"),
    quantity: numeric("quantity", { precision: 12, scale: 3 }),
    unitPriceMinor: minor("unit_price_minor"),
    lineTotalMinor: minor("line_total_minor").notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    categoryId: uuid("category_id"),
    kind: text("kind", { enum: RECEIPT_LINE_KINDS }).notNull().default("product"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "receipt_lines_receipt_fk",
      columns: [t.receiptId, t.householdId],
      foreignColumns: [receipts.id, receipts.householdId],
    }).onDelete("cascade"),
    foreignKey({
      name: "receipt_lines_category_id_fk",
      columns: [t.categoryId],
      foreignColumns: [categories.id],
    }).onDelete("set null"),
    unique("receipt_lines_receipt_position_key").on(t.receiptId, t.position),
    // Ținta cheii compuse din `shopping_list_items` (F10-A, 0017): linia și gospodăria ei.
    unique("receipt_lines_id_household_key").on(t.id, t.householdId),
    index("receipt_lines_household_id_idx").on(t.householdId),
    index("receipt_lines_category_id_idx").on(t.categoryId),
    check("receipt_lines_position_range", sql`${t.position} between 1 and 500`),
    check("receipt_lines_raw_name_length", sql`char_length(${t.rawName}) between 1 and 300`),
    check(
      "receipt_lines_normalized_name_length",
      sql`${t.normalizedName} is null or char_length(${t.normalizedName}) between 1 and 300`,
    ),
    check(
      "receipt_lines_quantity_range",
      sql`${t.quantity} is null or (${t.quantity} > 0 and ${t.quantity} < 1000000000)`,
    ),
    check(
      "receipt_lines_unit_price_range",
      sql`${t.unitPriceMinor} is null or ${t.unitPriceMinor} between 0 and 10000000000000`,
    ),
    check("receipt_lines_total_range", sql`${t.lineTotalMinor} between 0 and 10000000000000`),
    check(
      "receipt_lines_vat_rate_range",
      sql`${t.vatRate} is null or ${t.vatRate} between 0 and 100`,
    ),
    check(
      "receipt_lines_kind_valid",
      sql`${t.kind} in ('product', 'discount', 'deposit_sgr', 'bag', 'other')`,
    ),
  ],
);

/**
 * Ce a corectat utilizatorul (3.6): numele normalizat al produsului → categoria (și etichete).
 * Primul pas al categorisirii; așa același produs nu mai trece prin LLM.
 */
export const productAliases = finet.table(
  "product_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    normalizedName: text("normalized_name").notNull(),
    categoryId: uuid("category_id").notNull(),
    tagIds: uuid("tag_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("product_aliases_household_name_key").on(t.householdId, t.normalizedName),
    foreignKey({
      name: "product_aliases_category_id_fk",
      columns: [t.categoryId],
      foreignColumns: [categories.id],
    }).onDelete("cascade"),
    index("product_aliases_category_id_idx").on(t.categoryId),
    check(
      "product_aliases_normalized_name_length",
      sql`char_length(${t.normalizedName}) >= 1 and char_length(${t.normalizedName}) <= 300 and ${t.normalizedName} = btrim(${t.normalizedName})`,
    ),
    check(
      "product_aliases_tag_ids_count",
      sql`cardinality(${t.tagIds}) <= 10 and array_position(${t.tagIds}, null) is null`,
    ),
  ],
);

/**
 * Apelurile AI (3.6): DOAR metadate (sarcina, alias-ul modelului, local/extern, unități, cost
 * estimat, durată, rezultat), fără imagini, text sau răspunsuri. Jurnal: doar SELECT + INSERT.
 */
export const aiCalls = finet.table(
  "ai_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    documentId: uuid("document_id"),
    task: text("task", { enum: AI_TASKS }).notNull(),
    modelAlias: text("model_alias").notNull(),
    provider: text("provider", { enum: AI_PROVIDERS }).notNull(),
    units: integer("units"),
    unitsKind: text("units_kind", { enum: AI_UNIT_KINDS }),
    costEstimateMinor: minor("cost_estimate_minor"),
    costCurrency: text("cost_currency", { enum: DB_CURRENCIES }),
    durationMs: integer("duration_ms").notNull(),
    result: text("result", { enum: AI_RESULTS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_calls_household_created_idx").on(t.householdId, t.createdAt),
    index("ai_calls_document_id_idx").on(t.documentId),
    index("ai_calls_external_created_idx")
      .on(t.createdAt)
      .where(sql`${t.provider} = 'external'`),
    check(
      "ai_calls_task_valid",
      sql`${t.task} in ('receipt_extract', 'categorize', 'statement_extract', 'list_match', 'monthly_summary', 'ask_finet')`,
    ),
    check("ai_calls_model_alias_format", sql`${t.modelAlias} ~ '^[a-z0-9][a-z0-9._:/-]{0,99}$'`),
    check("ai_calls_provider_valid", sql`${t.provider} in ('local', 'external')`),
    check(
      "ai_calls_units_shape",
      sql`(${t.units} is null) = (${t.unitsKind} is null) and (${t.units} is null or ${t.units} between 0 and 100000000) and (${t.unitsKind} is null or ${t.unitsKind} in ('tokens', 'pages'))`,
    ),
    check(
      "ai_calls_cost_shape",
      sql`(${t.costEstimateMinor} is null) = (${t.costCurrency} is null) and (${t.costEstimateMinor} is null or ${t.costEstimateMinor} between 0 and 10000000000000) and (${t.costCurrency} is null or ${t.costCurrency} in ('RON', 'EUR', 'USD'))`,
    ),
    check("ai_calls_duration_range", sql`${t.durationMs} between 0 and 3600000`),
    check(
      "ai_calls_result_valid",
      sql`${t.result} in ('ok', 'failed_validation', 'timeout', 'fallback', 'error')`,
    ),
  ],
);

/**
 * Contorul zilnic al documentelor încărcate (`AI_DAILY_DOCUMENT_LIMIT`), pe gospodărie și pe zi
 * locală (`Europe/Bucharest`). Doar crește, în aceeași tranzacție cu încărcarea: ștergerea unui
 * document NU eliberează limita zilei (revizuirea de securitate F6-A, M3). Fără conținut.
 */
export const documentUsageDaily = finet.table(
  "document_usage_daily",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    day: day("day").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "document_usage_daily_pkey", columns: [t.householdId, t.day] }),
    check("document_usage_daily_count_range", sql`${t.count} between 0 and 1000000`),
    check(
      "document_usage_daily_day_range",
      sql`${t.day} between date '2000-01-01' and date '2999-12-31'`,
    ),
  ],
);

/**
 * 0009 (F6-B): cotele de TVA pentru VALIDARE (master prompt 5.5: „se configurează în date, nu în
 * cod”), cu perioada de valabilitate. Doar citire pentru `finet_app`; se schimbă printr-o
 * migrație. Cota în puncte de bază (21,00% = 2100).
 */
export const vatRates = finet.table(
  "vat_rates",
  {
    country: text("country").notNull().default("RO"),
    rateBp: integer("rate_bp").notNull(),
    validFrom: day("valid_from").notNull(),
    validTo: day("valid_to"),
  },
  (t) => [
    primaryKey({ name: "vat_rates_pkey", columns: [t.country, t.rateBp, t.validFrom] }),
    check("vat_rates_country_format", sql`${t.country} ~ '^[A-Z]{2}$'`),
    check("vat_rates_rate_range", sql`${t.rateBp} between 0 and 10000`),
    check("vat_rates_period", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

/**
 * 0009 (F6-B): bugetul lunar GLOBAL pentru furnizorii AI externi (`AI_MONTHLY_BUDGET`), pe luna
 * locală (`Europe/Bucharest`) și monedă. Contor care DOAR crește (rezervarea pesimistă de dinaintea
 * fiecărei încercări), independent de gospodării: ștergerea unei gospodării (care șterge
 * `ai_calls` în cascadă) nu eliberează bugetul. `finet_app` NU are niciun drept pe tabel: îl
 * atinge doar prin funcțiile SECURITY DEFINER `ai_budget_reserve` / `ai_budget_spent`.
 */
export const aiBudgetUsage = finet.table(
  "ai_budget_usage",
  {
    month: day("month").notNull(),
    currency: text("currency", { enum: DB_CURRENCIES }).notNull(),
    reservedMinor: minor("reserved_minor")
      .notNull()
      .default(sql`0`),
    calls: integer("calls").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "ai_budget_usage_pkey", columns: [t.month, t.currency] }),
    check("ai_budget_usage_month_first_day", sql`extract(day from ${t.month}) = 1`),
    check("ai_budget_usage_currency_valid", sql`${t.currency} in ('RON', 'EUR', 'USD')`),
    check("ai_budget_usage_reserved_range", sql`${t.reservedMinor} between 0 and 10000000000000`),
    check("ai_budget_usage_calls_range", sql`${t.calls} between 0 and 100000000`),
  ],
);
