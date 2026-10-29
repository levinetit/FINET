-- FINET 0009_receipt_pipeline (Faza 6, F6-B): pipeline-ul AI al bonurilor. Prima parte e generată de
-- `drizzle-kit generate --name receipt_pipeline` din src/db/schema/documents.ts (`when` din jurnal
-- fixat de mână la 1793700000000, după 0008). A doua parte (după „PARTEA SCRISĂ DE MÂNĂ”) e
-- adăugată o singură dată, înainte de prima aplicare. Deciziile: docs/adr/0014-receipts-ai-pipeline.md.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Ce adaugă:
--   - `receipts`: `issues` (problemele verificărilor, coduri stabile), `duplicate_of_receipt_id`
--     (același bon fotografiat din nou → originalul; cheie compusă `SET NULL (coloană)`),
--     `merge_report` (unirea bonului lung), motivul `ai_unconfigured` în `fallback_reason`;
--   - `vat_rates`: cotele de TVA pentru validare (5.5: „în date, nu în cod”), cu seed-ul RO;
--   - `ai_budget_usage`: contorul GLOBAL al bugetului lunar AI extern, care doar crește, accesibil
--     lui finet_app DOAR prin funcțiile SECURITY DEFINER `ai_budget_reserve` și `ai_budget_spent`;
--   - `queued_document(uuid)`: varianta pe un singur document a lui `queued_documents` (jobul
--     `receipt.process` re-derivă membrul în numele căruia lucrează; nu se încrede în datele jobului).
--
-- Efect pe tabelele existente: doar `finet.receipts` (gol pe producție până la Faza 6): coloane
-- noi cu valori implicite (fără rescriere: `'[]'::jsonb` e constantă), CHECK-uri noi, înlocuirea
-- CHECK-ului `receipts_fallback_reason_valid` (lista crește), o cheie compusă și un index.
--
-- Rollback (doar manual, de operator, cu backup înainte; workerul oprit):
--   drop function finet.ai_budget_reserve(bigint, bigint, text), finet.ai_budget_spent(text),
--     finet.queued_document(uuid);
--   drop table finet.ai_budget_usage, finet.vat_rates;
--   alter table finet.receipts drop constraint receipts_duplicate_of_fk,
--     drop constraint receipts_issues_shape, drop constraint receipts_merge_report_shape,
--     drop constraint receipts_duplicate_not_self, drop column issues,
--     drop column duplicate_of_receipt_id, drop column merge_report;
--   alter table finet.receipts drop constraint receipts_fallback_reason_valid;
--   alter table finet.receipts add constraint receipts_fallback_reason_valid check (fallback_reason is null
--     or fallback_reason in ('local_unavailable', 'local_timeout', 'local_failed_validation', 'low_confidence',
--     'no_local_model', 'consent_missing', 'budget_exceeded', 'daily_limit', 'external_failed'));
--     (eșuează dacă există rânduri cu `ai_unconfigured`: actualizează-le întâi la NULL)
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0009_receipt_pipeline>';
CREATE TABLE "finet"."ai_budget_usage" (
	"month" date NOT NULL,
	"currency" text NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_budget_usage_pkey" PRIMARY KEY("month","currency"),
	CONSTRAINT "ai_budget_usage_month_first_day" CHECK (extract(day from "finet"."ai_budget_usage"."month") = 1),
	CONSTRAINT "ai_budget_usage_currency_valid" CHECK ("finet"."ai_budget_usage"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "ai_budget_usage_reserved_range" CHECK ("finet"."ai_budget_usage"."reserved_minor" between 0 and 10000000000000),
	CONSTRAINT "ai_budget_usage_calls_range" CHECK ("finet"."ai_budget_usage"."calls" between 0 and 100000000)
);
--> statement-breakpoint
CREATE TABLE "finet"."vat_rates" (
	"country" text DEFAULT 'RO' NOT NULL,
	"rate_bp" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	CONSTRAINT "vat_rates_pkey" PRIMARY KEY("country","rate_bp","valid_from"),
	CONSTRAINT "vat_rates_country_format" CHECK ("finet"."vat_rates"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "vat_rates_rate_range" CHECK ("finet"."vat_rates"."rate_bp" between 0 and 10000),
	CONSTRAINT "vat_rates_period" CHECK ("finet"."vat_rates"."valid_to" is null or "finet"."vat_rates"."valid_to" >= "finet"."vat_rates"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "finet"."receipts" DROP CONSTRAINT "receipts_fallback_reason_valid";--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD COLUMN "issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD COLUMN "duplicate_of_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD COLUMN "merge_report" jsonb;--> statement-breakpoint
CREATE INDEX "receipts_duplicate_of_receipt_id_idx" ON "finet"."receipts" USING btree ("duplicate_of_receipt_id");--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_issues_shape" CHECK (jsonb_typeof("finet"."receipts"."issues") = 'array' and jsonb_array_length("finet"."receipts"."issues") <= 100 and pg_column_size("finet"."receipts"."issues") <= 16384);--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_merge_report_shape" CHECK ("finet"."receipts"."merge_report" is null or (jsonb_typeof("finet"."receipts"."merge_report") = 'object' and pg_column_size("finet"."receipts"."merge_report") <= 32768));--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_duplicate_not_self" CHECK ("finet"."receipts"."duplicate_of_receipt_id" is null or "finet"."receipts"."duplicate_of_receipt_id" <> "finet"."receipts"."id");--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_fallback_reason_valid" CHECK ("finet"."receipts"."fallback_reason" is null or "finet"."receipts"."fallback_reason" in ('local_unavailable', 'local_timeout', 'local_failed_validation', 'low_confidence', 'no_local_model', 'consent_missing', 'budget_exceeded', 'daily_limit', 'external_failed', 'ai_unconfigured'));
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================
-- Bon → bonul original (același CUI + număr + dată + total), în aceeași gospodărie; ștergerea
-- originalului desface doar legătura.
alter table finet.receipts add constraint receipts_duplicate_of_fk
  foreign key (duplicate_of_receipt_id, household_id)
  references finet.receipts (id, household_id)
  on delete set null (duplicate_of_receipt_id) on update no action;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Cotele de TVA (validare). Surse: Legea 141/2025 (21% și 11% de la 1 august 2025; cotele de 5% și
-- 9% contopite în 11%); 19% / 9% / 5% în perioada 2017-01-01 … 2025-07-31; 20% în 2016. Cota 0
-- (scutiri, garanția SGR). Excepția tranzitorie de 9% pentru locuințe (până la 31 iulie 2026) nu
-- apare pe bonuri de magazin și nu e inclusă. Schimbarea cotelor = o migrație nouă.
-- ---------------------------------------------------------------------------------------------
insert into finet.vat_rates (country, rate_bp, valid_from, valid_to) values
  ('RO', 0, date '2000-01-01', null),
  ('RO', 2000, date '2016-01-01', date '2016-12-31'),
  ('RO', 1900, date '2017-01-01', date '2025-07-31'),
  ('RO', 900, date '2016-01-01', date '2025-07-31'),
  ('RO', 500, date '2016-01-01', date '2025-07-31'),
  ('RO', 2100, date '2025-08-01', null),
  ('RO', 1100, date '2025-08-01', null);
--> statement-breakpoint
alter table finet.vat_rates enable row level security;
--> statement-breakpoint
alter table finet.vat_rates force row level security;
--> statement-breakpoint
-- Date de referință, aceleași pentru toate gospodăriile: doar citire.
create policy vat_rates_read on finet.vat_rates
  for select to finet_app
  using (true);
--> statement-breakpoint
revoke all on finet.vat_rates from public;
--> statement-breakpoint
grant select on finet.vat_rates to finet_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Bugetul lunar global AI (ADR 0014). Fără drepturi pentru finet_app pe tabel; FORCE RLS cu o
-- singură politică, pentru proprietar (finet_migrator), folosită de funcțiile de mai jos.
-- ---------------------------------------------------------------------------------------------
alter table finet.ai_budget_usage enable row level security;
--> statement-breakpoint
alter table finet.ai_budget_usage force row level security;
--> statement-breakpoint
create policy ai_budget_usage_owner on finet.ai_budget_usage
  for all to finet_migrator
  using (true)
  with check (true);
--> statement-breakpoint
revoke all on finet.ai_budget_usage from public;
--> statement-breakpoint
-- Rezervă `p_cost` din bugetul lunii curente (ziua locală Europe/Bucharest) ÎNAINTEA unei
-- încercări de apel extern; `true` dacă încape în `p_budget`, altfel `false` și nimic nu se
-- schimbă. Atomic (rândul lunii e blocat de UPDATE: două workere nu depășesc împreună bugetul).
-- Contorul doar crește (fără „rambursare”: rezervarea e pesimistă). Garduri fail-closed:
-- `p_cost` ≥ 1 (un apel nu e gratuit), `p_budget` ≤ 0 = fără AI extern, plafoane 10^13.
create function finet.ai_budget_reserve(p_cost bigint, p_budget bigint, p_currency text)
  returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_month date := date_trunc('month', pg_catalog.now() at time zone 'Europe/Bucharest')::date;
  begin
    if p_cost is null or p_cost < 1 or p_cost > 10000000000000 then
      raise exception 'ai_budget_reserve: cost invalid' using errcode = '22023';
    end if;
    if p_currency is null or p_currency not in ('RON', 'EUR', 'USD') then
      raise exception 'ai_budget_reserve: monedă invalidă' using errcode = '22023';
    end if;
    if p_budget is null or p_budget <= 0 then
      return false;
    end if;
    insert into finet.ai_budget_usage (month, currency) values (v_month, p_currency)
      on conflict (month, currency) do nothing;
    update finet.ai_budget_usage
       set reserved_minor = reserved_minor + p_cost,
           calls = calls + 1,
           updated_at = pg_catalog.now()
     where month = v_month and currency = p_currency
       and reserved_minor + p_cost <= least(p_budget, 10000000000000);
    return found;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.ai_budget_reserve(bigint, bigint, text) from public;
--> statement-breakpoint
grant execute on function finet.ai_budget_reserve(bigint, bigint, text) to finet_app;
--> statement-breakpoint
-- Cât s-a rezervat în luna curentă (pentru raport/limită; doar un număr, fără date de gospodării).
create function finet.ai_budget_spent(p_currency text)
  returns bigint
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select coalesce((select u.reserved_minor from finet.ai_budget_usage u
                      where u.month = date_trunc('month', pg_catalog.now() at time zone 'Europe/Bucharest')::date
                        and u.currency = p_currency), 0)::bigint
  $$;
--> statement-breakpoint
revoke all on function finet.ai_budget_spent(text) from public;
--> statement-breakpoint
grant execute on function finet.ai_budget_spent(text) to finet_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Un singur document de procesat (jobul `receipt.process`): aceleași reguli și aceeași politică
-- (`documents_migrator_pending`) ca `queued_documents` din 0008; întoarce doar identificatori, iar
-- membrul în numele căruia se lucrează e re-derivat aici, nu luat din datele jobului.
-- ---------------------------------------------------------------------------------------------
create function finet.queued_document(p_document_id uuid)
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
     where d.id = p_document_id
       and d.storage_key is not null
       and d.attempts < 10
       and d.status in ('queued', 'processing')
  $$;
--> statement-breakpoint
revoke all on function finet.queued_document(uuid) from public;
--> statement-breakpoint
grant execute on function finet.queued_document(uuid) to finet_app;
--> statement-breakpoint
-- Drepturile lui finet_app pe coloanele noi ale bonului.
grant update (issues, duplicate_of_receipt_id, merge_report) on finet.receipts to finet_app;
