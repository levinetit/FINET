-- FINET 0006_recurring (Faza 5, F5-A): regulile recurente, ocurențele generate (garanția de
-- idempotență) și semnalul de viață al workerului (`service_heartbeats`).
-- Prima parte e generată de `drizzle-kit generate --name recurring` din src/db/schema/recurring.ts
-- (`when` din jurnal fixat de mână la 1793400000000, după 0005). A doua parte (după „PARTEA SCRISĂ
-- DE MÂNĂ”) e adăugată o singură dată, înainte de prima aplicare: cheile compuse cu
-- `SET NULL (coloană)` / `DEFERRABLE`, cheia `transactions.recurring_rule_id` → regulă, triggerul
-- de integritate, funcția `due_recurring_rules` (SECURITY DEFINER), RLS (ENABLE + FORCE în aceeași
-- migrație) și drepturile minime ale lui finet_app. Deciziile: docs/adr/0011-recurring-worker.md.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Efect pe tabelele existente (doar `finet.transactions`, fără rescrierea datelor):
--   - cheia `transactions_recurring_rule_fk` adăugată `NOT VALID`, apoi `VALIDATE` (verifică doar
--     rândurile cu `recurring_rule_id` nenul; până acum coloana nu era scrisă de nimeni, deci 0);
--   - indexul parțial `transactions_recurring_rule_id_idx` (doar rândurile cu regulă: gol acum).
--   Ambele iau un lock scurt pe `transactions` (scrierile așteaptă câteva milisecunde).
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE regulile și ocurențele, dar NU
-- tranzacțiile generate, care rămân ca tranzacții obișnuite cu `source = 'recurring'`):
--   alter table finet.transactions drop constraint transactions_recurring_rule_fk;
--   drop index finet.transactions_recurring_rule_id_idx;
--   drop table finet.recurring_occurrences, finet.recurring_rules, finet.service_heartbeats;
--   drop function finet.due_recurring_rules(date, integer), finet.recurring_rules_check_refs();
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0006_recurring>';
-- (Politicile, triggerele și drepturile dispar odată cu tabelele.)
CREATE TABLE "finet"."recurring_occurrences" (
	"rule_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_occurrences_pkey" PRIMARY KEY("rule_id","occurrence_date")
);
--> statement-breakpoint
CREATE TABLE "finet"."recurring_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" uuid,
	"type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"merchant" text,
	"frequency" text NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"day_of_month" integer,
	"start_on" date NOT NULL,
	"next_run_on" date NOT NULL,
	"end_on" date,
	"max_occurrences" integer,
	"occurrences_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error_code" text,
	"retry_after" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_rules_id_household_key" UNIQUE("id","household_id"),
	CONSTRAINT "recurring_rules_type_valid" CHECK ("finet"."recurring_rules"."type" in ('income', 'expense')),
	CONSTRAINT "recurring_rules_amount_range" CHECK ("finet"."recurring_rules"."amount_minor" between 1 and 10000000000000),
	CONSTRAINT "recurring_rules_currency_valid" CHECK ("finet"."recurring_rules"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "recurring_rules_description_length" CHECK (char_length("finet"."recurring_rules"."description") >= 1 and char_length("finet"."recurring_rules"."description") <= 500 and "finet"."recurring_rules"."description" = btrim("finet"."recurring_rules"."description")),
	CONSTRAINT "recurring_rules_merchant_length" CHECK ("finet"."recurring_rules"."merchant" is null or char_length("finet"."recurring_rules"."merchant") <= 200),
	CONSTRAINT "recurring_rules_frequency_valid" CHECK ("finet"."recurring_rules"."frequency" in ('daily', 'weekly', 'monthly', 'yearly')),
	CONSTRAINT "recurring_rules_interval_range" CHECK ("finet"."recurring_rules"."interval" between 1 and 100),
	CONSTRAINT "recurring_rules_day_of_month_shape" CHECK (("finet"."recurring_rules"."frequency" in ('monthly', 'yearly')) = ("finet"."recurring_rules"."day_of_month" is not null) and ("finet"."recurring_rules"."day_of_month" is null or "finet"."recurring_rules"."day_of_month" between 1 and 31)),
	CONSTRAINT "recurring_rules_dates_range" CHECK ("finet"."recurring_rules"."start_on" >= date '1900-01-01' and "finet"."recurring_rules"."start_on" <= date '2999-12-31' and "finet"."recurring_rules"."next_run_on" >= date '1900-01-01' and "finet"."recurring_rules"."next_run_on" <= date '2999-12-31' and ("finet"."recurring_rules"."end_on" is null or "finet"."recurring_rules"."end_on" between date '1900-01-01' and date '2999-12-31')),
	CONSTRAINT "recurring_rules_dates_order" CHECK ("finet"."recurring_rules"."next_run_on" >= "finet"."recurring_rules"."start_on" and ("finet"."recurring_rules"."end_on" is null or "finet"."recurring_rules"."end_on" >= "finet"."recurring_rules"."start_on")),
	CONSTRAINT "recurring_rules_max_occurrences_range" CHECK ("finet"."recurring_rules"."max_occurrences" is null or "finet"."recurring_rules"."max_occurrences" between 1 and 1200),
	CONSTRAINT "recurring_rules_occurrences_count_range" CHECK ("finet"."recurring_rules"."occurrences_count" >= 0 and ("finet"."recurring_rules"."max_occurrences" is null or "finet"."recurring_rules"."occurrences_count" <= "finet"."recurring_rules"."max_occurrences")),
	CONSTRAINT "recurring_rules_last_error_code_format" CHECK ("finet"."recurring_rules"."last_error_code" is null or "finet"."recurring_rules"."last_error_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "recurring_rules_status_valid" CHECK ("finet"."recurring_rules"."status" in ('active', 'paused', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "finet"."service_heartbeats" (
	"service" text PRIMARY KEY NOT NULL,
	"beat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "service_heartbeats_service_valid" CHECK ("finet"."service_heartbeats"."service" in ('worker'))
);
--> statement-breakpoint
ALTER TABLE "finet"."recurring_occurrences" ADD CONSTRAINT "recurring_occurrences_rule_fk" FOREIGN KEY ("rule_id","household_id") REFERENCES "finet"."recurring_rules"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."recurring_rules" ADD CONSTRAINT "recurring_rules_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."recurring_rules" ADD CONSTRAINT "recurring_rules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."recurring_rules" ADD CONSTRAINT "recurring_rules_account_fk" FOREIGN KEY ("account_id","household_id","currency") REFERENCES "finet"."accounts"("id","household_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."recurring_rules" ADD CONSTRAINT "recurring_rules_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "finet"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_occurrences_household_id_idx" ON "finet"."recurring_occurrences" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "recurring_occurrences_transaction_id_idx" ON "finet"."recurring_occurrences" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "recurring_rules_household_status_idx" ON "finet"."recurring_rules" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "recurring_rules_account_id_idx" ON "finet"."recurring_rules" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "recurring_rules_category_id_idx" ON "finet"."recurring_rules" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "recurring_rules_created_by_user_id_idx" ON "finet"."recurring_rules" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "recurring_rules_due_idx" ON "finet"."recurring_rules" USING btree ("next_run_on","id") WHERE "finet"."recurring_rules"."status" = 'active';
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- Ocurență → tranzacția generată: aceeași gospodărie; ștergerea tranzacției de către utilizator
-- desface DOAR legătura (ocurența rămâne, deci data nu se mai generează). DEFERRABLE: serviciul
-- inserează întâi ocurența (cu id-ul tranzacției generat în aplicație; conflictul pe
-- (rule_id, occurrence_date) = „deja generată” → nu se mai scrie nimic), apoi tranzacția.
alter table finet.recurring_occurrences add constraint recurring_occurrences_transaction_fk
  foreign key (transaction_id, household_id)
  references finet.transactions (id, household_id)
  on delete set null (transaction_id) on update no action
  deferrable initially deferred;
--> statement-breakpoint
-- Tranzacție → regula care a generat-o (coloana există din 0002, fără cheie). Ștergerea regulii
-- păstrează tranzacțiile și desface doar legătura. NOT VALID + VALIDATE: aceeași garanție ca o
-- cheie obișnuită, cu un lock mai slab pe durata verificării.
alter table finet.transactions add constraint transactions_recurring_rule_fk
  foreign key (recurring_rule_id, household_id)
  references finet.recurring_rules (id, household_id)
  on delete set null (recurring_rule_id) on update no action
  not valid;
--> statement-breakpoint
alter table finet.transactions validate constraint transactions_recurring_rule_fk;
--> statement-breakpoint
create index transactions_recurring_rule_id_idx on finet.transactions (recurring_rule_id)
  where recurring_rule_id is not null;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Triggerul de integritate: SECURITY INVOKER, `search_path` fix (model: 0002_ledger.sql). Rulează
-- sub RLS-ul celui care scrie, deci contul/categoria altei gospodării sunt invizibile și respinse
-- ca inexistente (cheia simplă spre categorii ignoră RLS).
-- ---------------------------------------------------------------------------------------------
create function finet.recurring_rules_check_refs() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v_archived timestamptz;
    v_kind text;
  begin
    if tg_op = 'INSERT' or new.account_id is distinct from old.account_id then
      select a.archived_at into v_archived
        from finet.accounts a
       where a.id = new.account_id and a.household_id = new.household_id;
      if not found then
        raise exception 'recurring_rules: contul nu există' using errcode = '23503';
      end if;
      if v_archived is not null then
        raise exception 'recurring_rules: contul e arhivat' using errcode = '23514';
      end if;
    end if;
    if new.category_id is not null then
      select c.kind into v_kind
        from finet.categories c
       where c.id = new.category_id
         and (c.household_id is null or c.household_id = new.household_id);
      if not found then
        raise exception 'recurring_rules: categoria nu există' using errcode = '23503';
      end if;
      if v_kind <> new.type then
        raise exception 'recurring_rules: categoria are alt tip decât regula' using errcode = '23514';
      end if;
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger recurring_rules_check_refs
  before insert or update of account_id, category_id, type on finet.recurring_rules
  for each row execute function finet.recurring_rules_check_refs();
--> statement-breakpoint
revoke all on function finet.recurring_rules_check_refs() from public;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat pe toate tabelele noi.
-- ---------------------------------------------------------------------------------------------
alter table finet.recurring_rules enable row level security;
--> statement-breakpoint
alter table finet.recurring_rules force row level security;
--> statement-breakpoint
alter table finet.recurring_occurrences enable row level security;
--> statement-breakpoint
alter table finet.recurring_occurrences force row level security;
--> statement-breakpoint
alter table finet.service_heartbeats enable row level security;
--> statement-breakpoint
alter table finet.service_heartbeats force row level security;
--> statement-breakpoint
create policy recurring_rules_household on finet.recurring_rules
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy recurring_occurrences_household on finet.recurring_occurrences
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
-- Semnalul de viață nu aparține unei gospodării și nu conține date: finet_app (workerul îl scrie,
-- serverul web îl citește) vede rândurile serviciilor cunoscute (CHECK-ul limitează `service`).
create policy service_heartbeats_app on finet.service_heartbeats
  for all to finet_app
  using (true)
  with check (true);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Selecția scadențelor pentru worker (ADR 0011). Workerul rulează ca finet_app (NOBYPASSRLS) și
-- nu vede nicio regulă fără contextul unei gospodării, iar contextul cere un MEMBRU (politicile
-- verifică `member_role`). Funcția rulează ca proprietarul (finet_migrator), căruia FORCE RLS îi
-- arată din `recurring_rules` DOAR regulile active (politica `recurring_rules_migrator_due`) și
-- întoarce DOAR identificatori: regula, gospodăria și membrul în numele căruia se generează
-- (creatorul, dacă e încă membru activ; altfel cel mai vechi proprietar activ; altfel regula e
-- omisă). Fără sume, descrieri, conturi. Generarea propriu-zisă se face apoi ca finet_app, în
-- contextul RLS al gospodăriei și al acelui membru.
-- Garduri: `p_today` e plafonat la data curentă din București (un apelant nu poate „vedea în
-- viitor” toate regulile active), `p_limit` la 0..1000; regulile cu `retry_after` în viitor
-- (eșec recent) sunt omise, ca să nu ocupe fereastra înaintea celor sănătoase.
-- ---------------------------------------------------------------------------------------------
create policy recurring_rules_migrator_due on finet.recurring_rules
  for select to finet_migrator
  using (status = 'active');
--> statement-breakpoint
create function finet.due_recurring_rules(p_today date, p_limit integer)
  returns table (rule_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select r.id, r.household_id, a.user_id
      from finet.recurring_rules r
      cross join lateral (
        select m.user_id
          from finet.household_members m
          join finet.users u on u.id = m.user_id and u.status = 'active'
         where m.household_id = r.household_id
           and (m.user_id = r.created_by_user_id or m.role = 'owner')
         order by (m.user_id = r.created_by_user_id) desc, m.joined_at, m.user_id
         limit 1
      ) a
     where r.status = 'active'
       and r.next_run_on <= least(p_today, (pg_catalog.now() at time zone 'Europe/Bucharest')::date)
       and (r.retry_after is null or r.retry_after <= pg_catalog.now())
     order by r.next_run_on, r.id
     limit least(greatest(coalesce(p_limit, 0), 0), 1000)
  $$;
--> statement-breakpoint
revoke all on function finet.due_recurring_rules(date, integer) from public;
--> statement-breakpoint
grant execute on function finet.due_recurring_rules(date, integer) to finet_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime. Nu se schimbă după creare: id, household_id,
-- type (alt tip = altă regulă), start_on, created_by_user_id, created_at. Ocurențele nu se
-- modifică și nu se șterg de aplicație (dispar cu regula; legătura cu tranzacția o desface cheia).
-- ---------------------------------------------------------------------------------------------
revoke all on finet.recurring_rules, finet.recurring_occurrences, finet.service_heartbeats
  from public;
--> statement-breakpoint
grant select, insert, delete on finet.recurring_rules to finet_app;
--> statement-breakpoint
grant update (account_id, currency, category_id, amount_minor, description, merchant, frequency,
  interval, day_of_month, next_run_on, end_on, max_occurrences, occurrences_count, status,
  last_error_code, retry_after, updated_at) on finet.recurring_rules to finet_app;
--> statement-breakpoint
grant select, insert on finet.recurring_occurrences to finet_app;
--> statement-breakpoint
grant select, insert on finet.service_heartbeats to finet_app;
--> statement-breakpoint
grant update (beat_at, started_at, stopped_at) on finet.service_heartbeats to finet_app;
