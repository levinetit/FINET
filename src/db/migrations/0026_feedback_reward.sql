-- FINET 0026_feedback_reward (Faza 12-C, felia 3, ADR 0037): recompensă pentru feedback validat de
-- administrator. DDL-ul generat de drizzle-kit (din `src/db/schema/billing.ts`) vine primul; după el
-- sunt scrise de mână: RLS, drepturile și funcția `finet.admin_reward_feedback`. NU modifica fișierul
-- după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Valorile sunt ale operatorului, în `finet.referral_settings` (aceleași ca la recomandări:
-- planul acordat, în `reward_plan_code`): `feedback_days` și `feedback_max_rewards` (plafon GLOBAL
-- de recompense). Implicit 0 = oprit (fail closed); migrația nu inventează nicio valoare.
--
-- „Validat de administrator” = administratorul apasă explicit acțiunea de recompensă pe un
-- feedback; nicio schimbare de stare nu acordă nimic singură. Regulile sunt în funcție, nu în
-- aplicație: doar administratorul platformei (altfel 42501), recompensă dezactivată, feedback
-- inexistent, autor = administratorul însuși, autor inactiv, o singură recompensă pe utilizator
-- (cheie primară), plafonul global (serializat cu un lock). Recompensa este un abonament `reward`
-- (`finet.grant_reward`, 0025): nu atinge abonamentele `manual`/`founder`/`stripe` (răspuns
-- `not_applicable`, nimic înregistrat).
--
-- Rollback (manual, de operator, cu backup; pierde evidența recompenselor acordate):
--   drop function finet.admin_reward_feedback(uuid);
--   drop policy feedback_migrator_select on finet.feedback;
--   drop table finet.feedback_rewards;
--   alter table finet.referral_settings drop column feedback_days, drop column feedback_max_rewards;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0026_feedback_reward>';
CREATE TABLE "finet"."feedback_rewards" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"feedback_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finet"."referral_settings" ADD COLUMN "feedback_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finet"."referral_settings" ADD COLUMN "feedback_max_rewards" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "finet"."feedback_rewards" ADD CONSTRAINT "feedback_rewards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."feedback_rewards" ADD CONSTRAINT "feedback_rewards_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "finet"."feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."referral_settings" ADD CONSTRAINT "referral_settings_feedback_days" CHECK ("finet"."referral_settings"."feedback_days" between 0 and 3650);--> statement-breakpoint
ALTER TABLE "finet"."referral_settings" ADD CONSTRAINT "referral_settings_feedback_max" CHECK ("finet"."referral_settings"."feedback_max_rewards" between 0 and 100000);
--> statement-breakpoint

-- Funcțiile SECURITY DEFINER rulează ca proprietar (finet_migrator, FORCE RLS): au nevoie să citească
-- feedback-ul. Politica e doar pentru acel rol; finet_app nu câștigă nimic.
create policy feedback_migrator_select on finet.feedback
  for select to finet_migrator using (true);
--> statement-breakpoint

alter table finet.feedback_rewards enable row level security;
--> statement-breakpoint
alter table finet.feedback_rewards force row level security;
--> statement-breakpoint
create policy feedback_rewards_select on finet.feedback_rewards
  for select to finet_app
  using (user_id = (select finet.current_user_id()) or (select finet.is_platform_admin()));
--> statement-breakpoint
create policy feedback_rewards_operator on finet.feedback_rewards
  for all to finet_migrator using (true) with check (true);
--> statement-breakpoint
revoke all on finet.feedback_rewards from public;
--> statement-breakpoint
grant select on finet.feedback_rewards to finet_app;
--> statement-breakpoint

create function finet.admin_reward_feedback(p_feedback uuid)
  returns text
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
  declare
    v_uid uuid := finet.current_user_id();
    v_set finet.referral_settings%rowtype;
    v_author uuid;
    v_house uuid;
    v_count integer;
  begin
    if not finet.is_platform_admin() then
      raise exception 'admin_reward_feedback: doar administratorul platformei'
        using errcode = '42501';
    end if;
    select * into v_set from finet.referral_settings where id;
    if not found or v_set.reward_plan_code is null
       or v_set.feedback_days <= 0 or v_set.feedback_max_rewards <= 0 then
      return 'disabled';
    end if;
    select f.user_id into v_author from finet.feedback f where f.id = p_feedback;
    if v_author is null then
      return 'not_found';
    end if;
    if v_author = v_uid then
      return 'self';
    end if;
    if not exists (select 1 from finet.users u where u.id = v_author and u.status = 'active') then
      return 'not_eligible';
    end if;
    -- Serializează acordările (plafonul global și „o dată pe utilizator”).
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('finet.feedback_reward', 0));
    if exists (select 1 from finet.feedback_rewards r where r.user_id = v_author) then
      return 'already';
    end if;
    select count(*) into v_count from finet.feedback_rewards;
    if v_count >= v_set.feedback_max_rewards then
      return 'capped';
    end if;
    select h.id into v_house from finet.households h
     where h.created_by = v_author order by h.created_at, h.id limit 1;
    if v_house is null or not finet.grant_reward(v_house, v_set.feedback_days) then
      return 'not_applicable';
    end if;
    insert into finet.feedback_rewards (user_id, feedback_id) values (v_author, p_feedback);
    return 'ok';
  end
  $$;
--> statement-breakpoint
revoke all on function finet.admin_reward_feedback(uuid) from public;
--> statement-breakpoint
grant execute on function finet.admin_reward_feedback(uuid) to finet_app;
