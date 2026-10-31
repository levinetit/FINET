-- FINET 0025_referrals (Faza 12-C, ADR 0037): recomandări. Partea generată de drizzle-kit
-- (DDL din `src/db/schema/billing.ts`) vine prima; după ea sunt scrise de mână: RLS ENABLE +
-- FORCE, drepturile, rândul unic de setări, funcțiile SECURITY DEFINER și `household_plan`
-- redefinită. NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Recompensele sunt DATE ale operatorului (`finet.referral_settings`, un singur rând, scris ca
-- `finet_migrator`): planul acordat, zilele pentru invitat și pentru cel care invită, plafonul de
-- recompense per invitator și fereastra (ore) în care un cont nou poate folosi un cod. Migrația
-- inserează rândul cu 0 / lipsă = recompensele sunt OPRITE (fail closed); nu inventează nicio
-- valoare.
--
-- Regulile sunt în baza de date, nu în aplicație: `finet.redeem_referral(cod)` rulează ca invitat
-- și refuză auto-recomandarea (același utilizator sau o gospodărie comună), un al doilea cod
-- pentru același invitat, conturi neconfirmate sau dezactivate, conturi mai vechi decât fereastra
-- și depășirea plafonului invitatorului. Aplică recompensa prin `finet.grant_reward`, funcție
-- internă (fără drept de execuție pentru aplicație).
--
-- Un abonament acordat ca recompensă are `provider = 'reward'`. La expirare, `household_plan` îl
-- tratează ca absent (gospodăria revine la planul implicit), NU ca `read_only`: o recompensă care
-- se sfârșește nu trebuie să blocheze scrierile. Abonamentele `manual`, `founder`, `stripe` nu sunt
-- atinse niciodată de o recompensă.
--
-- Rollback (manual, de operator, cu backup; pierde codurile și recomandările):
--   delete from finet.subscriptions where provider = 'reward';
--   (apoi reface `finet.household_plan` din 0023 și constrângerea `subscriptions_provider_valid`
--    fără 'reward'; drop function finet.redeem_referral(text), finet.my_referral_code(),
--    finet.grant_reward(uuid, integer); drop table finet.referrals, finet.referral_codes,
--    finet.referral_settings;)
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0025_referrals>';
CREATE TABLE "finet"."referral_codes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_shape" CHECK ("finet"."referral_codes"."code" ~ '^FIN-[A-HJ-NP-Z2-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "finet"."referral_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"reward_plan_code" text,
	"invitee_days" integer DEFAULT 0 NOT NULL,
	"inviter_days" integer DEFAULT 0 NOT NULL,
	"inviter_max_rewards" integer DEFAULT 0 NOT NULL,
	"redeem_window_hours" integer DEFAULT 24 NOT NULL,
	CONSTRAINT "referral_settings_single" CHECK ("finet"."referral_settings"."id"),
	CONSTRAINT "referral_settings_ranges" CHECK ("finet"."referral_settings"."invitee_days" between 0 and 3650 and "finet"."referral_settings"."inviter_days" between 0 and 3650 and "finet"."referral_settings"."inviter_max_rewards" between 0 and 1000 and "finet"."referral_settings"."redeem_window_hours" between 1 and 720)
);
--> statement-breakpoint
CREATE TABLE "finet"."referrals" (
	"invitee_user_id" uuid PRIMARY KEY NOT NULL,
	"inviter_user_id" uuid NOT NULL,
	"invitee_rewarded" boolean DEFAULT false NOT NULL,
	"inviter_rewarded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_not_self" CHECK ("finet"."referrals"."invitee_user_id" <> "finet"."referrals"."inviter_user_id")
);
--> statement-breakpoint
ALTER TABLE "finet"."subscriptions" DROP CONSTRAINT "subscriptions_provider_valid";--> statement-breakpoint
ALTER TABLE "finet"."referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."referrals" ADD CONSTRAINT "referrals_invitee_user_id_users_id_fk" FOREIGN KEY ("invitee_user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."referrals" ADD CONSTRAINT "referrals_inviter_user_id_users_id_fk" FOREIGN KEY ("inviter_user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_codes_code_key" ON "finet"."referral_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "referrals_inviter_idx" ON "finet"."referrals" USING btree ("inviter_user_id");--> statement-breakpoint
ALTER TABLE "finet"."subscriptions" ADD CONSTRAINT "subscriptions_provider_valid" CHECK ("finet"."subscriptions"."provider" in ('manual', 'stripe', 'founder', 'reward'));
--> statement-breakpoint
insert into finet.referral_settings (id) values (true);
--> statement-breakpoint

-- RLS: toate trei, ENABLE + FORCE. Scrierea doar prin funcții (proprietar finet_migrator).
alter table finet.referral_settings enable row level security;
--> statement-breakpoint
alter table finet.referral_settings force row level security;
--> statement-breakpoint
create policy referral_settings_operator on finet.referral_settings
  for all to finet_migrator using (true) with check (true);
--> statement-breakpoint
revoke all on finet.referral_settings from public;
--> statement-breakpoint
alter table finet.referral_codes enable row level security;
--> statement-breakpoint
alter table finet.referral_codes force row level security;
--> statement-breakpoint
create policy referral_codes_select on finet.referral_codes
  for select to finet_app
  using (user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy referral_codes_operator on finet.referral_codes
  for all to finet_migrator using (true) with check (true);
--> statement-breakpoint
revoke all on finet.referral_codes from public;
--> statement-breakpoint
grant select on finet.referral_codes to finet_app;
--> statement-breakpoint
alter table finet.referrals enable row level security;
--> statement-breakpoint
alter table finet.referrals force row level security;
--> statement-breakpoint
create policy referrals_select on finet.referrals
  for select to finet_app
  using (inviter_user_id = (select finet.current_user_id())
         or invitee_user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy referrals_operator on finet.referrals
  for all to finet_migrator using (true) with check (true);
--> statement-breakpoint
revoke all on finet.referrals from public;
--> statement-breakpoint
grant select on finet.referrals to finet_app;
--> statement-breakpoint

-- Planul efectiv, redefinit: un abonament `reward` expirat NU blochează scrierile (revine la
-- planul implicit). Restul logicii e cea din 0023.
create or replace function finet.household_plan(p_household uuid)
  returns table (plan_code text, limits jsonb, features text[], state text)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    with sub as (
      select s.status, s.provider, s.code, s.limits, s.features,
             case when s.status = 'trialing' then coalesce(s.trial_end, s.current_period_end)
                  else s.current_period_end end as ends_at
        from (select x.status, x.provider, x.trial_end, x.current_period_end,
                     p.code, p.limits, p.features
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
                when exists (select 1 from sub where provider <> 'reward') then 'read_only'
                when exists (select 1 from dflt) then 'ok'
                else 'none' end as state
      from (select 1) one
      left join live l on true
      left join dflt d on true
  $$;
--> statement-breakpoint

-- Intern: acordă zile din planul de recompensă unei gospodării. Fără drept pentru aplicație.
create function finet.grant_reward(p_household uuid, p_days integer)
  returns boolean
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
  declare
    v_plan uuid;
    v_sub finet.subscriptions%rowtype;
  begin
    if p_household is null or p_days is null or p_days <= 0 then
      return false;
    end if;
    select p.id into v_plan
      from finet.referral_settings s
      join finet.plans p on p.code = s.reward_plan_code and p.active
     where s.id;
    if v_plan is null then
      return false;
    end if;
    select * into v_sub from finet.subscriptions where household_id = p_household for update;
    if not found then
      insert into finet.subscriptions (household_id, plan_id, status, provider, current_period_end)
      values (p_household, v_plan, 'active', 'reward',
              pg_catalog.now() + pg_catalog.make_interval(days => p_days));
      return true;
    end if;
    -- manual / founder / stripe: o recompensă nu le atinge niciodată.
    if v_sub.provider <> 'reward' then
      return false;
    end if;
    update finet.subscriptions
       set plan_id = v_plan,
           status = 'active',
           trial_end = null,
           cancel_at_period_end = false,
           current_period_end =
             greatest(coalesce(current_period_end, pg_catalog.now()), pg_catalog.now())
             + pg_catalog.make_interval(days => p_days),
           updated_at = pg_catalog.now()
     where household_id = p_household;
    return true;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.grant_reward(uuid, integer) from public;
--> statement-breakpoint

-- Codul propriu (FIN-XXXXXX), creat la prima cerere; același cod la cererile următoare.
create function finet.my_referral_code()
  returns text
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
  declare
    v_uid uuid := finet.current_user_id();
    v_code text;
    v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_bytes bytea;
    v_try integer := 0;
  begin
    if v_uid is null then
      raise exception 'my_referral_code: fără utilizator' using errcode = '42501';
    end if;
    select code into v_code from finet.referral_codes where user_id = v_uid;
    if found then
      return v_code;
    end if;
    if not exists (select 1 from finet.users u where u.id = v_uid and u.status = 'active') then
      return null;
    end if;
    loop
      v_try := v_try + 1;
      exit when v_try > 12;
      v_bytes := pg_catalog.uuid_send(pg_catalog.gen_random_uuid());
      v_code := 'FIN-';
      for i in 0..5 loop
        v_code := v_code
          || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i + 3) % 32) + 1, 1);
      end loop;
      insert into finet.referral_codes (user_id, code) values (v_uid, v_code)
        on conflict do nothing;
      select code into v_code from finet.referral_codes where user_id = v_uid;
      if found then
        return v_code;
      end if;
    end loop;
    raise exception 'my_referral_code: nu s-a putut genera un cod unic';
  end
  $$;
--> statement-breakpoint
revoke all on function finet.my_referral_code() from public;
--> statement-breakpoint
grant execute on function finet.my_referral_code() to finet_app;
--> statement-breakpoint

-- Folosește un cod, ca invitat. Întoarce: ok | disabled | not_eligible | expired | invalid | self |
-- already. Toate regulile sunt aici.
create function finet.redeem_referral(p_code text)
  returns text
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
  declare
    v_uid uuid := finet.current_user_id();
    v_set finet.referral_settings%rowtype;
    v_user finet.users%rowtype;
    v_inviter uuid;
    v_rows integer;
    v_rewarded_n integer;
    v_house_invitee uuid;
    v_house_inviter uuid;
    v_invitee_ok boolean := false;
    v_inviter_ok boolean := false;
  begin
    if v_uid is null then
      raise exception 'redeem_referral: fără utilizator' using errcode = '42501';
    end if;
    select * into v_set from finet.referral_settings where id;
    if not found or v_set.reward_plan_code is null
       or (v_set.invitee_days <= 0 and v_set.inviter_days <= 0) then
      return 'disabled';
    end if;
    select * into v_user from finet.users where id = v_uid;
    if not found or v_user.status <> 'active' or not v_user.email_verified then
      return 'not_eligible';
    end if;
    if v_user.created_at < pg_catalog.now() - pg_catalog.make_interval(hours => v_set.redeem_window_hours) then
      return 'expired';
    end if;
    select rc.user_id into v_inviter
      from finet.referral_codes rc
      join finet.users iu on iu.id = rc.user_id and iu.status = 'active'
     where rc.code = pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
    if v_inviter is null then
      return 'invalid';
    end if;
    if v_inviter = v_uid
       or exists (select 1
                    from finet.household_members a
                    join finet.household_members b on b.household_id = a.household_id
                   where a.user_id = v_uid and b.user_id = v_inviter) then
      return 'self';
    end if;
    -- Serializează recompensele aceluiași invitator (plafonul).
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_inviter::text, 0));
    insert into finet.referrals (invitee_user_id, inviter_user_id)
      values (v_uid, v_inviter)
      on conflict (invitee_user_id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return 'already';
    end if;
    select h.id into v_house_invitee from finet.households h
     where h.created_by = v_uid order by h.created_at, h.id limit 1;
    if v_house_invitee is not null then
      v_invitee_ok := finet.grant_reward(v_house_invitee, v_set.invitee_days);
    end if;
    select count(*) into v_rewarded_n from finet.referrals
     where inviter_user_id = v_inviter and inviter_rewarded;
    if v_rewarded_n < v_set.inviter_max_rewards then
      select h.id into v_house_inviter from finet.households h
       where h.created_by = v_inviter order by h.created_at, h.id limit 1;
      if v_house_inviter is not null then
        v_inviter_ok := finet.grant_reward(v_house_inviter, v_set.inviter_days);
      end if;
    end if;
    update finet.referrals
       set invitee_rewarded = v_invitee_ok, inviter_rewarded = v_inviter_ok
     where invitee_user_id = v_uid;
    return 'ok';
  end
  $$;
--> statement-breakpoint
revoke all on function finet.redeem_referral(text) from public;
--> statement-breakpoint
grant execute on function finet.redeem_referral(text) to finet_app;
