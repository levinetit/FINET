-- FINET 0002_ledger (Faza 2): registrul financiar în schema `finet`: conturi, categorii (cu
-- vizibilitatea categoriilor de sistem), tranzacții și transferuri, cheile de idempotență și
-- statisticile de utilizare (client_installations, app_events, app_downloads).
-- Prima parte e generată de `drizzle-kit generate --name ledger` din src/db/schema/ledger.ts;
-- a doua parte (după „PARTEA SCRISĂ DE MÂNĂ”) e adăugată de mână o singură dată, înainte de
-- prima aplicare: categoriile de sistem (5.4), triggerele de integritate, RLS (ENABLE + FORCE pe
-- toate tabelele noi, în aceeași migrație, deci în aceeași tranzacție cu crearea lor) și
-- drepturile minime ale lui finet_app. Deciziile: docs/adr/0004-ledger.md.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE datele din aceste tabele):
--   drop table finet.transactions, finet.category_visibility, finet.categories, finet.accounts,
--     finet.idempotency_keys, finet.app_events, finet.app_downloads, finet.client_installations;
--   drop function finet.transactions_check_refs(), finet.transactions_check_transfer_group(),
--     finet.check_transfer_group(uuid), finet.categories_check_parent(),
--     finet.category_visibility_check();
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0002_ledger>';
-- (Politicile, triggerele și drepturile dispar odată cu tabelele.)
CREATE TABLE "finet"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" text NOT NULL,
	"opening_balance_minor" bigint DEFAULT 0 NOT NULL,
	"bank_code" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_id_household_currency_key" UNIQUE("id","household_id","currency"),
	CONSTRAINT "accounts_name_length" CHECK (char_length("finet"."accounts"."name") between 1 and 100),
	CONSTRAINT "accounts_name_trimmed" CHECK ("finet"."accounts"."name" = btrim("finet"."accounts"."name")),
	CONSTRAINT "accounts_type_valid" CHECK ("finet"."accounts"."type" in ('cash', 'bank', 'savings', 'credit_card')),
	CONSTRAINT "accounts_currency_valid" CHECK ("finet"."accounts"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "accounts_bank_code_format" CHECK ("finet"."accounts"."bank_code" is null or "finet"."accounts"."bank_code" ~ '^[a-z0-9_]{2,32}$')
);
--> statement-breakpoint
CREATE TABLE "finet"."app_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_downloads_version_format" CHECK ("finet"."app_downloads"."version" ~ '^[0-9A-Za-z.+_-]{1,32}$'),
	CONSTRAINT "app_downloads_source_valid" CHECK ("finet"."app_downloads"."source" in ('finet_page', 'qr'))
);
--> statement-breakpoint
CREATE TABLE "finet"."app_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"household_id" uuid,
	"installation_id" uuid,
	"name" text NOT NULL,
	"screen" text,
	"error_code" text,
	"app_version" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_events_name_format" CHECK ("finet"."app_events"."name" ~ '^[a-z][a-z0-9_.]{1,63}$'),
	CONSTRAINT "app_events_screen_format" CHECK ("finet"."app_events"."screen" is null or "finet"."app_events"."screen" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "app_events_error_code_format" CHECK ("finet"."app_events"."error_code" is null or "finet"."app_events"."error_code" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "app_events_app_version_format" CHECK ("finet"."app_events"."app_version" is null or "finet"."app_events"."app_version" ~ '^[0-9A-Za-z.+_-]{1,32}$')
);
--> statement-breakpoint
CREATE TABLE "finet"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"parent_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"icon" text,
	"color" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"system_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_name_length" CHECK (char_length("finet"."categories"."name") between 1 and 60),
	CONSTRAINT "categories_name_trimmed" CHECK ("finet"."categories"."name" = btrim("finet"."categories"."name")),
	CONSTRAINT "categories_kind_valid" CHECK ("finet"."categories"."kind" in ('income', 'expense')),
	CONSTRAINT "categories_icon_format" CHECK ("finet"."categories"."icon" is null or "finet"."categories"."icon" ~ '^[a-z0-9-]{1,40}$'),
	CONSTRAINT "categories_color_format" CHECK ("finet"."categories"."color" is null or "finet"."categories"."color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "categories_not_own_parent" CHECK ("finet"."categories"."parent_id" is null or "finet"."categories"."parent_id" <> "finet"."categories"."id"),
	CONSTRAINT "categories_system_shape" CHECK (("finet"."categories"."household_id" is null) = ("finet"."categories"."system_key" is not null) and ("finet"."categories"."household_id" is not null or "finet"."categories"."parent_id" is null)),
	CONSTRAINT "categories_system_key_format" CHECK ("finet"."categories"."system_key" is null or "finet"."categories"."system_key" ~ '^(income|expense)[.][a-z0-9_]{2,40}$')
);
--> statement-breakpoint
CREATE TABLE "finet"."category_visibility" (
	"household_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"hidden" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_visibility_pkey" PRIMARY KEY("household_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "finet"."client_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"version_code" integer,
	"os_version" text,
	"device_model" text,
	"locale" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_installations_installation_id_key" UNIQUE("installation_id"),
	CONSTRAINT "client_installations_platform_valid" CHECK ("finet"."client_installations"."platform" in ('android', 'web')),
	CONSTRAINT "client_installations_app_version_format" CHECK ("finet"."client_installations"."app_version" is null or "finet"."client_installations"."app_version" ~ '^[0-9A-Za-z.+_-]{1,32}$'),
	CONSTRAINT "client_installations_version_code_range" CHECK ("finet"."client_installations"."version_code" is null or "finet"."client_installations"."version_code" between 0 and 2100000000),
	CONSTRAINT "client_installations_os_version_length" CHECK ("finet"."client_installations"."os_version" is null or char_length("finet"."client_installations"."os_version") <= 64),
	CONSTRAINT "client_installations_device_model_length" CHECK ("finet"."client_installations"."device_model" is null or char_length("finet"."client_installations"."device_model") <= 64),
	CONSTRAINT "client_installations_locale_format" CHECK ("finet"."client_installations"."locale" is null or "finet"."client_installations"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
	CONSTRAINT "client_installations_seen_order" CHECK ("finet"."client_installations"."last_seen_at" >= "finet"."client_installations"."first_seen_at")
);
--> statement-breakpoint
CREATE TABLE "finet"."idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"status_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_household_key_key" UNIQUE("household_id","key"),
	CONSTRAINT "idempotency_keys_key_format" CHECK ("finet"."idempotency_keys"."key" ~ '^[A-Za-z0-9_-]{8,128}$'),
	CONSTRAINT "idempotency_keys_request_hash_format" CHECK ("finet"."idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_status_code_range" CHECK ("finet"."idempotency_keys"."status_code" is null or "finet"."idempotency_keys"."status_code" between 100 and 599)
);
--> statement-breakpoint
CREATE TABLE "finet"."transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"category_id" uuid,
	"created_by_user_id" uuid,
	"type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"occurred_on" date NOT NULL,
	"description" text,
	"merchant" text,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"transfer_group_id" uuid,
	"transfer_direction" text,
	"recurring_rule_id" uuid,
	"document_id" uuid,
	"external_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_amount_positive" CHECK ("finet"."transactions"."amount_minor" > 0),
	CONSTRAINT "transactions_type_valid" CHECK ("finet"."transactions"."type" in ('income', 'expense', 'transfer')),
	CONSTRAINT "transactions_currency_valid" CHECK ("finet"."transactions"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "transactions_source_valid" CHECK ("finet"."transactions"."source" in ('manual', 'receipt', 'statement', 'recurring')),
	CONSTRAINT "transactions_transfer_shape" CHECK (("finet"."transactions"."type" = 'transfer') = ("finet"."transactions"."transfer_group_id" is not null) and ("finet"."transactions"."type" = 'transfer') = ("finet"."transactions"."transfer_direction" is not null) and ("finet"."transactions"."type" <> 'transfer' or "finet"."transactions"."category_id" is null)),
	CONSTRAINT "transactions_transfer_direction_valid" CHECK ("finet"."transactions"."transfer_direction" is null or "finet"."transactions"."transfer_direction" in ('out', 'in')),
	CONSTRAINT "transactions_occurred_on_range" CHECK ("finet"."transactions"."occurred_on" between date '1900-01-01' and date '2999-12-31'),
	CONSTRAINT "transactions_description_length" CHECK ("finet"."transactions"."description" is null or char_length("finet"."transactions"."description") <= 500),
	CONSTRAINT "transactions_merchant_length" CHECK ("finet"."transactions"."merchant" is null or char_length("finet"."transactions"."merchant") <= 200),
	CONSTRAINT "transactions_notes_length" CHECK ("finet"."transactions"."notes" is null or char_length("finet"."transactions"."notes") <= 2000),
	CONSTRAINT "transactions_external_ref_length" CHECK ("finet"."transactions"."external_ref" is null or char_length("finet"."transactions"."external_ref") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "finet"."accounts" ADD CONSTRAINT "accounts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."app_downloads" ADD CONSTRAINT "app_downloads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."app_events" ADD CONSTRAINT "app_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."app_events" ADD CONSTRAINT "app_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."categories" ADD CONSTRAINT "categories_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."categories" ADD CONSTRAINT "categories_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "finet"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."category_visibility" ADD CONSTRAINT "category_visibility_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."category_visibility" ADD CONSTRAINT "category_visibility_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "finet"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."client_installations" ADD CONSTRAINT "client_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transactions" ADD CONSTRAINT "transactions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transactions" ADD CONSTRAINT "transactions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transactions" ADD CONSTRAINT "transactions_account_fk" FOREIGN KEY ("account_id","household_id","currency") REFERENCES "finet"."accounts"("id","household_id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transactions" ADD CONSTRAINT "transactions_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "finet"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_household_name_active_key" ON "finet"."accounts" USING btree ("household_id",lower("name")) WHERE "finet"."accounts"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "accounts_owner_user_id_idx" ON "finet"."accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "app_downloads_created_at_idx" ON "finet"."app_downloads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_downloads_user_id_idx" ON "finet"."app_downloads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_events_occurred_at_idx" ON "finet"."app_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "app_events_user_id_idx" ON "finet"."app_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_events_household_id_idx" ON "finet"."app_events" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_system_key_key" ON "finet"."categories" USING btree ("system_key") WHERE "finet"."categories"."system_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_household_parent_name_key" ON "finet"."categories" USING btree ("household_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "finet"."categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "category_visibility_category_id_idx" ON "finet"."category_visibility" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "client_installations_user_id_idx" ON "finet"."client_installations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "finet"."idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "transactions_household_occurred_idx" ON "finet"."transactions" USING btree ("household_id","occurred_on" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_account_id_idx" ON "finet"."transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "transactions_category_id_idx" ON "finet"."transactions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transactions_created_by_user_id_idx" ON "finet"."transactions" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_household_external_ref_key" ON "finet"."transactions" USING btree ("household_id","external_ref") WHERE "finet"."transactions"."external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_transfer_group_direction_key" ON "finet"."transactions" USING btree ("transfer_group_id","transfer_direction") WHERE "finet"."transactions"."transfer_group_id" is not null;
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- Categoriile de sistem (5.4): household_id NULL, cheie stabilă `system_key`. Inserate ÎNAINTE de
-- activarea RLS (FORCE se aplică și proprietarului finet_migrator, care nu are politici aici).
-- Nu se pot șterge sau modifica de aplicație (politicile cer household_id = gospodăria curentă);
-- se ascund per gospodărie prin `category_visibility`.
insert into finet.categories (system_key, name, kind, sort_order) values
  ('expense.groceries', 'Alimente', 'expense', 1),
  ('expense.restaurants', 'Restaurante și cafenele', 'expense', 2),
  ('expense.housing', 'Locuință (chirie/rată)', 'expense', 3),
  ('expense.utilities', 'Utilități (curent, gaz, apă)', 'expense', 4),
  ('expense.internet_phone', 'Internet și telefonie', 'expense', 5),
  ('expense.transport', 'Transport și combustibil', 'expense', 6),
  ('expense.health', 'Sănătate și farmacie', 'expense', 7),
  ('expense.clothing', 'Îmbrăcăminte și încălțăminte', 'expense', 8),
  ('expense.children', 'Copii', 'expense', 9),
  ('expense.education', 'Educație', 'expense', 10),
  ('expense.entertainment', 'Divertisment', 'expense', 11),
  ('expense.subscriptions', 'Abonamente', 'expense', 12),
  ('expense.gifts_donations', 'Cadouri și donații', 'expense', 13),
  ('expense.taxes', 'Taxe și impozite', 'expense', 14),
  ('expense.insurance', 'Asigurări', 'expense', 15),
  ('expense.hoa', 'Asociația de proprietari (întreținere bloc)', 'expense', 16),
  ('expense.home_repairs', 'Casă și reparații', 'expense', 17),
  ('expense.personal_care', 'Igienă și cosmetice', 'expense', 18),
  ('expense.pets', 'Animale de companie', 'expense', 19),
  ('expense.travel', 'Vacanțe și călătorii', 'expense', 20),
  ('expense.other', 'Altele', 'expense', 21),
  ('income.salary', 'Salariu', 'income', 101),
  ('income.freelance', 'Freelance/PFA', 'income', 102),
  ('income.rent', 'Chirii încasate', 'income', 103),
  ('income.interest_dividends', 'Dobânzi și dividende', 'income', 104),
  ('income.refunds', 'Rambursări', 'income', 105),
  ('income.gifts', 'Cadouri primite', 'income', 106),
  ('income.other', 'Alte venituri', 'income', 107);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Triggerele de integritate. Toate sunt SECURITY INVOKER (implicit, scris explicit) cu
-- `search_path` fix: rulează cu drepturile și sub RLS-ul celui care scrie (finet_app, cu
-- contextul gospodăriei), deci un rând al altei gospodării e INVIZIBIL și e respins ca inexistent.
-- Contează: cheile străine simple (category_id, parent_id) sunt verificate de Postgres FĂRĂ RLS,
-- deci singure ar accepta categoria personalizată a altei gospodării.
-- ---------------------------------------------------------------------------------------------

-- Categorii: ierarhie pe un singur nivel, același tip, părinte de sistem sau din aceeași gospodărie.
create function finet.categories_check_parent() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v_parent record;
  begin
    if new.parent_id is null then
      return new;
    end if;
    select c.household_id, c.parent_id, c.kind into v_parent
      from finet.categories c
     where c.id = new.parent_id
       and (c.household_id is null or c.household_id = new.household_id);
    if not found then
      raise exception 'categories: categoria părinte nu există' using errcode = '23503';
    end if;
    if v_parent.parent_id is not null then
      raise exception 'categories: ierarhia are un singur nivel' using errcode = '23514';
    end if;
    if v_parent.kind <> new.kind then
      raise exception 'categories: părintele are alt tip' using errcode = '23514';
    end if;
    if exists (select 1 from finet.categories c where c.parent_id = new.id) then
      raise exception 'categories: o categorie cu subcategorii nu poate avea părinte'
        using errcode = '23514';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger categories_check_parent
  before insert or update of parent_id, kind on finet.categories
  for each row execute function finet.categories_check_parent();
--> statement-breakpoint
-- Vizibilitatea se setează doar pentru categoriile de SISTEM (cele personalizate au `hidden`).
create function finet.category_visibility_check() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if not exists (
      select 1 from finet.categories c where c.id = new.category_id and c.household_id is null
    ) then
      raise exception 'category_visibility: doar categoriile de sistem' using errcode = '23503';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger category_visibility_check
  before insert or update of category_id on finet.category_visibility
  for each row execute function finet.category_visibility_check();
--> statement-breakpoint
-- Tranzacții: contul (vizibil, din aceeași gospodărie, nearhivat la creare sau la mutare) și
-- categoria (de sistem sau a gospodăriei, de același tip cu tranzacția). Moneda = moneda
-- contului și gospodăria = gospodăria contului le garantează cheia compusă transactions_account_fk.
create function finet.transactions_check_refs() returns trigger
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
        raise exception 'transactions: contul nu există' using errcode = '23503';
      end if;
      if v_archived is not null then
        raise exception 'transactions: contul e arhivat' using errcode = '23514';
      end if;
    end if;
    if new.category_id is not null then
      select c.kind into v_kind
        from finet.categories c
       where c.id = new.category_id
         and (c.household_id is null or c.household_id = new.household_id);
      if not found then
        raise exception 'transactions: categoria nu există' using errcode = '23503';
      end if;
      if v_kind <> new.type then
        raise exception 'transactions: categoria are alt tip decât tranzacția'
          using errcode = '23514';
      end if;
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger transactions_check_refs
  before insert or update of account_id, category_id, type on finet.transactions
  for each row execute function finet.transactions_check_refs();
--> statement-breakpoint
-- Transferuri (5.1): un grup valid are exact două rânduri, unul `out` și unul `in`, pe conturi
-- diferite, în aceeași gospodărie; în aceeași monedă sumele sunt egale. Verificat la COMMIT
-- (constraint trigger DEFERRABLE INITIALLY DEFERRED), ca cele două rânduri să poată fi inserate
-- sau șterse pe rând în aceeași tranzacție. Un grup gol (ambele rânduri șterse) e valid.
create function finet.check_transfer_group(p_group uuid) returns void
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v record;
  begin
    if p_group is null then
      return;
    end if;
    select count(*) as n,
           count(*) filter (where t.transfer_direction = 'out') as n_out,
           count(*) filter (where t.transfer_direction = 'in') as n_in,
           count(distinct t.account_id) as n_accounts,
           count(distinct t.household_id) as n_households,
           count(distinct t.currency) as n_currencies,
           count(distinct t.amount_minor) as n_amounts,
           count(*) filter (where t.type <> 'transfer') as n_other
      into v
      from finet.transactions t
     where t.transfer_group_id = p_group;
    if v.n = 0 then
      return;
    end if;
    if v.n <> 2 or v.n_out <> 1 or v.n_in <> 1 or v.n_accounts <> 2 or v.n_households <> 1
       or v.n_other <> 0 then
      raise exception 'transactions: grup de transfer invalid' using errcode = '23514';
    end if;
    if v.n_currencies = 1 and v.n_amounts <> 1 then
      raise exception 'transactions: transfer în aceeași monedă cu sume diferite'
        using errcode = '23514';
    end if;
  end
  $$;
--> statement-breakpoint
create function finet.transactions_check_transfer_group() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if tg_op in ('UPDATE', 'DELETE') then
      perform finet.check_transfer_group(old.transfer_group_id);
    end if;
    if tg_op in ('INSERT', 'UPDATE')
       and new.transfer_group_id is distinct from
           (case when tg_op = 'UPDATE' then old.transfer_group_id end) then
      perform finet.check_transfer_group(new.transfer_group_id);
    end if;
    return null;
  end
  $$;
--> statement-breakpoint
create constraint trigger transactions_transfer_group_valid
  after insert or update or delete on finet.transactions
  deferrable initially deferred
  for each row execute function finet.transactions_check_transfer_group();
--> statement-breakpoint
revoke all on function finet.categories_check_parent(), finet.category_visibility_check(),
  finet.transactions_check_refs(), finet.check_transfer_group(uuid),
  finet.transactions_check_transfer_group() from public;
--> statement-breakpoint
grant execute on function finet.check_transfer_group(uuid) to finet_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat pe toate tabelele noi (model: 0001_rls.sql). Forma
-- `(select finet.member_role(finet.current_household_id()))` e evaluată o singură dată pe query
-- (initplan), nu pe fiecare rând.
-- ---------------------------------------------------------------------------------------------
alter table finet.accounts enable row level security;
--> statement-breakpoint
alter table finet.accounts force row level security;
--> statement-breakpoint
alter table finet.categories enable row level security;
--> statement-breakpoint
alter table finet.categories force row level security;
--> statement-breakpoint
alter table finet.category_visibility enable row level security;
--> statement-breakpoint
alter table finet.category_visibility force row level security;
--> statement-breakpoint
alter table finet.transactions enable row level security;
--> statement-breakpoint
alter table finet.transactions force row level security;
--> statement-breakpoint
alter table finet.idempotency_keys enable row level security;
--> statement-breakpoint
alter table finet.idempotency_keys force row level security;
--> statement-breakpoint
alter table finet.client_installations enable row level security;
--> statement-breakpoint
alter table finet.client_installations force row level security;
--> statement-breakpoint
alter table finet.app_events enable row level security;
--> statement-breakpoint
alter table finet.app_events force row level security;
--> statement-breakpoint
alter table finet.app_downloads enable row level security;
--> statement-breakpoint
alter table finet.app_downloads force row level security;
--> statement-breakpoint
create policy accounts_household on finet.accounts
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy category_visibility_household on finet.category_visibility
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy transactions_household on finet.transactions
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy idempotency_keys_household on finet.idempotency_keys
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
-- Categoriile: membrii văd categoriile de sistem și pe cele ale gospodăriei curente; scriu doar
-- în gospodăria curentă (rândurile de sistem au household_id NULL, deci nu pot fi modificate).
create policy categories_select on finet.categories
  for select to finet_app
  using ((household_id is null
          or household_id = (select finet.current_household_id()))
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy categories_insert on finet.categories
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy categories_update on finet.categories
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy categories_delete on finet.categories
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
-- Instalările: doar ale utilizatorului curent.
create policy client_installations_own on finet.client_installations
  for all to finet_app
  using (user_id = (select finet.current_user_id()))
  with check (user_id = (select finet.current_user_id()));
--> statement-breakpoint
-- Evenimentele: utilizatorul curent își scrie evenimentele (în gospodăria curentă, dacă e dată)
-- și le poate citi doar pe ale lui. Statisticile agregate (Faza 9) vin printr-o funcție dedicată.
create policy app_events_select on finet.app_events
  for select to finet_app
  using (user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy app_events_insert on finet.app_events
  for insert to finet_app
  with check (user_id = (select finet.current_user_id())
              and (household_id is null
                   or (household_id = (select finet.current_household_id())
                       and (select finet.member_role(finet.current_household_id())) is not null)));
--> statement-breakpoint
-- Descărcările: anonime sau ale utilizatorului curent; aplicația nu le citește (doar adăugare).
create policy app_downloads_insert on finet.app_downloads
  for insert to finet_app
  with check (user_id is null or user_id = (select finet.current_user_id()));
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime. UPDATE pe coloane: household_id,
-- created_by_user_id, source, transfer_group_id, transfer_direction, external_ref, id și
-- created_at nu se pot schimba după creare; `categories.kind` și `system_key` la fel.
-- ---------------------------------------------------------------------------------------------
revoke all on finet.accounts, finet.categories, finet.category_visibility, finet.transactions,
  finet.idempotency_keys, finet.client_installations, finet.app_events, finet.app_downloads
  from public;
--> statement-breakpoint
grant select, insert, delete on finet.accounts to finet_app;
--> statement-breakpoint
grant update (owner_user_id, name, type, currency, opening_balance_minor, bank_code, archived_at,
  updated_at) on finet.accounts to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.categories to finet_app;
--> statement-breakpoint
grant update (parent_id, name, icon, color, hidden, updated_at) on finet.categories to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.category_visibility to finet_app;
--> statement-breakpoint
grant update (hidden, updated_at) on finet.category_visibility to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.transactions to finet_app;
--> statement-breakpoint
grant update (account_id, category_id, type, amount_minor, currency, occurred_on, description,
  merchant, notes, updated_at) on finet.transactions to finet_app;
--> statement-breakpoint
-- idempotency_keys: DELETE doar în gospodăria curentă (eliberarea unei chei după o eroare).
-- Curățarea cheilor > 24 h rulează fără context de gospodărie: o funcție dedicată în F2-B.
grant select, insert, delete on finet.idempotency_keys to finet_app;
--> statement-breakpoint
grant update (response, status_code) on finet.idempotency_keys to finet_app;
--> statement-breakpoint
grant select, insert on finet.client_installations to finet_app;
--> statement-breakpoint
grant update (platform, app_version, version_code, os_version, device_model, locale, last_seen_at)
  on finet.client_installations to finet_app;
--> statement-breakpoint
grant select, insert on finet.app_events to finet_app;
--> statement-breakpoint
grant insert on finet.app_downloads to finet_app;
