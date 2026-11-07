-- FINET 0029_currencies (modernizare 2026, pasul K; ADR 0049): monedele HUF și GBP + cursurile
-- valutare. DDL-ul generat de drizzle-kit (din `src/db/schema/*.ts`) vine primul; după el sunt
-- scrise de mână RLS-ul și drepturile tabelei `fx_rates`. NU modifica fișierul după aplicare:
-- runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Efect pe tabelele existente: cele 18 CHECK-uri de monedă sunt rescrise (DROP + ADD în aceeași
-- tranzacție) cu lista veche inclusă: rândurile existente rămân valide; ADD CONSTRAINT verifică
-- rândurile (lock scurt pe fiecare tabel; `transactions` e cel mai mare: câteva zeci de mii de
-- rânduri per gospodărie, sub o secundă).
--
-- `fx_rates`: cursurile zilnice BCE (baza EUR, `rate_micro` = curs × 1.000.000, întreg), scrise de
-- worker (`fx.refresh`), citite de aplicație; doar pentru AFIȘARE („≈ în moneda de bază”), niciodată
-- pentru sume stocate. EUR nu se stochează. Nicio valoare nu e inserată de migrație.
--
-- Rollback (manual, de operator, cu backup; refuză rândurile în HUF/GBP dacă există):
--   drop table finet.fx_rates;
--   pentru fiecare CHECK de mai jos: drop constraint + add constraint cu lista ('RON','EUR','USD');
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0029_currencies>';
CREATE TABLE "finet"."fx_rates" (
	"rate_date" date NOT NULL,
	"currency" text NOT NULL,
	"rate_micro" bigint NOT NULL,
	"source" text DEFAULT 'ecb' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_pkey" PRIMARY KEY("rate_date","currency"),
	CONSTRAINT "fx_rates_currency_valid" CHECK ("finet"."fx_rates"."currency" in ('RON', 'USD', 'HUF', 'GBP')),
	CONSTRAINT "fx_rates_rate_range" CHECK ("finet"."fx_rates"."rate_micro" between 1 and 1000000000000),
	CONSTRAINT "fx_rates_source_valid" CHECK ("finet"."fx_rates"."source" in ('ecb')),
	CONSTRAINT "fx_rates_date_range" CHECK ("finet"."fx_rates"."rate_date" between '1999-01-04' and '2999-12-31')
);
--> statement-breakpoint
ALTER TABLE "finet"."ai_budget_usage" DROP CONSTRAINT "ai_budget_usage_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."ai_calls" DROP CONSTRAINT "ai_calls_cost_shape";--> statement-breakpoint
ALTER TABLE "finet"."receipts" DROP CONSTRAINT "receipts_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."settlements" DROP CONSTRAINT "settlements_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."transaction_splits" DROP CONSTRAINT "transaction_splits_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."households" DROP CONSTRAINT "households_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."accounts" DROP CONSTRAINT "accounts_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."transactions" DROP CONSTRAINT "transactions_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."account_valuations" DROP CONSTRAINT "account_valuations_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."budgets" DROP CONSTRAINT "budgets_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."goals" DROP CONSTRAINT "goals_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."recurring_rules" DROP CONSTRAINT "recurring_rules_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."recurring_suggestion_dismissals" DROP CONSTRAINT "recurring_suggestion_dismissals_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."statement_imports" DROP CONSTRAINT "statement_imports_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."statement_lines" DROP CONSTRAINT "statement_lines_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."statement_lines" DROP CONSTRAINT "statement_lines_fx_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."statement_uploads" DROP CONSTRAINT "statement_uploads_currency_valid";--> statement-breakpoint
ALTER TABLE "finet"."user_preferences" DROP CONSTRAINT "user_preferences_currency_valid";--> statement-breakpoint
CREATE INDEX "fx_rates_currency_date_idx" ON "finet"."fx_rates" USING btree ("currency","rate_date");--> statement-breakpoint
ALTER TABLE "finet"."ai_budget_usage" ADD CONSTRAINT "ai_budget_usage_currency_valid" CHECK ("finet"."ai_budget_usage"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."ai_calls" ADD CONSTRAINT "ai_calls_cost_shape" CHECK (("finet"."ai_calls"."cost_estimate_minor" is null) = ("finet"."ai_calls"."cost_currency" is null) and ("finet"."ai_calls"."cost_estimate_minor" is null or "finet"."ai_calls"."cost_estimate_minor" between 0 and 10000000000000) and ("finet"."ai_calls"."cost_currency" is null or "finet"."ai_calls"."cost_currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP')));--> statement-breakpoint
ALTER TABLE "finet"."receipts" ADD CONSTRAINT "receipts_currency_valid" CHECK ("finet"."receipts"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."settlements" ADD CONSTRAINT "settlements_currency_valid" CHECK ("finet"."settlements"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."transaction_splits" ADD CONSTRAINT "transaction_splits_currency_valid" CHECK ("finet"."transaction_splits"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."households" ADD CONSTRAINT "households_currency_valid" CHECK ("finet"."households"."default_currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."accounts" ADD CONSTRAINT "accounts_currency_valid" CHECK ("finet"."accounts"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."transactions" ADD CONSTRAINT "transactions_currency_valid" CHECK ("finet"."transactions"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."account_valuations" ADD CONSTRAINT "account_valuations_currency_valid" CHECK ("finet"."account_valuations"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."budgets" ADD CONSTRAINT "budgets_currency_valid" CHECK ("finet"."budgets"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."goals" ADD CONSTRAINT "goals_currency_valid" CHECK ("finet"."goals"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."recurring_rules" ADD CONSTRAINT "recurring_rules_currency_valid" CHECK ("finet"."recurring_rules"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."recurring_suggestion_dismissals" ADD CONSTRAINT "recurring_suggestion_dismissals_currency_valid" CHECK ("finet"."recurring_suggestion_dismissals"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."statement_imports" ADD CONSTRAINT "statement_imports_currency_valid" CHECK ("finet"."statement_imports"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."statement_lines" ADD CONSTRAINT "statement_lines_currency_valid" CHECK ("finet"."statement_lines"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."statement_lines" ADD CONSTRAINT "statement_lines_fx_currency_valid" CHECK ("finet"."statement_lines"."fx_currency" is null or "finet"."statement_lines"."fx_currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."statement_uploads" ADD CONSTRAINT "statement_uploads_currency_valid" CHECK ("finet"."statement_uploads"."currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));--> statement-breakpoint
ALTER TABLE "finet"."user_preferences" ADD CONSTRAINT "user_preferences_currency_valid" CHECK ("finet"."user_preferences"."default_currency" in ('RON', 'EUR', 'USD', 'HUF', 'GBP'));
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Date de referință globale, ca `vat_rates` (0009): citire pentru oricine autentificat; scrierea
-- (upsert) o face workerul ca finet_app. FORCE RLS cu politici explicite; fără DELETE (istoricul
-- cursurilor nu se șterge din aplicație).
alter table finet.fx_rates enable row level security;
--> statement-breakpoint
alter table finet.fx_rates force row level security;
--> statement-breakpoint
create policy fx_rates_read on finet.fx_rates
  for select to finet_app
  using (true);
--> statement-breakpoint
create policy fx_rates_write on finet.fx_rates
  for insert to finet_app
  with check (true);
--> statement-breakpoint
create policy fx_rates_update on finet.fx_rates
  for update to finet_app
  using (true) with check (true);
--> statement-breakpoint
revoke all on finet.fx_rates from public;
--> statement-breakpoint
grant select, insert on finet.fx_rates to finet_app;
--> statement-breakpoint
grant update (rate_micro, source, fetched_at) on finet.fx_rates to finet_app;
