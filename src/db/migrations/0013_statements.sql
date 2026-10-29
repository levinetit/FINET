-- FINET 0013_statements (Faza 7, F7-A): importul extraselor bancare — importurile
-- (`statement_imports`), rândurile parsate (`statement_lines`) și contorul zilnic al
-- previzualizărilor (`statement_usage_daily`).
-- Prima parte e generată de `drizzle-kit generate --name statements` din
-- src/db/schema/statements.ts (`when` din jurnal fixat de mână la 1794700000000: DUPĂ 0016_gdpr_stats, aplicată deja pe producție înaintea Fazei 7; runner-ul refuză o migrație nouă anterioară uneia aplicate). A doua
-- parte (după „PARTEA SCRISĂ DE MÂNĂ”) e adăugată o singură dată, înainte de prima aplicare: cheia
-- `statement_lines_transaction_fk` cu `SET NULL (transaction_id)`, RLS ENABLE + FORCE, politicile
-- (vizibilitatea conturilor PERSONALE din 0012: un import pe un cont personal îl vede doar
-- proprietarul contului) și drepturile minime ale lui finet_app. Deciziile:
-- docs/adr/0018-statements-import.md. NU modifica fișierul după aplicare: runner-ul compară hash-ul.
--
-- Efect pe tabelele existente: niciunul (doar chei străine NOI care indică spre `accounts` și
-- `transactions`; fără ALTER pe tabelele existente, fără rescrierea datelor). Tranzacțiile create
-- din extrase folosesc coloanele existente `source = 'statement'` și `external_ref`.
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE istoricul importurilor, NU și
-- tranzacțiile create din extrase, care rămân cu `external_ref` = 'stmt:…'):
--   drop table finet.statement_lines, finet.statement_imports, finet.statement_usage_daily;
--   drop function finet.statement_lines_check_transaction(), finet.statement_imports_check_update(),
--     finet.statement_lines_check_update();
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0013_statements>';
-- (Politicile și drepturile dispar odată cu tabelele.)
CREATE TABLE "finet"."statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"created_by_user_id" uuid,
	"bank" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"parser_version" smallint NOT NULL,
	"period_start" date,
	"period_end" date,
	"opening_balance_minor" bigint,
	"closing_balance_minor" bigint,
	"computed_closing_minor" bigint,
	"balance_status" text NOT NULL,
	"source_sha256" text NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"warning_codes" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	CONSTRAINT "statement_imports_id_household_key" UNIQUE("id","household_id"),
	CONSTRAINT "statement_imports_line_target_key" UNIQUE("id","household_id","account_id","currency"),
	CONSTRAINT "statement_imports_bank_valid" CHECK ("finet"."statement_imports"."bank" in ('bt', 'brd', 'raiffeisen', 'revolut', 'ing', 'bcr', 'wise', 'generic')),
	CONSTRAINT "statement_imports_format_valid" CHECK ("finet"."statement_imports"."format" in ('pdf', 'csv', 'xlsx')),
	CONSTRAINT "statement_imports_status_valid" CHECK ("finet"."statement_imports"."status" in ('previewed', 'imported', 'failed', 'cancelled')),
	CONSTRAINT "statement_imports_balance_status_valid" CHECK ("finet"."statement_imports"."balance_status" in ('ok', 'mismatch', 'unknown')),
	CONSTRAINT "statement_imports_currency_valid" CHECK ("finet"."statement_imports"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "statement_imports_parser_version_min" CHECK ("finet"."statement_imports"."parser_version" >= 1),
	CONSTRAINT "statement_imports_parser_version_max" CHECK ("finet"."statement_imports"."parser_version" <= 1000),
	CONSTRAINT "statement_imports_source_sha256_format" CHECK ("finet"."statement_imports"."source_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "statement_imports_period_start_min" CHECK ("finet"."statement_imports"."period_start" is null or "finet"."statement_imports"."period_start" >= date '1900-01-01'),
	CONSTRAINT "statement_imports_period_end_max" CHECK ("finet"."statement_imports"."period_end" is null or "finet"."statement_imports"."period_end" <= date '2999-12-31'),
	CONSTRAINT "statement_imports_period_order" CHECK ("finet"."statement_imports"."period_start" is null or "finet"."statement_imports"."period_end" is null or "finet"."statement_imports"."period_end" >= "finet"."statement_imports"."period_start"),
	CONSTRAINT "statement_imports_opening_min" CHECK ("finet"."statement_imports"."opening_balance_minor" is null or "finet"."statement_imports"."opening_balance_minor" >= -10000000000000),
	CONSTRAINT "statement_imports_opening_max" CHECK ("finet"."statement_imports"."opening_balance_minor" is null or "finet"."statement_imports"."opening_balance_minor" <= 10000000000000),
	CONSTRAINT "statement_imports_closing_min" CHECK ("finet"."statement_imports"."closing_balance_minor" is null or "finet"."statement_imports"."closing_balance_minor" >= -10000000000000),
	CONSTRAINT "statement_imports_closing_max" CHECK ("finet"."statement_imports"."closing_balance_minor" is null or "finet"."statement_imports"."closing_balance_minor" <= 10000000000000),
	CONSTRAINT "statement_imports_computed_min" CHECK ("finet"."statement_imports"."computed_closing_minor" is null or "finet"."statement_imports"."computed_closing_minor" >= -10000000000000),
	CONSTRAINT "statement_imports_computed_max" CHECK ("finet"."statement_imports"."computed_closing_minor" is null or "finet"."statement_imports"."computed_closing_minor" <= 10000000000000),
	CONSTRAINT "statement_imports_counts_min" CHECK ("finet"."statement_imports"."line_count" >= 0 and "finet"."statement_imports"."new_count" >= 0 and "finet"."statement_imports"."duplicate_count" >= 0 and "finet"."statement_imports"."pending_count" >= 0 and "finet"."statement_imports"."imported_count" >= 0),
	CONSTRAINT "statement_imports_counts_max" CHECK ("finet"."statement_imports"."line_count" <= 5000 and "finet"."statement_imports"."new_count" <= "finet"."statement_imports"."line_count" and "finet"."statement_imports"."duplicate_count" <= "finet"."statement_imports"."line_count" and "finet"."statement_imports"."pending_count" <= 5000 and "finet"."statement_imports"."imported_count" <= 10000),
	CONSTRAINT "statement_imports_warning_codes_format" CHECK ("finet"."statement_imports"."warning_codes" is null or "finet"."statement_imports"."warning_codes" ~ '^[a-z][a-z0-9_]{1,40}(,[a-z][a-z0-9_]{1,40}){0,19}$'),
	CONSTRAINT "statement_imports_error_code_format" CHECK ("finet"."statement_imports"."error_code" is null or "finet"."statement_imports"."error_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "statement_imports_cancel_shape" CHECK (("finet"."statement_imports"."status" = 'cancelled') = ("finet"."statement_imports"."cancelled_at" is not null)),
	CONSTRAINT "statement_imports_cancelled_by_shape" CHECK ("finet"."statement_imports"."cancelled_by_user_id" is null or "finet"."statement_imports"."cancelled_at" is not null),
	CONSTRAINT "statement_imports_imported_shape" CHECK ("finet"."statement_imports"."imported_at" is null or "finet"."statement_imports"."status" <> 'previewed'),
	CONSTRAINT "statement_imports_imported_status" CHECK ("finet"."statement_imports"."status" <> 'imported' or "finet"."statement_imports"."imported_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "finet"."statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"row_no" integer NOT NULL,
	"occurred_on" date NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"description" text NOT NULL,
	"bank_reference" text,
	"dedup_key" text NOT NULL,
	"kind" text DEFAULT 'movement' NOT NULL,
	"fx_amount_minor" bigint,
	"fx_currency" text,
	"balance_after_minor" bigint,
	"state" text DEFAULT 'new' NOT NULL,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_lines_import_row_key" UNIQUE("import_id","row_no"),
	CONSTRAINT "statement_lines_row_no_min" CHECK ("finet"."statement_lines"."row_no" >= 1),
	CONSTRAINT "statement_lines_row_no_max" CHECK ("finet"."statement_lines"."row_no" <= 5000),
	CONSTRAINT "statement_lines_direction_valid" CHECK ("finet"."statement_lines"."direction" in ('debit', 'credit')),
	CONSTRAINT "statement_lines_amount_min" CHECK ("finet"."statement_lines"."amount_minor" >= 1),
	CONSTRAINT "statement_lines_amount_max" CHECK ("finet"."statement_lines"."amount_minor" <= 10000000000000),
	CONSTRAINT "statement_lines_currency_valid" CHECK ("finet"."statement_lines"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "statement_lines_occurred_on_min" CHECK ("finet"."statement_lines"."occurred_on" >= date '1900-01-01'),
	CONSTRAINT "statement_lines_occurred_on_max" CHECK ("finet"."statement_lines"."occurred_on" <= date '2999-12-31'),
	CONSTRAINT "statement_lines_description_length" CHECK (char_length("finet"."statement_lines"."description") <= 500),
	CONSTRAINT "statement_lines_bank_reference_length" CHECK ("finet"."statement_lines"."bank_reference" is null or char_length("finet"."statement_lines"."bank_reference") <= 200),
	CONSTRAINT "statement_lines_dedup_key_format" CHECK ("finet"."statement_lines"."dedup_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "statement_lines_kind_valid" CHECK ("finet"."statement_lines"."kind" in ('movement', 'fx')),
	CONSTRAINT "statement_lines_state_valid" CHECK ("finet"."statement_lines"."state" in ('new', 'duplicate', 'imported', 'skipped', 'cancelled')),
	CONSTRAINT "statement_lines_fx_currency_valid" CHECK ("finet"."statement_lines"."fx_currency" is null or "finet"."statement_lines"."fx_currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "statement_lines_fx_kind" CHECK ("finet"."statement_lines"."fx_currency" is null or "finet"."statement_lines"."kind" = 'fx'),
	CONSTRAINT "statement_lines_fx_amount_shape" CHECK ("finet"."statement_lines"."fx_amount_minor" is null or "finet"."statement_lines"."fx_currency" is not null),
	CONSTRAINT "statement_lines_fx_amount_min" CHECK ("finet"."statement_lines"."fx_amount_minor" is null or "finet"."statement_lines"."fx_amount_minor" >= 1),
	CONSTRAINT "statement_lines_fx_amount_max" CHECK ("finet"."statement_lines"."fx_amount_minor" is null or "finet"."statement_lines"."fx_amount_minor" <= 10000000000000),
	CONSTRAINT "statement_lines_balance_min" CHECK ("finet"."statement_lines"."balance_after_minor" is null or "finet"."statement_lines"."balance_after_minor" >= -10000000000000),
	CONSTRAINT "statement_lines_balance_max" CHECK ("finet"."statement_lines"."balance_after_minor" is null or "finet"."statement_lines"."balance_after_minor" <= 10000000000000)
);
--> statement-breakpoint
CREATE TABLE "finet"."statement_usage_daily" (
	"household_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_usage_daily_pkey" PRIMARY KEY("household_id","day"),
	CONSTRAINT "statement_usage_daily_count_min" CHECK ("finet"."statement_usage_daily"."count" >= 0),
	CONSTRAINT "statement_usage_daily_count_max" CHECK ("finet"."statement_usage_daily"."count" <= 1000000),
	CONSTRAINT "statement_usage_daily_day_min" CHECK ("finet"."statement_usage_daily"."day" >= date '2000-01-01'),
	CONSTRAINT "statement_usage_daily_day_max" CHECK ("finet"."statement_usage_daily"."day" <= date '2999-12-31')
);
--> statement-breakpoint
ALTER TABLE "finet"."statement_imports" ADD CONSTRAINT "statement_imports_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_imports" ADD CONSTRAINT "statement_imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_imports" ADD CONSTRAINT "statement_imports_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_imports" ADD CONSTRAINT "statement_imports_account_fk" FOREIGN KEY ("account_id","household_id","currency") REFERENCES "finet"."accounts"("id","household_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_lines" ADD CONSTRAINT "statement_lines_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_lines" ADD CONSTRAINT "statement_lines_import_fk" FOREIGN KEY ("import_id","household_id","account_id","currency") REFERENCES "finet"."statement_imports"("id","household_id","account_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_usage_daily" ADD CONSTRAINT "statement_usage_daily_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statement_imports_account_source_key" ON "finet"."statement_imports" USING btree ("account_id","source_sha256") WHERE "finet"."statement_imports"."status" = 'previewed' or "finet"."statement_imports"."status" = 'imported';--> statement-breakpoint
CREATE INDEX "statement_imports_household_created_idx" ON "finet"."statement_imports" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "statement_imports_account_status_idx" ON "finet"."statement_imports" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "statement_imports_created_by_user_id_idx" ON "finet"."statement_imports" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "statement_imports_cancelled_by_user_id_idx" ON "finet"."statement_imports" USING btree ("cancelled_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_lines_account_dedup_key" ON "finet"."statement_lines" USING btree ("account_id","dedup_key") WHERE "finet"."statement_lines"."state" = 'imported';--> statement-breakpoint
CREATE INDEX "statement_lines_household_id_idx" ON "finet"."statement_lines" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "statement_lines_account_occurred_idx" ON "finet"."statement_lines" USING btree ("account_id","occurred_on");--> statement-breakpoint
CREATE INDEX "statement_lines_transaction_id_idx" ON "finet"."statement_lines" USING btree ("transaction_id");--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- Tranzacția creată dintr-un rând: dacă utilizatorul o șterge, rândul rămâne `imported`, fără
-- legătură (reimportul aceluiași extras nu o recreează; 5.6).
alter table finet.statement_lines add constraint statement_lines_transaction_fk
  foreign key (transaction_id, household_id)
  references finet.transactions (id, household_id)
  on delete set null (transaction_id) on update no action;
--> statement-breakpoint
-- Integritatea legăturii rând → tranzacție (revizuirea F7-A): cheia compusă cu gospodăria nu
-- împiedică legarea de o tranzacție din ALT cont (inclusiv un cont personal invizibil, dacă id-ul
-- e cunoscut). Triggerul rulează cu drepturile apelantului (SECURITY INVOKER), deci cere ca
-- tranzacția să fie în ACELAȘI cont și vizibilă sub RLS-ul lui. Ștergerea tranzacției pune NULL
-- (fără verificare).
create function finet.statement_lines_check_transaction() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.transaction_id is null then
      return new;
    end if;
    if not exists (select 1 from finet.transactions t
                    where t.id = new.transaction_id
                      and t.household_id = new.household_id
                      and t.account_id = new.account_id) then
      raise exception 'statement_lines: tranzacția nu e în contul rândului'
        using errcode = '23503', constraint = 'statement_lines_transaction_account';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger statement_lines_check_transaction
  before insert or update of transaction_id on finet.statement_lines
  for each row execute function finet.statement_lines_check_transaction();
--> statement-breakpoint
-- Tranzițiile de stare (revizuirea F7-A): `previewed` → `imported` | `failed` | `cancelled`;
-- `imported` → `cancelled`; `failed` și `cancelled` sunt finale. Un import confirmat nu-și mai
-- schimbă contoarele sau data importului; doar anularea (status, cancelled_at/by, updated_at).
create function finet.statement_imports_check_update() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if old.status = 'failed' or old.status = 'cancelled' then
      raise exception 'statement_imports: importul e final'
        using errcode = '23514', constraint = 'statement_imports_final';
    end if;
    if old.status = 'imported' then
      if new.status <> 'imported' and new.status <> 'cancelled' then
        raise exception 'statement_imports: tranziție de stare nepermisă'
          using errcode = '23514', constraint = 'statement_imports_transition';
      end if;
      if new.imported_at is distinct from old.imported_at
         or new.new_count <> old.new_count
         or new.duplicate_count <> old.duplicate_count
         or new.imported_count <> old.imported_count
         or new.error_code is distinct from old.error_code then
        raise exception 'statement_imports: un import confirmat nu se modifică'
          using errcode = '23514', constraint = 'statement_imports_transition';
      end if;
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger statement_imports_check_update
  before update on finet.statement_imports
  for each row execute function finet.statement_imports_check_update();
--> statement-breakpoint
-- Stările rândurilor (revizuirea F7-A). Confirmarea (o singură tranzacție SQL): rândurile trec
-- `new` → `imported` (cu legătura spre tranzacția creată) CÂT importul părinte e încă
-- `previewed`, apoi importul devine `imported`. Anularea: rândurile `imported` → `cancelled` cât
-- părintele e încă `imported`, apoi importul devine `cancelled`. Între `new`, `duplicate` și
-- `skipped` se trece doar cât părintele e `previewed`. `cancelled` e finală; `imported` → doar
-- `cancelled`. Legătura spre tranzacție se pune o singură dată, odată cu `imported`; aplicația nu
-- o mai schimbă și nu o golește: o golește DOAR cheia străină (ON DELETE SET NULL), când
-- tranzacția nu mai există.
create function finet.statement_lines_check_update() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v_parent text;
    v_linking boolean := old.transaction_id is null and new.transaction_id is not null;
  begin
    if old.transaction_id is not null
       and new.transaction_id is distinct from old.transaction_id then
      if new.transaction_id is not null
         or exists (select 1 from finet.transactions t where t.id = old.transaction_id) then
        raise exception 'statement_lines: legătura spre tranzacție nu se schimbă'
          using errcode = '23514', constraint = 'statement_lines_transition';
      end if;
    end if;
    if new.state is distinct from old.state or v_linking then
      select i.status into v_parent from finet.statement_imports i where i.id = new.import_id;
      if old.state = 'cancelled' then
        raise exception 'statement_lines: rândul e final'
          using errcode = '23514', constraint = 'statement_lines_transition';
      elsif new.state = 'cancelled' then
        if old.state <> 'imported' or v_parent is distinct from 'imported' then
          raise exception 'statement_lines: tranziție de stare nepermisă'
            using errcode = '23514', constraint = 'statement_lines_transition';
        end if;
      elsif old.state = 'imported' then
        raise exception 'statement_lines: tranziție de stare nepermisă'
          using errcode = '23514', constraint = 'statement_lines_transition';
      elsif v_parent is distinct from 'previewed' then
        raise exception 'statement_lines: importul nu mai e o previzualizare'
          using errcode = '23514', constraint = 'statement_lines_transition';
      end if;
      if v_linking and new.state <> 'imported' then
        raise exception 'statement_lines: doar un rând importat are tranzacție'
          using errcode = '23514', constraint = 'statement_lines_transition';
      end if;
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger statement_lines_check_update
  before update on finet.statement_lines
  for each row execute function finet.statement_lines_check_update();
--> statement-breakpoint
revoke all on function finet.statement_lines_check_transaction(),
  finet.statement_imports_check_update(), finet.statement_lines_check_update() from public;
--> statement-breakpoint
alter table finet.statement_imports enable row level security;
--> statement-breakpoint
alter table finet.statement_imports force row level security;
--> statement-breakpoint
alter table finet.statement_lines enable row level security;
--> statement-breakpoint
alter table finet.statement_lines force row level security;
--> statement-breakpoint
alter table finet.statement_usage_daily enable row level security;
--> statement-breakpoint
alter table finet.statement_usage_daily force row level security;
--> statement-breakpoint
-- Vizibilitatea urmează contul (ca `transactions_household` din 0012): gospodăria curentă, membru
-- activ și contul comun sau personal al utilizatorului curent. Subinterogarea pe conturi e
-- necorelată (evaluată o dată pe interogare) și repetă explicit condiția.
create policy statement_imports_select on finet.statement_imports
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy statement_imports_insert on finet.statement_imports
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and created_by_user_id = (select finet.current_user_id())
         and (status = 'previewed' or status = 'failed')
         and imported_at is null and cancelled_at is null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy statement_imports_update on finet.statement_imports
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
-- Doar previzualizările neconfirmate (sau eșuate) se pot șterge; un import confirmat se ANULEAZĂ
-- (status `cancelled`), istoricul rămâne.
create policy statement_imports_delete on finet.statement_imports
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (status = 'previewed' or status = 'failed')
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy statement_lines_select on finet.statement_lines
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy statement_lines_insert on finet.statement_lines
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id())))
         and (state = 'new' or state = 'duplicate' or state = 'skipped')
         and transaction_id is null
         and exists (select 1 from finet.statement_imports i
                      where i.id = statement_lines.import_id
                        and i.household_id = statement_lines.household_id
                        and i.status = 'previewed'));
--> statement-breakpoint
create policy statement_lines_update on finet.statement_lines
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
-- Rândurile se șterg doar odată cu o previzualizare neconfirmată (sau eșuată); rândurile unui
-- import confirmat sau anulat rămân (istoricul și deduplicarea depind de ele).
create policy statement_lines_delete on finet.statement_lines
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id())))
         and exists (select 1 from finet.statement_imports i
                      where i.id = statement_lines.import_id
                        and (i.status = 'previewed' or i.status = 'failed')));
--> statement-breakpoint
create policy statement_usage_daily_household on finet.statement_usage_daily
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
-- Drepturile minime ale aplicației:
-- - statement_imports: citire, inserare; UPDATE doar pe starea, contoarele confirmării și
--   anulare; DELETE (doar previzualizări, prin politică);
-- - statement_lines: citire, inserare, ștergere (doar rândurile unei previzualizări, prin
--   politică); UPDATE doar pe stare și pe legătura spre tranzacție (triggerele de mai sus);
-- - statement_usage_daily: contor care doar crește (fără DELETE; UPDATE doar pe count/updated_at).
revoke all on finet.statement_imports, finet.statement_lines, finet.statement_usage_daily
  from public;
--> statement-breakpoint
grant select, insert, delete on finet.statement_imports to finet_app;
--> statement-breakpoint
grant update (status, new_count, duplicate_count, imported_count, error_code, updated_at,
  imported_at, cancelled_at, cancelled_by_user_id) on finet.statement_imports to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.statement_lines to finet_app;
--> statement-breakpoint
grant update (state, transaction_id) on finet.statement_lines to finet_app;
--> statement-breakpoint
grant select, insert on finet.statement_usage_daily to finet_app;
--> statement-breakpoint
grant update (count, updated_at) on finet.statement_usage_daily to finet_app;
