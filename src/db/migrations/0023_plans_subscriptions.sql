-- FINET 0023_plans_subscriptions (Faza 12-A, ADR 0035): planurile și abonamentele gospodăriilor,
-- baza implementării `saas` a `entitlements`. DDL-ul de mai jos e generat de drizzle-kit din
-- `src/db/schema/billing.ts`; partea de după el (RLS ENABLE + FORCE, drepturi, `household_plan`)
-- e scrisă de mână. NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară
-- hash-ul.
--
-- Nu se inserează NICIUN plan: limitele și prețurile sunt decizia operatorului (master prompt,
-- Faza 12) și se scriu ca `finet_migrator`, direct în bază (INFRA 4y). Aplicația (`finet_app`) are
-- doar SELECT pe ambele tabele: un server web compromis nu își poate acorda un plan.
--
-- `finet.household_plan(p_household)` întoarce MEREU un rând: planul abonamentului viu (stare
-- `ok`), altfel planul implicit (`ok` dacă gospodăria n-a avut niciodată abonament, `read_only`
-- dacă abonamentul a expirat sau a fost anulat), altfel `none` (nu există plan implicit: FAIL
-- CLOSED, nimic permis). Un abonament e viu dacă starea e `trialing`, `active` sau `past_due`
-- și sfârșitul perioadei (`trial_end` la probă) nu a trecut; fără sfârșit (manual, fondator) nu
-- expiră singur.
--
-- Rollback (manual, de operator, cu backup; pierde planurile și abonamentele):
--   drop function finet.household_plan(uuid);
--   drop table finet.subscriptions, finet.plans;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0023_plans_subscriptions>';
CREATE TABLE "finet"."plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_code_shape" CHECK ("finet"."plans"."code" ~ '^[a-z][a-z0-9_-]{1,31}$'),
	CONSTRAINT "plans_name_length" CHECK (char_length("finet"."plans"."name") >= 1 and char_length("finet"."plans"."name") <= 60 and "finet"."plans"."name" = btrim("finet"."plans"."name")),
	CONSTRAINT "plans_limits_object" CHECK (jsonb_typeof("finet"."plans"."limits") = 'object'),
	CONSTRAINT "plans_features_shape" CHECK (cardinality("finet"."plans"."features") <= 50 and array_to_string("finet"."plans"."features", ',') ~ '^[A-Za-z0-9.,]*$' and array_position("finet"."plans"."features", '') is null),
	CONSTRAINT "plans_default_active" CHECK (not "finet"."plans"."is_default" or "finet"."plans"."active")
);
--> statement-breakpoint
CREATE TABLE "finet"."subscriptions" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"provider_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_status_valid" CHECK ("finet"."subscriptions"."status" in ('trialing', 'active', 'past_due', 'canceled', 'expired')),
	CONSTRAINT "subscriptions_provider_valid" CHECK ("finet"."subscriptions"."provider" in ('manual', 'stripe', 'founder')),
	CONSTRAINT "subscriptions_provider_sub_length" CHECK ("finet"."subscriptions"."provider_subscription_id" is null or (char_length("finet"."subscriptions"."provider_subscription_id") >= 1 and char_length("finet"."subscriptions"."provider_subscription_id") <= 100)),
	CONSTRAINT "subscriptions_stripe_has_id" CHECK ("finet"."subscriptions"."provider" <> 'stripe' or "finet"."subscriptions"."provider_subscription_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "finet"."subscriptions" ADD CONSTRAINT "subscriptions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "finet"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_code_key" ON "finet"."plans" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_one_default" ON "finet"."plans" USING btree ("is_default") WHERE "finet"."plans"."is_default";--> statement-breakpoint
CREATE INDEX "subscriptions_plan_id_idx" ON "finet"."subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_provider_sub_key" ON "finet"."subscriptions" USING btree ("provider","provider_subscription_id") WHERE "finet"."subscriptions"."provider_subscription_id" is not null;
--> statement-breakpoint

-- plans: catalog citibil de orice utilizator autentificat; scris doar de operator (finet_migrator).
alter table finet.plans enable row level security;
--> statement-breakpoint
alter table finet.plans force row level security;
--> statement-breakpoint
create policy plans_select on finet.plans
  for select to finet_app
  using ((select finet.current_user_id()) is not null);
--> statement-breakpoint
create policy plans_operator on finet.plans
  for all to finet_migrator
  using (true) with check (true);
--> statement-breakpoint
revoke all on finet.plans from public;
--> statement-breakpoint
grant select on finet.plans to finet_app;
--> statement-breakpoint

-- subscriptions: membrii gospodăriei o citesc; scrisă doar de operator (finet_migrator).
alter table finet.subscriptions enable row level security;
--> statement-breakpoint
alter table finet.subscriptions force row level security;
--> statement-breakpoint
create policy subscriptions_select on finet.subscriptions
  for select to finet_app
  using ((select finet.member_role(household_id)) is not null);
--> statement-breakpoint
create policy subscriptions_operator on finet.subscriptions
  for all to finet_migrator
  using (true) with check (true);
--> statement-breakpoint
revoke all on finet.subscriptions from public;
--> statement-breakpoint
grant select on finet.subscriptions to finet_app;
--> statement-breakpoint

create function finet.household_plan(p_household uuid)
  returns table (plan_code text, limits jsonb, features text[], state text)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    with sub as (
      select s.status, s.code, s.limits, s.features,
             case when s.status = 'trialing' then coalesce(s.trial_end, s.current_period_end)
                  else s.current_period_end end as ends_at
        from (select x.status, x.trial_end, x.current_period_end, p.code, p.limits, p.features
                from finet.subscriptions x
                join finet.plans p on p.id = x.plan_id
               where x.household_id = p_household) s
    ),
    live as (
      select * from sub
       where status in ('trialing', 'active', 'past_due')
         and (ends_at is null or ends_at > pg_catalog.now())
       limit 1
    ),
    dflt as (
      select p.code, p.limits, p.features from finet.plans p where p.is_default and p.active
    )
    select coalesce(l.code, d.code) as plan_code,
           coalesce(l.limits, d.limits, '{}'::jsonb) as limits,
           coalesce(l.features, d.features, '{}'::text[]) as features,
           case when exists (select 1 from live) then 'ok'
                when exists (select 1 from sub) then 'read_only'
                when exists (select 1 from dflt) then 'ok'
                else 'none' end as state
      from (select 1) one
      left join live l on true
      left join dflt d on true
  $$;
--> statement-breakpoint
revoke all on function finet.household_plan(uuid) from public;
--> statement-breakpoint
grant execute on function finet.household_plan(uuid) to finet_app;
