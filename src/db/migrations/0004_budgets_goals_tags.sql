-- FINET 0004_budgets_goals_tags (Faza 3, F3-A): etichete (cu vizibilitatea celor de sistem și
-- legătura cu tranzacțiile), bugete lunare și obiective de economisire.
-- Prima parte e generată de `drizzle-kit generate --name budgets_goals_tags` din
-- src/db/schema/planning.ts (plus cheia unică `transactions_id_household_key`, ținta cheii
-- compuse din transaction_tags, mutată de mână ÎNAINTEA cheilor străine: drizzle-kit o pune la
-- sfârșit, iar Postgres cere constrângerea unică înaintea cheii străine). A doua parte (după
-- „PARTEA SCRISĂ DE MÂNĂ”) e adăugată o singură dată, înainte de prima aplicare: etichetele de
-- sistem (5.4), cheia compusă goals → accounts cu `ON DELETE SET NULL (account_id)` (PostgreSQL
-- 15+), triggerele de integritate, RLS (ENABLE + FORCE în aceeași migrație) și drepturile minime
-- ale lui finet_app. Deciziile: docs/adr/0007-planning-reporting.md.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Efect pe tabelele existente: doar `transactions_id_household_key` (UNIQUE (id, household_id)
-- pe finet.transactions; construiește un index, nu modifică date; id-ul e deja cheie primară,
-- deci constrângerea nu poate eșua).
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE datele din tabelele noi):
--   drop table finet.transaction_tags, finet.tag_visibility, finet.tags, finet.budgets,
--     finet.goals;
--   alter table finet.transactions drop constraint transactions_id_household_key;
--   drop function finet.tag_visibility_check(), finet.transaction_tags_check_tag(),
--     finet.budgets_check_category();
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0004_budgets_goals_tags>';
-- (Politicile, triggerele și drepturile dispar odată cu tabelele.)
CREATE TABLE "finet"."budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"category_id" uuid,
	"period" text DEFAULT 'monthly' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"warn_pct" integer DEFAULT 80 NOT NULL,
	"scope" text DEFAULT 'household' NOT NULL,
	"user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_period_valid" CHECK ("finet"."budgets"."period" in ('monthly')),
	CONSTRAINT "budgets_amount_range" CHECK ("finet"."budgets"."amount_minor" between 1 and 10000000000000),
	CONSTRAINT "budgets_currency_valid" CHECK ("finet"."budgets"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "budgets_warn_pct_range" CHECK ("finet"."budgets"."warn_pct" between 1 and 100),
	CONSTRAINT "budgets_scope_valid" CHECK ("finet"."budgets"."scope" in ('household', 'personal')),
	CONSTRAINT "budgets_scope_user" CHECK (("finet"."budgets"."scope" = 'personal') = ("finet"."budgets"."user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "finet"."goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"saved_minor" bigint DEFAULT 0 NOT NULL,
	"deadline" date,
	"status" text DEFAULT 'active' NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_name_length" CHECK (char_length("finet"."goals"."name") between 1 and 100),
	CONSTRAINT "goals_name_trimmed" CHECK ("finet"."goals"."name" = btrim("finet"."goals"."name")),
	CONSTRAINT "goals_target_range" CHECK ("finet"."goals"."target_minor" between 1 and 10000000000000),
	CONSTRAINT "goals_saved_range" CHECK ("finet"."goals"."saved_minor" between 0 and 10000000000000),
	CONSTRAINT "goals_currency_valid" CHECK ("finet"."goals"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "goals_status_valid" CHECK ("finet"."goals"."status" in ('active', 'achieved', 'abandoned')),
	CONSTRAINT "goals_status_progress" CHECK ("finet"."goals"."status" = 'abandoned' or ("finet"."goals"."status" = 'achieved') = ("finet"."goals"."saved_minor" >= "finet"."goals"."target_minor")),
	CONSTRAINT "goals_deadline_range" CHECK ("finet"."goals"."deadline" is null or "finet"."goals"."deadline" between date '1900-01-01' and date '2999-12-31')
);
--> statement-breakpoint
CREATE TABLE "finet"."tag_visibility" (
	"household_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"hidden" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_visibility_pkey" PRIMARY KEY("household_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "finet"."tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"name" text NOT NULL,
	"color" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"system_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_length" CHECK (char_length("finet"."tags"."name") between 1 and 40),
	CONSTRAINT "tags_name_trimmed" CHECK ("finet"."tags"."name" = btrim("finet"."tags"."name")),
	CONSTRAINT "tags_color_format" CHECK ("finet"."tags"."color" is null or "finet"."tags"."color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "tags_system_shape" CHECK (("finet"."tags"."household_id" is null) = ("finet"."tags"."system_key" is not null)),
	CONSTRAINT "tags_system_key_format" CHECK ("finet"."tags"."system_key" is null or "finet"."tags"."system_key" ~ '^[a-z][a-z0-9_]{1,39}$')
);
--> statement-breakpoint
CREATE TABLE "finet"."transaction_tags" (
	"transaction_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_tags_pkey" PRIMARY KEY("transaction_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "finet"."transactions" ADD CONSTRAINT "transactions_id_household_key" UNIQUE("id","household_id");--> statement-breakpoint
ALTER TABLE "finet"."budgets" ADD CONSTRAINT "budgets_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "finet"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."goals" ADD CONSTRAINT "goals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."tag_visibility" ADD CONSTRAINT "tag_visibility_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."tag_visibility" ADD CONSTRAINT "tag_visibility_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "finet"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."tags" ADD CONSTRAINT "tags_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transaction_tags" ADD CONSTRAINT "transaction_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "finet"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transaction_tags" ADD CONSTRAINT "transaction_tags_transaction_fk" FOREIGN KEY ("transaction_id","household_id") REFERENCES "finet"."transactions"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_active_key" ON "finet"."budgets" USING btree ("household_id",coalesce("category_id", '00000000-0000-0000-0000-000000000000'::uuid),"scope",coalesce("user_id", '00000000-0000-0000-0000-000000000000'::uuid),"currency") WHERE "finet"."budgets"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "budgets_category_id_idx" ON "finet"."budgets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "budgets_user_id_idx" ON "finet"."budgets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "goals_household_status_idx" ON "finet"."goals" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "goals_account_id_idx" ON "finet"."goals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "tag_visibility_tag_id_idx" ON "finet"."tag_visibility" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_household_name_key" ON "finet"."tags" USING btree (coalesce("household_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "tags_system_key_key" ON "finet"."tags" USING btree ("system_key") WHERE "finet"."tags"."system_key" is not null;--> statement-breakpoint
CREATE INDEX "transaction_tags_tag_id_idx" ON "finet"."transaction_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "transaction_tags_household_id_idx" ON "finet"."transaction_tags" USING btree ("household_id");
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- Etichetele de sistem (5.4): household_id NULL, cheie stabilă `system_key`, inserate ÎNAINTE de
-- activarea RLS (FORCE se aplică și proprietarului). Se ascund per gospodărie (`tag_visibility`).
insert into finet.tags (system_key, name, sort_order) values
  ('personal', 'Personal', 1),
  ('family', 'Familie', 2),
  ('children', 'Copii', 3),
  ('deductible', 'Deductibil', 4),
  ('gift', 'Cadou', 5);
--> statement-breakpoint
-- Obiectiv → cont: aceeași gospodărie și aceeași monedă (cheie compusă, ca transactions_account_fk).
-- Ștergerea contului (doar un cont gol se poate șterge, 5.6) desface legătura și păstrează
-- obiectivul: SET NULL DOAR pe account_id (household_id și currency rămân).
alter table finet.goals add constraint goals_account_fk
  foreign key (account_id, household_id, currency)
  references finet.accounts (id, household_id, currency)
  on delete set null (account_id) on update no action;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Triggerele de integritate: SECURITY INVOKER, `search_path` fix (model: 0002_ledger.sql). Rulează
-- sub RLS-ul celui care scrie, deci o etichetă/categorie a altei gospodării e invizibilă și e
-- respinsă ca inexistentă (cheile străine simple ignoră RLS).
-- ---------------------------------------------------------------------------------------------
create function finet.tag_visibility_check() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if not exists (
      select 1 from finet.tags t where t.id = new.tag_id and t.household_id is null
    ) then
      raise exception 'tag_visibility: doar etichetele de sistem' using errcode = '23503';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger tag_visibility_check
  before insert or update of tag_id on finet.tag_visibility
  for each row execute function finet.tag_visibility_check();
--> statement-breakpoint
create function finet.transaction_tags_check_tag() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if not exists (
      select 1 from finet.tags t
       where t.id = new.tag_id
         and (t.household_id is null or t.household_id = new.household_id)
    ) then
      raise exception 'transaction_tags: eticheta nu există' using errcode = '23503';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger transaction_tags_check_tag
  before insert or update of tag_id, household_id on finet.transaction_tags
  for each row execute function finet.transaction_tags_check_tag();
--> statement-breakpoint
-- Bugetul pe categorie: categoria e de sistem sau a gospodăriei și e de CHELTUIELI.
create function finet.budgets_check_category() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v_kind text;
  begin
    if new.category_id is null then
      return new;
    end if;
    select c.kind into v_kind
      from finet.categories c
     where c.id = new.category_id
       and (c.household_id is null or c.household_id = new.household_id);
    if not found then
      raise exception 'budgets: categoria nu există' using errcode = '23503';
    end if;
    if v_kind <> 'expense' then
      raise exception 'budgets: bugetul se face doar pe categorii de cheltuieli'
        using errcode = '23514';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger budgets_check_category
  before insert or update of category_id on finet.budgets
  for each row execute function finet.budgets_check_category();
--> statement-breakpoint
revoke all on function finet.tag_visibility_check(), finet.transaction_tags_check_tag(),
  finet.budgets_check_category() from public;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat pe toate tabelele noi.
-- ---------------------------------------------------------------------------------------------
alter table finet.tags enable row level security;
--> statement-breakpoint
alter table finet.tags force row level security;
--> statement-breakpoint
alter table finet.tag_visibility enable row level security;
--> statement-breakpoint
alter table finet.tag_visibility force row level security;
--> statement-breakpoint
alter table finet.transaction_tags enable row level security;
--> statement-breakpoint
alter table finet.transaction_tags force row level security;
--> statement-breakpoint
alter table finet.budgets enable row level security;
--> statement-breakpoint
alter table finet.budgets force row level security;
--> statement-breakpoint
alter table finet.goals enable row level security;
--> statement-breakpoint
alter table finet.goals force row level security;
--> statement-breakpoint
-- Etichetele: membrii văd etichetele de sistem și pe ale gospodăriei; scriu doar în gospodăria
-- curentă (cele de sistem au household_id NULL, deci nu pot fi modificate sau șterse).
create policy tags_select on finet.tags
  for select to finet_app
  using ((household_id is null
          or household_id = (select finet.current_household_id()))
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy tags_insert on finet.tags
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy tags_update on finet.tags
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy tags_delete on finet.tags
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy tag_visibility_household on finet.tag_visibility
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy transaction_tags_household on finet.transaction_tags
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
-- Bugetele: cele ale gospodăriei sunt vizibile tuturor membrilor; cele PERSONALE doar
-- proprietarului (citire și scriere). Un membru nu poate crea un buget personal pentru altcineva.
create policy budgets_household on finet.budgets
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (scope = 'household' or user_id = (select finet.current_user_id())))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (scope = 'household' or user_id = (select finet.current_user_id())));
--> statement-breakpoint
create policy goals_household on finet.goals
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime. Nu se schimbă după creare: id, household_id,
-- system_key, created_at (toate); tag_id/transaction_id ale legăturilor; la bugete category_id,
-- period, currency, scope, user_id (alt buget = rând nou); la obiective currency.
-- DELETE: etichetele proprii și legăturile (detașare), bugetele și obiectivele (serviciul cere
-- confirmarea în API); tag_visibility nu se șterge (se pune hidden = false).
-- ---------------------------------------------------------------------------------------------
revoke all on finet.tags, finet.tag_visibility, finet.transaction_tags, finet.budgets,
  finet.goals from public;
--> statement-breakpoint
grant select, insert, delete on finet.tags to finet_app;
--> statement-breakpoint
grant update (name, color, hidden, updated_at) on finet.tags to finet_app;
--> statement-breakpoint
grant select, insert on finet.tag_visibility to finet_app;
--> statement-breakpoint
grant update (hidden, updated_at) on finet.tag_visibility to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.transaction_tags to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.budgets to finet_app;
--> statement-breakpoint
grant update (amount_minor, warn_pct, archived_at, updated_at) on finet.budgets to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.goals to finet_app;
--> statement-breakpoint
grant update (name, target_minor, saved_minor, deadline, status, account_id, updated_at)
  on finet.goals to finet_app;
