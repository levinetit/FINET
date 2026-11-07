-- FINET 0027_net_worth (modernizare 2026, pasul G; ADR 0046): averea netă. DDL-ul generat de
-- drizzle-kit (din `src/db/schema/net-worth.ts` și `ledger.ts`) vine primul; după el sunt scrise de
-- mână RLS-ul și drepturile. NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts)
-- compară hash-ul.
--
-- Efect pe tabelele existente: `accounts_type_valid` e rescris (DROP + ADD în aceeași tranzacție)
-- ca să accepte tipurile noi de cont (`investment`, `property`, `vehicle`, `other_asset`, `loan`,
-- `other_liability`); rândurile existente rămân valide (lista veche e inclusă). Lock scurt pe
-- `accounts` (ADD CONSTRAINT CHECK verifică rândurile existente: câteva zeci per gospodărie).
--
-- `account_valuations`: valoarea unui cont evaluat la o dată, semnată ca un sold (activele
-- pozitive, pasivele negative), legată de cont prin cheia compusă (id, household_id, currency):
-- aceeași gospodărie ȘI aceeași monedă, garantat de bază. Fără instantanee ale averii: istoricul se
-- recalculează din tranzacții și evaluări, sub RLS-ul cititorului.
--
-- Rollback (manual, de operator, cu backup; pierde evaluările și refuză conturile cu tipuri noi
-- dacă există — de reclasificat întâi):
--   drop table finet.account_valuations;
--   alter table finet.accounts drop constraint accounts_type_valid;
--   alter table finet.accounts add constraint accounts_type_valid
--     check (type in ('cash', 'bank', 'savings', 'credit_card'));
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0027_net_worth>';
CREATE TABLE "finet"."account_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"valued_on" date NOT NULL,
	"value_minor" bigint NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_valuations_account_day_key" UNIQUE("account_id","valued_on"),
	CONSTRAINT "account_valuations_value_range" CHECK ("finet"."account_valuations"."value_minor" between -10000000000000 and 10000000000000),
	CONSTRAINT "account_valuations_valued_on_range" CHECK ("finet"."account_valuations"."valued_on" between '1900-01-01' and '2999-12-31'),
	CONSTRAINT "account_valuations_note_length" CHECK ("finet"."account_valuations"."note" is null or char_length("finet"."account_valuations"."note") <= 200),
	CONSTRAINT "account_valuations_currency_valid" CHECK ("finet"."account_valuations"."currency" in ('RON', 'EUR', 'USD'))
);
--> statement-breakpoint
ALTER TABLE "finet"."accounts" DROP CONSTRAINT "accounts_type_valid";--> statement-breakpoint
ALTER TABLE "finet"."account_valuations" ADD CONSTRAINT "account_valuations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."account_valuations" ADD CONSTRAINT "account_valuations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."account_valuations" ADD CONSTRAINT "account_valuations_account_fk" FOREIGN KEY ("account_id","household_id","currency") REFERENCES "finet"."accounts"("id","household_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_valuations_household_idx" ON "finet"."account_valuations" USING btree ("household_id","valued_on");--> statement-breakpoint
ALTER TABLE "finet"."accounts" ADD CONSTRAINT "accounts_type_valid" CHECK ("finet"."accounts"."type" in ('cash', 'bank', 'savings', 'credit_card', 'investment', 'property', 'vehicle', 'other_asset', 'loan', 'other_liability'));
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- RLS (ENABLE + FORCE) și drepturile, ca restul registrului (0002/0004): rândurile gospodăriei
-- curente, doar pentru membri; contul trebuie să fie vizibil cititorului (un cont personal al
-- altui membru nu apare în `accounts` sub RLS, deci nici evaluările lui: subinterogarea rulează
-- sub politica `accounts_household`).
alter table finet.account_valuations enable row level security;
--> statement-breakpoint
alter table finet.account_valuations force row level security;
--> statement-breakpoint
create policy account_valuations_household on finet.account_valuations
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.accounts a where a.id = account_valuations.account_id))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.accounts a where a.id = account_valuations.account_id));
--> statement-breakpoint
revoke all on finet.account_valuations from public;
--> statement-breakpoint
-- Fără UPDATE: o evaluare greșită se șterge și se reintroduce (istoricul rămâne simplu).
grant select, insert, delete on finet.account_valuations to finet_app;
