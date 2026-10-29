-- FINET 0008_documents (Faza 6, F6-A): documentele încărcate (bonuri), loturile de procesare,
-- bonurile extrase și liniile lor, alias-urile de produse (corecturile utilizatorului) și jurnalul
-- apelurilor AI (fără conținut), plus contorul zilnic al încărcărilor (`document_usage_daily`).
-- Prima parte e generată de `drizzle-kit generate --name documents` din src/db/schema/documents.ts
-- (`when` din jurnal fixat de mână la 1793600000000, după 0007). A doua parte (după „PARTEA SCRISĂ
-- DE MÂNĂ”) e adăugată o singură dată, înainte de prima aplicare: cheile compuse cu
-- `SET NULL (coloană)`, cheia `transactions.document_id` → documente, triggerele de integritate,
-- funcția `queued_documents` (SECURITY DEFINER), RLS (ENABLE + FORCE în aceeași migrație) și
-- drepturile minime ale lui finet_app. Deciziile: docs/adr/0013-receipts-ingest.md.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Consimțământul `external_ai` există deja în CHECK-ul `consents_kind_valid` (0000_core): nu e
-- nevoie de nicio modificare a tabelului `consents`.
--
-- Efect pe tabelele existente (doar `finet.transactions`, fără rescrierea datelor):
--   - cheia `transactions_document_fk` adăugată `NOT VALID`, apoi `VALIDATE` (verifică doar
--     rândurile cu `document_id` nenul; până acum coloana nu era scrisă de nimeni, deci 0);
--   - indexul parțial `transactions_document_id_idx` (doar rândurile cu document: gol acum).
--   Ambele iau un lock scurt pe `transactions` (scrierile așteaptă câteva milisecunde).
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE documentele, bonurile extrase,
-- alias-urile și jurnalul AI, dar NU tranzacțiile; fișierele din storage rămân pe disc și se
-- șterg separat, `households/*/documents/*`):
--   alter table finet.transactions drop constraint transactions_document_fk;
--   drop index finet.transactions_document_id_idx;
--   drop table finet.document_usage_daily, finet.receipt_lines, finet.receipts, finet.ai_calls, finet.product_aliases,
--     finet.documents, finet.processing_batches;
--   drop function finet.queued_documents(integer, integer), finet.receipt_lines_check_refs(),
--     finet.product_aliases_check_refs();
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0008_documents>';
-- (Politicile, triggerele și drepturile dispar odată cu tabelele.)
CREATE TABLE "finet"."ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"document_id" uuid,
	"task" text NOT NULL,
	"model_alias" text NOT NULL,
	"provider" text NOT NULL,
	"units" integer,
	"units_kind" text,
	"cost_estimate_minor" bigint,
	"cost_currency" text,
	"duration_ms" integer NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_calls_task_valid" CHECK ("finet"."ai_calls"."task" in ('receipt_extract', 'categorize', 'statement_extract', 'list_match', 'monthly_summary')),
	CONSTRAINT "ai_calls_model_alias_format" CHECK ("finet"."ai_calls"."model_alias" ~ '^[a-z0-9][a-z0-9._:/-]{0,99}$'),
	CONSTRAINT "ai_calls_provider_valid" CHECK ("finet"."ai_calls"."provider" in ('local', 'external')),
	CONSTRAINT "ai_calls_units_shape" CHECK (("finet"."ai_calls"."units" is null) = ("finet"."ai_calls"."units_kind" is null) and ("finet"."ai_calls"."units" is null or "finet"."ai_calls"."units" between 0 and 100000000) and ("finet"."ai_calls"."units_kind" is null or "finet"."ai_calls"."units_kind" in ('tokens', 'pages'))),
	CONSTRAINT "ai_calls_cost_shape" CHECK (("finet"."ai_calls"."cost_estimate_minor" is null) = ("finet"."ai_calls"."cost_currency" is null) and ("finet"."ai_calls"."cost_estimate_minor" is null or "finet"."ai_calls"."cost_estimate_minor" between 0 and 10000000000000) and ("finet"."ai_calls"."cost_currency" is null or "finet"."ai_calls"."cost_currency" in ('RON', 'EUR', 'USD'))),
	CONSTRAINT "ai_calls_duration_range" CHECK ("finet"."ai_calls"."duration_ms" between 0 and 3600000),
	CONSTRAINT "ai_calls_result_valid" CHECK ("finet"."ai_calls"."result" in ('ok', 'failed_validation', 'timeout', 'fallback', 'error'))
);
--> statement-breakpoint
CREATE TABLE "finet"."document_usage_daily" (
	"household_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_usage_daily_pkey" PRIMARY KEY("household_id","day"),
	CONSTRAINT "document_usage_daily_count_range" CHECK ("finet"."document_usage_daily"."count" between 0 and 1000000),
	CONSTRAINT "document_usage_daily_day_range" CHECK ("finet"."document_usage_daily"."day" between date '2000-01-01' and date '2999-12-31')
);
--> statement-breakpoint
CREATE TABLE "finet"."documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid,
	"kind" text DEFAULT 'receipt' NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"storage_key" text,
	"original_mime" text,
	"detected_mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"pages" integer,
	"sha256" text NOT NULL,
	"perceptual_hash" bigint,
	"possible_duplicate_of_id" uuid,
	"batch_id" uuid,
	"document_order" smallint,
	"error_code" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"processing_started_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"file_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_id_household_key" UNIQUE("id","household_id"),
	CONSTRAINT "documents_household_sha256_key" UNIQUE("household_id","sha256"),
	CONSTRAINT "documents_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "documents_batch_order_key" UNIQUE("batch_id","document_order"),
	CONSTRAINT "documents_kind_valid" CHECK ("finet"."documents"."kind" in ('receipt', 'statement', 'other')),
	CONSTRAINT "documents_status_valid" CHECK ("finet"."documents"."status" in ('uploaded', 'awaiting_consent', 'queued', 'processing', 'needs_review', 'done', 'failed', 'rejected')),
	CONSTRAINT "documents_storage_key_shape" CHECK ("finet"."documents"."storage_key" is null or "finet"."documents"."storage_key" = 'households/' || "finet"."documents"."household_id"::text || '/documents/' || "finet"."documents"."id"::text),
	CONSTRAINT "documents_file_deleted_shape" CHECK (("finet"."documents"."storage_key" is null) = ("finet"."documents"."file_deleted_at" is not null)),
	CONSTRAINT "documents_original_mime_shape" CHECK ("finet"."documents"."original_mime" is null or (char_length("finet"."documents"."original_mime") <= 100 and "finet"."documents"."original_mime" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$')),
	CONSTRAINT "documents_detected_mime_valid" CHECK ("finet"."documents"."detected_mime" in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
	CONSTRAINT "documents_size_range" CHECK ("finet"."documents"."size_bytes" between 1 and 104857600),
	CONSTRAINT "documents_pages_range" CHECK ("finet"."documents"."pages" is null or "finet"."documents"."pages" between 1 and 100),
	CONSTRAINT "documents_sha256_format" CHECK ("finet"."documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_duplicate_not_self" CHECK ("finet"."documents"."possible_duplicate_of_id" is null or "finet"."documents"."possible_duplicate_of_id" <> "finet"."documents"."id"),
	CONSTRAINT "documents_batch_order_shape" CHECK (("finet"."documents"."batch_id" is null) = ("finet"."documents"."document_order" is null) and ("finet"."documents"."document_order" is null or "finet"."documents"."document_order" between 1 and 4)),
	CONSTRAINT "documents_error_code_format" CHECK ("finet"."documents"."error_code" is null or "finet"."documents"."error_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "documents_attempts_range" CHECK ("finet"."documents"."attempts" between 0 and 10)
);
--> statement-breakpoint
CREATE TABLE "finet"."processing_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"created_by_user_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_batches_id_household_key" UNIQUE("id","household_id"),
	CONSTRAINT "processing_batches_kind_valid" CHECK ("finet"."processing_batches"."kind" in ('single', 'long_receipt')),
	CONSTRAINT "processing_batches_status_valid" CHECK ("finet"."processing_batches"."status" in ('queued', 'processing', 'needs_review', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "finet"."product_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"normalized_name" text NOT NULL,
	"category_id" uuid NOT NULL,
	"tag_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_aliases_household_name_key" UNIQUE("household_id","normalized_name"),
	CONSTRAINT "product_aliases_normalized_name_length" CHECK (char_length("finet"."product_aliases"."normalized_name") >= 1 and char_length("finet"."product_aliases"."normalized_name") <= 300 and "finet"."product_aliases"."normalized_name" = btrim("finet"."product_aliases"."normalized_name")),
	CONSTRAINT "product_aliases_tag_ids_count" CHECK (cardinality("finet"."product_aliases"."tag_ids") <= 10 and array_position("finet"."product_aliases"."tag_ids", null) is null)
);
--> statement-breakpoint
CREATE TABLE "finet"."receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"raw_name" text NOT NULL,
	"normalized_name" text,
	"quantity" numeric(12, 3),
	"unit_price_minor" bigint,
	"line_total_minor" bigint NOT NULL,
	"vat_rate" numeric(5, 2),
	"category_id" uuid,
	"kind" text DEFAULT 'product' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_lines_receipt_position_key" UNIQUE("receipt_id","position"),
	CONSTRAINT "receipt_lines_position_range" CHECK ("finet"."receipt_lines"."position" between 1 and 500),
	CONSTRAINT "receipt_lines_raw_name_length" CHECK (char_length("finet"."receipt_lines"."raw_name") between 1 and 300),
	CONSTRAINT "receipt_lines_normalized_name_length" CHECK ("finet"."receipt_lines"."normalized_name" is null or char_length("finet"."receipt_lines"."normalized_name") between 1 and 300),
	CONSTRAINT "receipt_lines_quantity_range" CHECK ("finet"."receipt_lines"."quantity" is null or ("finet"."receipt_lines"."quantity" > 0 and "finet"."receipt_lines"."quantity" < 1000000000)),
	CONSTRAINT "receipt_lines_unit_price_range" CHECK ("finet"."receipt_lines"."unit_price_minor" is null or "finet"."receipt_lines"."unit_price_minor" between 0 and 10000000000000),
	CONSTRAINT "receipt_lines_total_range" CHECK ("finet"."receipt_lines"."line_total_minor" between 0 and 10000000000000),
	CONSTRAINT "receipt_lines_vat_rate_range" CHECK ("finet"."receipt_lines"."vat_rate" is null or "finet"."receipt_lines"."vat_rate" between 0 and 100),
	CONSTRAINT "receipt_lines_kind_valid" CHECK ("finet"."receipt_lines"."kind" in ('product', 'discount', 'deposit_sgr', 'bag', 'other'))
);
--> statement-breakpoint
CREATE TABLE "finet"."receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"document_id" uuid,
	"batch_id" uuid,
	"merchant_name" text,
	"merchant_tax_id" text,
	"store_address" text,
	"receipt_number" text,
	"occurred_on" date,
	"payment_method" text,
	"total_minor" bigint,
	"currency" text DEFAULT 'RON' NOT NULL,
	"vat_total_minor" bigint,
	"status" text DEFAULT 'queued' NOT NULL,
	"confidence" smallint,
	"provider_used" text DEFAULT 'none' NOT NULL,
	"fallback_reason" text,
	"transaction_id" uuid,
	"dedup_key" text,
	"ocr_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_id_household_key" UNIQUE("id","household_id"),
	CONSTRAINT "receipts_source_present" CHECK ("finet"."receipts"."document_id" is not null or "finet"."receipts"."batch_id" is not null),
	CONSTRAINT "receipts_merchant_name_length" CHECK ("finet"."receipts"."merchant_name" is null or char_length("finet"."receipts"."merchant_name") <= 200),
	CONSTRAINT "receipts_merchant_tax_id_format" CHECK ("finet"."receipts"."merchant_tax_id" is null or "finet"."receipts"."merchant_tax_id" ~ '^(RO)?[0-9]{2,10}$'),
	CONSTRAINT "receipts_store_address_length" CHECK ("finet"."receipts"."store_address" is null or char_length("finet"."receipts"."store_address") <= 300),
	CONSTRAINT "receipts_receipt_number_length" CHECK ("finet"."receipts"."receipt_number" is null or char_length("finet"."receipts"."receipt_number") between 1 and 64),
	CONSTRAINT "receipts_occurred_on_range" CHECK ("finet"."receipts"."occurred_on" is null or "finet"."receipts"."occurred_on" between date '1900-01-01' and date '2999-12-31'),
	CONSTRAINT "receipts_payment_method_valid" CHECK ("finet"."receipts"."payment_method" is null or "finet"."receipts"."payment_method" in ('cash', 'card', 'voucher', 'mixed', 'other')),
	CONSTRAINT "receipts_total_range" CHECK ("finet"."receipts"."total_minor" is null or "finet"."receipts"."total_minor" between 0 and 10000000000000),
	CONSTRAINT "receipts_vat_total_range" CHECK ("finet"."receipts"."vat_total_minor" is null or "finet"."receipts"."vat_total_minor" between 0 and 10000000000000),
	CONSTRAINT "receipts_currency_valid" CHECK ("finet"."receipts"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "receipts_status_valid" CHECK ("finet"."receipts"."status" in ('queued', 'needs_review', 'saved', 'failed')),
	CONSTRAINT "receipts_confidence_range" CHECK ("finet"."receipts"."confidence" is null or "finet"."receipts"."confidence" between 0 and 100),
	CONSTRAINT "receipts_provider_used_valid" CHECK ("finet"."receipts"."provider_used" in ('none', 'local', 'external')),
	CONSTRAINT "receipts_fallback_reason_valid" CHECK ("finet"."receipts"."fallback_reason" is null or "finet"."receipts"."fallback_reason" in ('local_unavailable', 'local_timeout', 'local_failed_validation', 'low_confidence', 'no_local_model', 'consent_missing', 'budget_exceeded', 'daily_limit', 'external_failed')),
	CONSTRAINT "receipts_dedup_key_format" CHECK ("finet"."receipts"."dedup_key" is null or "finet"."receipts"."dedup_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "receipts_ocr_text_length" CHECK ("finet"."receipts"."ocr_text" is null or char_length("finet"."receipts"."ocr_text") <= 20000)
);
--> statement-breakpoint
ALTER TABLE "finet"."ai_calls" ADD CONSTRAINT "ai_calls_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."document_usage_daily" ADD CONSTRAINT "document_usage_daily_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."documents" ADD CONSTRAINT "documents_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."processing_batches" ADD CONSTRAINT "processing_batches_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."processing_batches" ADD CONSTRAINT "processing_batches_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."product_aliases" ADD CONSTRAINT "product_aliases_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."product_aliases" ADD CONSTRAINT "product_aliases_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "finet"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipt_lines" ADD CONSTRAINT "receipt_lines_receipt_fk" FOREIGN KEY ("receipt_id","household_id") REFERENCES "finet"."receipts"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipt_lines" ADD CONSTRAINT "receipt_lines_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "finet"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_document_fk" FOREIGN KEY ("document_id","household_id") REFERENCES "finet"."documents"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_batch_fk" FOREIGN KEY ("batch_id","household_id") REFERENCES "finet"."processing_batches"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_household_created_idx" ON "finet"."ai_calls" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_document_id_idx" ON "finet"."ai_calls" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ai_calls_external_created_idx" ON "finet"."ai_calls" USING btree ("created_at") WHERE "finet"."ai_calls"."provider" = 'external';--> statement-breakpoint
CREATE INDEX "documents_household_status_idx" ON "finet"."documents" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "documents_household_created_idx" ON "finet"."documents" USING btree ("household_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_uploaded_by_user_id_idx" ON "finet"."documents" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "documents_batch_id_idx" ON "finet"."documents" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "documents_possible_duplicate_of_id_idx" ON "finet"."documents" USING btree ("possible_duplicate_of_id");--> statement-breakpoint
CREATE INDEX "documents_perceptual_idx" ON "finet"."documents" USING btree ("household_id") WHERE "finet"."documents"."perceptual_hash" is not null;--> statement-breakpoint
CREATE INDEX "documents_pending_idx" ON "finet"."documents" USING btree ("created_at","id") WHERE "finet"."documents"."status" in ('queued', 'processing');--> statement-breakpoint
CREATE INDEX "processing_batches_household_status_idx" ON "finet"."processing_batches" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "processing_batches_created_by_user_id_idx" ON "finet"."processing_batches" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "product_aliases_category_id_idx" ON "finet"."product_aliases" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "receipt_lines_household_id_idx" ON "finet"."receipt_lines" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "receipt_lines_category_id_idx" ON "finet"."receipt_lines" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_document_key" ON "finet"."receipts" USING btree ("document_id") WHERE "finet"."receipts"."document_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_batch_key" ON "finet"."receipts" USING btree ("batch_id") WHERE "finet"."receipts"."batch_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_household_dedup_key" ON "finet"."receipts" USING btree ("household_id","dedup_key") WHERE "finet"."receipts"."dedup_key" is not null;--> statement-breakpoint
CREATE INDEX "receipts_household_status_idx" ON "finet"."receipts" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "receipts_transaction_id_idx" ON "finet"."receipts" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "receipts_ocr_text_idx" ON "finet"."receipts" USING gin (to_tsvector('simple', coalesce("ocr_text", '')));
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- Document → lot: aceeași gospodărie; ștergerea lotului păstrează documentele (fără lot).
alter table finet.documents add constraint documents_batch_fk
  foreign key (batch_id, household_id)
  references finet.processing_batches (id, household_id)
  on delete set null (batch_id) on update no action;
--> statement-breakpoint
-- „Posibil duplicat” (hash perceptual apropiat): doar o legătură informativă, în aceeași
-- gospodărie; ștergerea originalului desface legătura.
alter table finet.documents add constraint documents_duplicate_of_fk
  foreign key (possible_duplicate_of_id, household_id)
  references finet.documents (id, household_id)
  on delete set null (possible_duplicate_of_id) on update no action;
--> statement-breakpoint
-- Bon → tranzacția creată din el: ștergerea tranzacției desface doar legătura.
alter table finet.receipts add constraint receipts_transaction_fk
  foreign key (transaction_id, household_id)
  references finet.transactions (id, household_id)
  on delete set null (transaction_id) on update no action;
--> statement-breakpoint
-- Apel AI → document: jurnalul rămâne după ștergerea documentului (costul s-a consumat).
alter table finet.ai_calls add constraint ai_calls_document_fk
  foreign key (document_id, household_id)
  references finet.documents (id, household_id)
  on delete set null (document_id) on update no action;
--> statement-breakpoint
-- Tranzacție → documentul din care a fost creată (coloana există din 0002, fără cheie). 5.6:
-- ștergerea documentului păstrează tranzacția și desface doar legătura. NOT VALID + VALIDATE:
-- aceeași garanție ca o cheie obișnuită, cu un lock mai slab pe durata verificării.
alter table finet.transactions add constraint transactions_document_fk
  foreign key (document_id, household_id)
  references finet.documents (id, household_id)
  on delete set null (document_id) on update no action
  not valid;
--> statement-breakpoint
alter table finet.transactions validate constraint transactions_document_fk;
--> statement-breakpoint
create index transactions_document_id_idx on finet.transactions (document_id)
  where document_id is not null;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Triggerele de integritate: SECURITY INVOKER, `search_path` fix (model: 0006). Rulează sub
-- RLS-ul celui care scrie, deci categoria/eticheta altei gospodării e invizibilă și respinsă ca
-- inexistentă (cheia simplă spre categorii ignoră RLS).
-- ---------------------------------------------------------------------------------------------
create function finet.receipt_lines_check_refs() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v_kind text;
  begin
    if new.category_id is not null then
      select c.kind into v_kind
        from finet.categories c
       where c.id = new.category_id
         and (c.household_id is null or c.household_id = new.household_id);
      if not found then
        raise exception 'receipt_lines: categoria nu există' using errcode = '23503';
      end if;
      if v_kind <> 'expense' then
        raise exception 'receipt_lines: categoria nu e de cheltuieli' using errcode = '23514';
      end if;
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger receipt_lines_check_refs
  before insert or update of category_id, household_id on finet.receipt_lines
  for each row execute function finet.receipt_lines_check_refs();
--> statement-breakpoint
revoke all on function finet.receipt_lines_check_refs() from public;
--> statement-breakpoint
create function finet.product_aliases_check_refs() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v_kind text;
    v_found integer;
  begin
    select c.kind into v_kind
      from finet.categories c
     where c.id = new.category_id
       and (c.household_id is null or c.household_id = new.household_id);
    if not found then
      raise exception 'product_aliases: categoria nu există' using errcode = '23503';
    end if;
    if v_kind <> 'expense' then
      raise exception 'product_aliases: categoria nu e de cheltuieli' using errcode = '23514';
    end if;
    if cardinality(new.tag_ids) > 0 then
      select count(distinct t.id) into v_found
        from finet.tags t
       where t.id = any (new.tag_ids)
         and (t.household_id is null or t.household_id = new.household_id);
      if v_found <> (select count(distinct x) from unnest(new.tag_ids) as x) then
        raise exception 'product_aliases: o etichetă nu există' using errcode = '23503';
      end if;
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger product_aliases_check_refs
  before insert or update of category_id, tag_ids, household_id on finet.product_aliases
  for each row execute function finet.product_aliases_check_refs();
--> statement-breakpoint
revoke all on function finet.product_aliases_check_refs() from public;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat pe toate tabelele noi; politici pe gospodărie ca în 0002/0004/0006.
-- ---------------------------------------------------------------------------------------------
alter table finet.processing_batches enable row level security;
--> statement-breakpoint
alter table finet.processing_batches force row level security;
--> statement-breakpoint
alter table finet.documents enable row level security;
--> statement-breakpoint
alter table finet.documents force row level security;
--> statement-breakpoint
alter table finet.receipts enable row level security;
--> statement-breakpoint
alter table finet.receipts force row level security;
--> statement-breakpoint
alter table finet.receipt_lines enable row level security;
--> statement-breakpoint
alter table finet.receipt_lines force row level security;
--> statement-breakpoint
alter table finet.product_aliases enable row level security;
--> statement-breakpoint
alter table finet.product_aliases force row level security;
--> statement-breakpoint
alter table finet.document_usage_daily enable row level security;
--> statement-breakpoint
alter table finet.document_usage_daily force row level security;
--> statement-breakpoint
alter table finet.ai_calls enable row level security;
--> statement-breakpoint
alter table finet.ai_calls force row level security;
--> statement-breakpoint
create policy processing_batches_household on finet.processing_batches
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy documents_household on finet.documents
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy receipts_household on finet.receipts
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy receipt_lines_household on finet.receipt_lines
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy product_aliases_household on finet.product_aliases
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy ai_calls_household on finet.ai_calls
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy document_usage_daily_household on finet.document_usage_daily
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Selecția documentelor de procesat pentru worker (ADR 0013; același model ca
-- `due_recurring_rules` din 0006). Workerul rulează ca finet_app (NOBYPASSRLS) și nu vede niciun
-- document fără contextul unei gospodării. Funcția rulează ca proprietarul (finet_migrator),
-- căruia FORCE RLS îi arată din `documents` DOAR rândurile în așteptare (politica
-- `documents_migrator_pending`) și întoarce DOAR identificatori: documentul, gospodăria și
-- membrul în numele căruia se procesează (cel care a încărcat, dacă e încă membru activ; altfel
-- cel mai vechi proprietar activ; altfel documentul e omis). Fără nume, sume sau chei de storage.
-- Se iau documentele `queued` și cele `processing` cu termenul de lucru expirat (un worker oprit
-- în timpul procesării nu le lasă blocate), sub plafonul de încercări.
-- Garduri: `p_limit` plafonat la 0..100, `p_stale_seconds` la cel puțin 60.
-- ---------------------------------------------------------------------------------------------
create policy documents_migrator_pending on finet.documents
  for select to finet_migrator
  using (status in ('queued', 'processing'));
--> statement-breakpoint
create function finet.queued_documents(p_limit integer, p_stale_seconds integer)
  returns table (document_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select d.id, d.household_id, a.user_id
      from finet.documents d
      cross join lateral (
        select m.user_id
          from finet.household_members m
          join finet.users u on u.id = m.user_id and u.status = 'active'
         where m.household_id = d.household_id
           and (m.user_id = d.uploaded_by_user_id or m.role = 'owner')
         order by (m.user_id = d.uploaded_by_user_id) desc, m.joined_at, m.user_id
         limit 1
      ) a
     where d.storage_key is not null
       and d.attempts < 10
       and (d.status = 'queued'
            or (d.status = 'processing'
                and (d.processing_started_at is null
                     or d.processing_started_at < pg_catalog.now()
                        - pg_catalog.make_interval(secs => greatest(coalesce(p_stale_seconds, 900), 60)))))
     order by d.created_at, d.id
     limit least(greatest(coalesce(p_limit, 0), 0), 100)
  $$;
--> statement-breakpoint
revoke all on function finet.queued_documents(integer, integer) from public;
--> statement-breakpoint
grant execute on function finet.queued_documents(integer, integer) to finet_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime.
-- - documents: nu se schimbă după creare id, household_id, uploaded_by_user_id, sha256,
--   size_bytes, detected_mime, original_mime, created_at; `storage_key` se poate doar goli
--   (CHECK-ul îl leagă de id + gospodărie, deci nu poate indica alt fișier);
-- - receipts: nu se schimbă id, household_id, document_id, batch_id, created_at;
-- - receipt_lines: nu se schimbă id, receipt_id, household_id, created_at;
-- - product_aliases: doar categoria, etichetele și updated_at;
-- - ai_calls: jurnal, doar SELECT + INSERT (fără UPDATE/DELETE);
-- - document_usage_daily: contor care doar crește (fără DELETE; UPDATE doar pe count/updated_at).
-- ---------------------------------------------------------------------------------------------
revoke all on finet.processing_batches, finet.documents, finet.receipts, finet.receipt_lines,
  finet.product_aliases, finet.ai_calls, finet.document_usage_daily from public;
--> statement-breakpoint
grant select, insert, delete on finet.processing_batches to finet_app;
--> statement-breakpoint
grant update (status, updated_at) on finet.processing_batches to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.documents to finet_app;
--> statement-breakpoint
grant update (kind, status, storage_key, pages, perceptual_hash, possible_duplicate_of_id,
  batch_id, document_order, error_code, attempts, processing_started_at, expires_at,
  file_deleted_at, updated_at) on finet.documents to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.receipts to finet_app;
--> statement-breakpoint
grant update (merchant_name, merchant_tax_id, store_address, receipt_number, occurred_on,
  payment_method, total_minor, currency, vat_total_minor, status, confidence, provider_used,
  fallback_reason, transaction_id, dedup_key, ocr_text, updated_at) on finet.receipts to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.receipt_lines to finet_app;
--> statement-breakpoint
grant update (position, raw_name, normalized_name, quantity, unit_price_minor, line_total_minor,
  vat_rate, category_id, kind, updated_at) on finet.receipt_lines to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.product_aliases to finet_app;
--> statement-breakpoint
grant update (category_id, tag_ids, updated_at) on finet.product_aliases to finet_app;
--> statement-breakpoint
grant select, insert on finet.ai_calls to finet_app;
--> statement-breakpoint
grant select, insert on finet.document_usage_daily to finet_app;
--> statement-breakpoint
grant update (count, updated_at) on finet.document_usage_daily to finet_app;
