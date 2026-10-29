-- FINET 0016_gdpr_stats (Faza 9, F9-B): ștergerea contului (GDPR), retenția evenimentelor de
-- utilizare (13 luni → agregat zilnic) și statisticile pentru administrator (master prompt 6.3
-- „GDPR”, 5.6, 6.5). Prima parte e generată de `drizzle-kit generate --name gdpr_stats` din
-- src/db/schema/usage.ts (tabelul `app_event_daily`; fișierul redenumit în 0016 și `when` din
-- jurnal fixat de mână la 1794600000000: numerele 0013–0015 sunt rezervate Fazei 7, jurnalul se
-- reconciliază la merge). A doua parte (după „PARTEA SCRISĂ DE MÂNĂ”) e scrisă o singură dată,
-- înainte de prima aplicare. Deciziile: docs/adr/0021-gdpr-retentie-statistici.md.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Efect pe tabelele existente: NICIO coloană nouă, nicio rescriere de date; doar politici noi
-- pentru finet_migrator (rolul funcțiilor SECURITY DEFINER), fiecare limitată de variabila
-- tranzacției `finet.definer_scope`, setată și resetată numai în funcțiile de mai jos:
--   - `erase_user` (finet.erase_current_user): conturile PERSONALE ale utilizatorului din
--     context, tranzacțiile lor și jumătățile comune ale transferurilor lor, bugetele lui
--     personale, descărcările lui;
--   - `events_retention` (finet.aggregate_app_events): evenimentele mai vechi de 13 luni;
--   - `usage_stats` (finet.usage_stats): citirea agregată a tabelelor de utilizare.
--
-- Rollback (manual, de operator; după rollback ștergerea contului din aplicație nu mai merge):
--   drop function finet.erase_current_user(), finet.aggregate_app_events(integer),
--     finet.usage_stats(boolean), finet.existing_households(uuid[]);
--   drop policy accounts_migrator_erase_select, accounts_migrator_erase_delete on finet.accounts;
--   drop policy transactions_migrator_erase_select, transactions_migrator_erase_update,
--     transactions_migrator_erase_delete on finet.transactions;
--   drop policy budgets_migrator_erase on finet.budgets;
--   drop policy app_downloads_migrator_erase_select, app_downloads_migrator_erase_update,
--     app_downloads_migrator_stats on finet.app_downloads;
--   drop policy app_events_migrator_read, app_events_migrator_retention_delete on finet.app_events;
--   drop policy client_installations_migrator_read on finet.client_installations;
--   drop policy audit_events_migrator_logins on finet.audit_events;
--   drop policy ai_calls_migrator_stats on finet.ai_calls;
--   drop table finet.app_event_daily;   -- PIERDE agregatele (evenimentele vechi sunt deja șterse)
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0016_gdpr_stats>';
CREATE TABLE "finet"."app_event_daily" (
	"day" date NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text DEFAULT '' NOT NULL,
	"screen" text DEFAULT '' NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"count" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_event_daily_pkey" PRIMARY KEY("day","name","platform","app_version","screen","error_code"),
	CONSTRAINT "app_event_daily_name_format" CHECK ("finet"."app_event_daily"."name" ~ '^[a-z][a-z0-9_.]{1,63}$'),
	CONSTRAINT "app_event_daily_platform_valid" CHECK ("finet"."app_event_daily"."platform" in ('android', 'web', 'unknown')),
	CONSTRAINT "app_event_daily_app_version_format" CHECK ("finet"."app_event_daily"."app_version" ~ '^[0-9A-Za-z.+_-]{0,32}$'),
	CONSTRAINT "app_event_daily_screen_format" CHECK ("finet"."app_event_daily"."screen" ~ '^([a-z][a-z0-9_.]{0,63})?$'),
	CONSTRAINT "app_event_daily_error_code_format" CHECK ("finet"."app_event_daily"."error_code" ~ '^([a-z][a-z0-9_.]{0,63})?$'),
	CONSTRAINT "app_event_daily_count_min" CHECK ("finet"."app_event_daily"."count" >= 1),
	CONSTRAINT "app_event_daily_day_min" CHECK ("finet"."app_event_daily"."day" >= date '2020-01-01'),
	CONSTRAINT "app_event_daily_day_max" CHECK ("finet"."app_event_daily"."day" <= date '2999-12-31')
);
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- app_event_daily: RLS ENABLE + FORCE; finet_app nu are NICIUN drept (scrie doar
-- finet.aggregate_app_events, citește doar finet.usage_stats). Proprietarul îl vede/scrie doar
-- în interiorul acestor funcții (variabila `finet.definer_scope`).
-- ---------------------------------------------------------------------------------------------
alter table finet.app_event_daily enable row level security;
--> statement-breakpoint
alter table finet.app_event_daily force row level security;
--> statement-breakpoint
revoke all on finet.app_event_daily from public;
--> statement-breakpoint
create policy app_event_daily_migrator_read on finet.app_event_daily
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) in ('events_retention', 'usage_stats'));
--> statement-breakpoint
create policy app_event_daily_migrator_insert on finet.app_event_daily
  for insert to finet_migrator
  with check (current_setting('finet.definer_scope', true) = 'events_retention');
--> statement-breakpoint
create policy app_event_daily_migrator_update on finet.app_event_daily
  for update to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'events_retention')
  with check (current_setting('finet.definer_scope', true) = 'events_retention');
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Politicile proprietarului pentru ștergerea contului (`erase_user`). Toate sunt limitate la
-- utilizatorul DIN CONTEXT; funcția mai filtrează o dată, explicit.
-- ---------------------------------------------------------------------------------------------
create policy accounts_migrator_erase_select on finet.accounts
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and owner_user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy accounts_migrator_erase_delete on finet.accounts
  for delete to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and owner_user_id = (select finet.current_user_id()));
--> statement-breakpoint
-- Tranzacțiile: cele din gospodăriile în care utilizatorul are conturi personale (cele de șters
-- și jumătatea comună a unui transfer personal ↔ comun, care după transformare trebuie să rămână
-- vizibilă: Postgres verifică rândul nou și față de politica SELECT) și rândurile de transfer. O
-- politică pe `transactions` nu poate interoga `transactions` (recursivitate), de aceea condiția
-- de transfer e doar `transfer_group_id is not null`; funcția restrânge la grupurile cu o
-- jumătate personală a utilizatorului.
create policy transactions_migrator_erase_select on finet.transactions
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and (transfer_group_id is not null
              or household_id in (select a.household_id from finet.accounts a
                                   where a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy transactions_migrator_erase_update on finet.transactions
  for update to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and transfer_group_id is not null)
  with check (current_setting('finet.definer_scope', true) = 'erase_user'
              and transfer_group_id is null);
--> statement-breakpoint
create policy transactions_migrator_erase_delete on finet.transactions
  for delete to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and account_id in (select a.id from finet.accounts a
                             where a.owner_user_id = (select finet.current_user_id())));
--> statement-breakpoint
create policy budgets_migrator_erase on finet.budgets
  for all to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and user_id = (select finet.current_user_id()))
  with check (current_setting('finet.definer_scope', true) = 'erase_user'
              and user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy app_downloads_migrator_erase_select on finet.app_downloads
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy app_downloads_migrator_erase_update on finet.app_downloads
  for update to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_user'
         and user_id = (select finet.current_user_id()))
  with check (current_setting('finet.definer_scope', true) = 'erase_user'
              and user_id is null);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Ștergerea contului (5.6, 6.3 „GDPR”). PASUL FINAL, după ce aplicația (finet_app, sub RLS-ul
-- utilizatorului) a șters gospodăriile în care era singurul membru, a ieșit din celelalte și a
-- șters sesiunile, conturile de autentificare, preferințele, instalările și evenimentele lui.
-- Garda: utilizatorul din context există, NU e administratorul platformei și NU mai e membru
-- nicăieri (altfel 42501).
-- Apoi, în toate gospodăriile (inclusiv cele părăsite mai demult, unde conturile lui personale
-- au rămas invizibile pentru toți, ADR 0016):
--   1. jumătatea COMUNĂ a unui transfer personal ↔ comun devine o tranzacție obișnuită
--      (`in` → venit, `out` → cheltuială, fără categorie): soldul contului comun nu se schimbă;
--   2. tranzacțiile din conturile lui personale se șterg (în cascadă: etichetele, împărțirile
--      acelor cheltuieli; ocurențele recurente și bonurile își pierd doar legătura);
--   3. conturile lui personale se șterg (în cascadă: regulile recurente; obiectivele își pierd
--      contul); bugetele lui personale se șterg; descărcările lui devin anonime;
--   4. rândul din `users`: se șterge dacă nimic nu-l mai referă; altfel (împărțiri sau decontări
--      cu alți membri, păstrate în istoricul lor) se ANONIMIZEAZĂ: nume „Cont șters”, email
--      `deleted-<id>@deleted.invalid`, status `disabled`. Conturile personale nu pot deveni
--      comune (`owner_user_id ON DELETE SET NULL` nu mai are pe cine atinge: au fost șterse la 3).
-- Întoarce DOAR `deleted` sau `anonymized`. Idempotentă: a doua oară, utilizatorul nu mai există
-- (`not_found`) sau e deja anonimizat (pașii nu mai găsesc nimic).
-- ---------------------------------------------------------------------------------------------
create function finet.erase_current_user() returns text
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_user uuid := finet.current_user_id();
  begin
    if v_user is null then
      raise exception 'erase_current_user: lipsește utilizatorul din context' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('finet.erase_user:' || v_user::text));
    if not exists (select 1 from finet.users u where u.id = v_user) then
      return 'not_found';
    end if;
    -- Administratorul platformei nu se șterge din aplicație: bootstrap-ul e irepetabil (0001,
    -- M5), deci platforma ar rămâne fără administrator; operatorul îl înlocuiește întâi.
    if exists (select 1 from finet.users u where u.id = v_user and u.is_platform_admin) then
      raise exception 'erase_current_user: administratorul platformei' using errcode = '42501';
    end if;
    if exists (select 1 from finet.household_members m where m.user_id = v_user) then
      raise exception 'erase_current_user: utilizatorul e încă membru al unei gospodării'
        using errcode = '42501';
    end if;
    perform set_config('finet.definer_scope', 'erase_user', true);

    update finet.transactions t
       set type = case when t.transfer_direction = 'in' then 'income' else 'expense' end,
           transfer_group_id = null,
           transfer_direction = null,
           updated_at = pg_catalog.now()
     where t.transfer_group_id is not null
       and t.transfer_group_id in (
             select p.transfer_group_id
               from finet.transactions p
               join finet.accounts pa on pa.id = p.account_id and pa.household_id = p.household_id
              where pa.owner_user_id = v_user
                and p.transfer_group_id is not null)
       and t.account_id not in (select a.id from finet.accounts a where a.owner_user_id = v_user);

    delete from finet.transactions t
     where t.account_id in (select a.id from finet.accounts a where a.owner_user_id = v_user);
    delete from finet.accounts a where a.owner_user_id = v_user;
    delete from finet.budgets b where b.user_id = v_user;
    update finet.app_downloads d set user_id = null where d.user_id = v_user;

    perform set_config('finet.definer_scope', '', true);
    begin
      delete from finet.users u where u.id = v_user;
      return 'deleted';
    exception when foreign_key_violation then
      update finet.users u
         set name = 'Cont șters',
             email = 'deleted-' || v_user::text || '@deleted.invalid',
             email_verified = false,
             image = null,
             status = 'disabled',
             updated_at = pg_catalog.now()
       where u.id = v_user;
      return 'anonymized';
    end;
  end
  $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Retenția evenimentelor (6.5, LOW-2 din ROADMAP): evenimentele mai vechi de 13 luni se agregă
-- în `app_event_daily` (zi locală, nume, platformă, versiune, ecran, cod de eroare) și se șterg,
-- în loturi (`p_limit` plafonat la 0..10000), serializat (lock). Întoarce DOAR numărul de
-- evenimente agregate. Rulată de comanda `finet-admin aggregate-events` (ca finet_app).
-- ---------------------------------------------------------------------------------------------
create policy app_events_migrator_read on finet.app_events
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) in ('events_retention', 'usage_stats'));
--> statement-breakpoint
create policy app_events_migrator_retention_delete on finet.app_events
  for delete to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'events_retention'
         and occurred_at < pg_catalog.now() - interval '13 months');
--> statement-breakpoint
create policy client_installations_migrator_read on finet.client_installations
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) in ('events_retention', 'usage_stats'));
--> statement-breakpoint
create function finet.aggregate_app_events(p_limit integer) returns integer
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_n integer;
  begin
    perform pg_advisory_xact_lock(hashtext('finet.aggregate_app_events'));
    perform set_config('finet.definer_scope', 'events_retention', true);
    with batch as (
      select e.id,
             (e.occurred_at at time zone 'Europe/Bucharest')::date as day,
             e.name,
             coalesce((select ci.platform from finet.client_installations ci
                        where ci.installation_id = e.installation_id
                          and ci.user_id = e.user_id
                        limit 1), 'unknown') as platform,
             coalesce(e.app_version, '') as app_version,
             coalesce(e.screen, '') as screen,
             coalesce(e.error_code, '') as error_code
        from finet.app_events e
       where e.occurred_at < pg_catalog.now() - interval '13 months'
       order by e.occurred_at, e.id
       limit least(greatest(coalesce(p_limit, 0), 0), 10000)
    ), gone as (
      delete from finet.app_events e using batch b where e.id = b.id
      returning b.day, b.name, b.platform, b.app_version, b.screen, b.error_code
    ), agg as (
      insert into finet.app_event_daily as d
             (day, name, platform, app_version, screen, error_code, count)
      select g.day, g.name, g.platform, g.app_version, g.screen, g.error_code, count(*)
        from gone g
       group by g.day, g.name, g.platform, g.app_version, g.screen, g.error_code
      on conflict (day, name, platform, app_version, screen, error_code)
      do update set count = d.count + excluded.count, updated_at = pg_catalog.now()
      returning 1
    )
    select count(*) into v_n from gone;
    perform set_config('finet.definer_scope', '', true);
    return v_n;
  end
  $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Statisticile (6.5) pentru administratorul platformei: DOAR numere agregate pe platformă,
-- versiune, zi, nume de eveniment, cod de eroare; nicio sumă, descriere, comerciant sau text din
-- datele financiare (nu citește conturi, tranzacții, bonuri). `p_include_members` (doar în modul
-- `personal`, decis de aplicație) adaugă lista utilizatorilor activi cu numele, ultima activitate,
-- platforma și versiunea (6.5 „Pe utilizator”). Cere un administrator activ (altfel 42501).
-- Costul AI (din `ai_calls`) e costul de operare al platformei, nu o dată financiară a
-- utilizatorilor.
-- ---------------------------------------------------------------------------------------------
create policy app_downloads_migrator_stats on finet.app_downloads
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'usage_stats');
--> statement-breakpoint
create policy audit_events_migrator_logins on finet.audit_events
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'usage_stats'
         and action = 'auth.login_succeeded');
--> statement-breakpoint
create policy ai_calls_migrator_stats on finet.ai_calls
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'usage_stats');
--> statement-breakpoint
create function finet.usage_stats(p_include_members boolean) returns jsonb
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_user uuid := finet.current_user_id();
    v_now timestamptz := pg_catalog.now();
    v_result jsonb;
  begin
    if v_user is null or not exists (
         select 1 from finet.users u
          where u.id = v_user and u.is_platform_admin and u.status = 'active') then
      raise exception 'usage_stats: doar administratorul platformei' using errcode = '42501';
    end if;
    perform set_config('finet.definer_scope', 'usage_stats', true);
    select jsonb_build_object(
      'generatedAt', v_now,
      'activeUsers', (
        select coalesce(jsonb_agg(x order by x->>'platform'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'platform', ci.platform,
                   'daily', count(distinct ci.user_id) filter (where ci.last_seen_at >= v_now - interval '1 day'),
                   'weekly', count(distinct ci.user_id) filter (where ci.last_seen_at >= v_now - interval '7 days'),
                   'monthly', count(distinct ci.user_id) filter (where ci.last_seen_at >= v_now - interval '30 days')) as x
            from finet.client_installations ci
           group by ci.platform) s),
      'sessionUsers', (
        select jsonb_build_object(
                 'daily', count(distinct s.user_id) filter (where s.updated_at >= v_now - interval '1 day'),
                 'weekly', count(distinct s.user_id) filter (where s.updated_at >= v_now - interval '7 days'),
                 'monthly', count(distinct s.user_id) filter (where s.updated_at >= v_now - interval '30 days'),
                 'expiredSessions', count(*) filter (where s.expires_at < v_now))
          from finet.auth_sessions s),
      'installations', (
        select coalesce(jsonb_agg(x order by x->>'platform', x->>'appVersion'), '[]'::jsonb) from (
          select jsonb_build_object('platform', ci.platform, 'appVersion', ci.app_version,
                                    'versionCode', ci.version_code, 'count', count(*)) as x
            from finet.client_installations ci
           where ci.last_seen_at >= v_now - interval '30 days'
           group by ci.platform, ci.app_version, ci.version_code) s),
      'downloads', (
        select coalesce(jsonb_agg(x order by x->>'version', x->>'source'), '[]'::jsonb) from (
          select jsonb_build_object('version', d.version, 'source', d.source, 'count', count(*)) as x
            from finet.app_downloads d
           group by d.version, d.source) s),
      'logins', (
        select coalesce(jsonb_agg(x order by x->>'day', x->>'platform'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'day', (a.created_at at time zone 'Europe/Bucharest')::date,
                   'platform', case when a.metadata->>'platform' = 'android' then 'android' else 'web' end,
                   'count', count(*)) as x
            from finet.audit_events a
           where a.action = 'auth.login_succeeded'
             and a.created_at >= v_now - interval '30 days'
           group by (a.created_at at time zone 'Europe/Bucharest')::date,
                    case when a.metadata->>'platform' = 'android' then 'android' else 'web' end) s),
      'features', (
        select coalesce(jsonb_agg(x order by (x->>'count')::bigint desc, x->>'name'), '[]'::jsonb) from (
          select jsonb_build_object('name', e.name, 'count', count(*)) as x
            from finet.app_events e
           where e.occurred_at >= v_now - interval '30 days'
             and e.name <> 'screen_view' and e.name <> 'error_shown'
           group by e.name) s),
      'screens', (
        select coalesce(jsonb_agg(x order by (x->>'count')::bigint desc, x->>'screen'), '[]'::jsonb) from (
          select jsonb_build_object('screen', e.screen, 'count', count(*)) as x
            from finet.app_events e
           where e.occurred_at >= v_now - interval '30 days'
             and e.name = 'screen_view' and e.screen is not null
           group by e.screen
           order by count(*) desc, e.screen
           limit 20) s),
      'errors', (
        select coalesce(jsonb_agg(x order by (x->>'count')::bigint desc, x->>'errorCode'), '[]'::jsonb) from (
          select jsonb_build_object('errorCode', e.error_code, 'appVersion', e.app_version,
                                    'count', count(*)) as x
            from finet.app_events e
           where e.occurred_at >= v_now - interval '30 days'
             and e.error_code is not null
           group by e.error_code, e.app_version
           order by count(*) desc, e.error_code
           limit 20) s),
      'ai', (
        select coalesce(jsonb_agg(x order by x->>'provider', x->>'result'), '[]'::jsonb) from (
          select jsonb_build_object('provider', c.provider, 'result', c.result, 'count', count(*),
                                    'avgDurationMs', round(avg(c.duration_ms))::bigint) as x
            from finet.ai_calls c
           where c.created_at >= v_now - interval '30 days'
           group by c.provider, c.result) s),
      'aiCost', (
        select coalesce(jsonb_agg(x order by x->>'month', x->>'currency'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'month', to_char(c.created_at at time zone 'Europe/Bucharest', 'YYYY-MM'),
                   'currency', c.cost_currency,
                   'costMinor', sum(c.cost_estimate_minor)::bigint) as x
            from finet.ai_calls c
           where c.cost_currency is not null
             and c.created_at >= date_trunc('month', v_now) - interval '2 months'
           group by to_char(c.created_at at time zone 'Europe/Bucharest', 'YYYY-MM'), c.cost_currency) s),
      'archivedEvents', (
        select coalesce(sum(d.count), 0)::bigint from finet.app_event_daily d),
      'members', case when coalesce(p_include_members, false) then (
        select coalesce(jsonb_agg(x order by x->>'name', x->>'userId'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'userId', u.id,
                   'name', u.name,
                   'lastSeenAt', greatest(li.last_seen_at, ls.updated_at),
                   'platform', li.platform,
                   'appVersion', li.app_version,
                   'versionCode', li.version_code) as x
            from finet.users u
            left join lateral (
              select ci.platform, ci.app_version, ci.version_code, ci.last_seen_at
                from finet.client_installations ci
               where ci.user_id = u.id
               order by ci.last_seen_at desc, ci.id
               limit 1) li on true
            left join lateral (
              select max(s.updated_at) as updated_at
                from finet.auth_sessions s
               where s.user_id = u.id) ls on true
           where u.status = 'active') s)
      else null end
    ) into v_result;
    perform set_config('finet.definer_scope', '', true);
    return v_result;
  end
  $$;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Fișierele orfane (revizuirea F9): comanda `finet-admin cleanup-orphan-storage` află care dintre
-- directoarele `households/<id>/` din storage NU mai au gospodărie în bază (o ștergere de cont al
-- cărei pas „fișiere după commit” a eșuat). `finet_app` nu vede gospodăriile în care nu e membru
-- (RLS), deci funcția (proprietarul citește `households` prin politica `households_migrator_read`)
-- întoarce DOAR id-urile primite care EXISTĂ, cel mult 1000 pe apel (doar identificatori).
-- ---------------------------------------------------------------------------------------------
create function finet.existing_households(p_ids uuid[]) returns setof uuid
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select h.id
      from finet.households h
     where h.id = any (p_ids[1:1000])
  $$;
--> statement-breakpoint
revoke all on function finet.erase_current_user(), finet.aggregate_app_events(integer),
  finet.usage_stats(boolean), finet.existing_households(uuid[]) from public;
--> statement-breakpoint
grant execute on function finet.erase_current_user(), finet.aggregate_app_events(integer),
  finet.usage_stats(boolean), finet.existing_households(uuid[]) to finet_app;
