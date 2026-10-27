-- FINET 0001_rls (Faza 1): Row-Level Security (master prompt 6.2, stratul 2), funcțiile de
-- context și drepturile rolului aplicației. Scrisă de mână (drizzle-kit nu exprimă FORCE RLS,
-- funcțiile SECURITY DEFINER și GRANT-urile).
--
-- Contextul vine din tranzacția curentă (src/db/rls.ts, `withRls`):
--   set_config('app.user_id', <uuid>, true), set_config('app.household_id', <uuid>, true)
-- Fără context, funcțiile întorc NULL și politicile nu lasă niciun rând.
--
-- Rolurile (ops/supabase/roles.sql): finet_migrator (proprietarul schemei, rulează migrațiile)
-- și finet_app (aplicația, NOBYPASSRLS). FORCE RLS face ca politicile să se aplice și
-- proprietarului: finet_migrator vede doar ce îi permit politicile `*_migrator_*` de mai jos
-- (households, household_members: SELECT, plus INSERT strict în interiorul
-- `finet.create_household`; necesare funcțiilor SECURITY DEFINER), restul tabelelor cu RLS îi
-- apar goale. Proprietarul poate totuși dezactiva RLS (ALTER TABLE): FORCE
-- protejează de greșeli, nu de proprietar.
--
-- Tabelele de autentificare (users, auth_*) NU au RLS: nu aparțin unei gospodării și le
-- folosește doar stratul de autentificare de pe server (ADR 0003).
--
-- Rollback (manual, de operator; după rollback izolarea în bază dispare, deci aplicația nu
-- trebuie să ruleze):
--   drop policy ... pe fiecare tabel (lista: select policyname, tablename from pg_policies
--     where schemaname = 'finet'), apoi
--   alter table finet.<tabel> no force row level security; ... disable row level security;
--   drop function finet.create_household(text, text, text), finet.member_role(uuid),
--     finet.promote_first_admin(uuid),
--     finet.current_household_id(), finet.current_user_id();
--   revoke all on all tables in schema finet from finet_app;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0001_rls>';

-- ---------------------------------------------------------------------------------------------
-- Funcțiile de context (SECURITY INVOKER): citesc variabilele tranzacției. Un șir gol sau
-- lipsă înseamnă „fără context” (NULL). O valoare care nu e uuid dă eroare (nu „fără context”);
-- codul validează uuid-urile înainte (src/db/rls.ts).
-- ---------------------------------------------------------------------------------------------
create function finet.current_user_id() returns uuid
  language sql stable parallel safe
  set search_path = pg_catalog
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
create function finet.current_household_id() returns uuid
  language sql stable parallel safe
  set search_path = pg_catalog
  as $$ select nullif(current_setting('app.household_id', true), '')::uuid $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Funcțiile SECURITY DEFINER (proprietar finet_migrator, `search_path` fix: numele sunt
-- calificate, iar un obiect cu același nume în altă schemă nu poate fi strecurat). Ele răspund
-- și acționează DOAR pentru utilizatorul DIN CONTEXT (nu primesc un user_id ca parametru).
-- ---------------------------------------------------------------------------------------------

-- Rolul utilizatorului curent în gospodărie (`owner`/`member`) sau NULL dacă nu e membru.
-- O politică pe household_members nu poate interoga household_members (recursivitate infinită
-- în RLS), deci verificarea rulează cu drepturile proprietarului, care vede tabelul prin
-- politica `household_members_migrator_read`.
create function finet.member_role(p_household_id uuid) returns text
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select m.role
      from finet.household_members m
     where m.household_id = p_household_id
       and m.user_id = finet.current_user_id()
  $$;
--> statement-breakpoint

-- Singura cale de creare a unei gospodării: gospodăria ȘI apartenența `owner` a utilizatorului
-- din context, atomic (aceeași tranzacție; o eroare la oricare le anulează pe amândouă).
-- Aplicația nu are INSERT pe households și nu există altă cale prin care cineva să devină
-- membru al unei gospodării existente, în afară de adăugarea de către un `owner` actual
-- (politica household_members_insert). Astfel un fost membru (inclusiv creatorul) nu se poate
-- „re-revendica” într-o gospodărie rămasă fără membri.
-- Variabila tranzacției `finet.creating_household` limitează politicile de INSERT ale
-- proprietarului (`*_migrator_insert`) la rândurile create aici.
create function finet.create_household(
  p_name text,
  p_default_currency text default 'RON',
  p_timezone text default 'Europe/Bucharest'
) returns uuid
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_user uuid := finet.current_user_id();
    v_id uuid := gen_random_uuid();
  begin
    if v_user is null then
      raise exception 'create_household: lipsește utilizatorul din context'
        using errcode = '42501';
    end if;
    if not exists (select 1 from finet.users u where u.id = v_user and u.status = 'active') then
      raise exception 'create_household: utilizator inexistent sau dezactivat'
        using errcode = '42501';
    end if;
    perform set_config('finet.creating_household', v_id::text, true);
    insert into finet.households (id, name, default_currency, timezone, created_by)
      values (v_id, p_name, coalesce(p_default_currency, 'RON'),
              coalesce(p_timezone, 'Europe/Bucharest'), v_user);
    insert into finet.household_members (household_id, user_id, role)
      values (v_id, v_user, 'owner');
    perform set_config('finet.creating_household', '', true);
    return v_id;
  end
  $$;
--> statement-breakpoint

-- Primul administrator al platformei (M5): aplicația nu are UPDATE pe `users.is_platform_admin`;
-- CLI-ul (`admin:create-user`) promovează utilizatorul DIN CONTEXT doar dacă nu există încă
-- niciun administrator. Serializată cu același lock ca crearea utilizatorilor din CLI.
create function finet.promote_first_admin(p_user_id uuid) returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  begin
    if p_user_id is null or p_user_id is distinct from finet.current_user_id() then
      raise exception 'promote_first_admin: doar utilizatorul din context'
        using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('finet.create_user'));
    if exists (select 1 from finet.users u where u.is_platform_admin) then
      return false;
    end if;
    update finet.users set is_platform_admin = true, updated_at = now()
     where id = p_user_id and status = 'active';
    return found;
  end
  $$;
--> statement-breakpoint

revoke all on function finet.current_user_id(), finet.current_household_id(),
  finet.member_role(uuid), finet.create_household(text, text, text),
  finet.promote_first_admin(uuid) from public;
--> statement-breakpoint
grant execute on function finet.current_user_id(), finet.current_household_id(),
  finet.member_role(uuid), finet.create_household(text, text, text),
  finet.promote_first_admin(uuid) to finet_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat (și pentru proprietar) pe tabelele cu household_id sau user_id.
-- ---------------------------------------------------------------------------------------------
alter table finet.households enable row level security;
--> statement-breakpoint
alter table finet.households force row level security;
--> statement-breakpoint
alter table finet.household_members enable row level security;
--> statement-breakpoint
alter table finet.household_members force row level security;
--> statement-breakpoint
alter table finet.audit_events enable row level security;
--> statement-breakpoint
alter table finet.audit_events force row level security;
--> statement-breakpoint
alter table finet.user_preferences enable row level security;
--> statement-breakpoint
alter table finet.user_preferences force row level security;
--> statement-breakpoint
alter table finet.consents enable row level security;
--> statement-breakpoint
alter table finet.consents force row level security;
--> statement-breakpoint

-- Politicile proprietarului, doar pe cele două tabele de care au nevoie funcțiile SECURITY
-- DEFINER de mai sus: citire, plus INSERT DOAR pentru gospodăria în curs de creare în
-- `finet.create_household` (variabila tranzacției `finet.creating_household`). Fără
-- UPDATE/DELETE pentru finet_migrator. Variabila nu dă nimic lui finet_app: politicile acestea
-- se aplică doar rolului finet_migrator.
create policy households_migrator_read on finet.households
  for select to finet_migrator using (true);
--> statement-breakpoint
create policy household_members_migrator_read on finet.household_members
  for select to finet_migrator using (true);
--> statement-breakpoint
create policy households_migrator_insert on finet.households
  for insert to finet_migrator
  with check (
    id = nullif(current_setting('finet.creating_household', true), '')::uuid
    and created_by = (select finet.current_user_id())
  );
--> statement-breakpoint
create policy household_members_migrator_insert on finet.household_members
  for insert to finet_migrator
  with check (
    household_id = nullif(current_setting('finet.creating_household', true), '')::uuid
    and user_id = (select finet.current_user_id())
    and role = 'owner'
  );
--> statement-breakpoint

-- --- households -------------------------------------------------------------------------------
-- Vizibilă doar membrilor (lista gospodăriilor mele). Fără politică de INSERT pentru
-- finet_app (și fără dreptul INSERT): crearea trece numai prin finet.create_household().
create policy households_select on finet.households
  for select to finet_app
  using (finet.member_role(id) is not null);
--> statement-breakpoint
create policy households_update on finet.households
  for update to finet_app
  using (id = (select finet.current_household_id()) and finet.member_role(id) = 'owner')
  with check (id = (select finet.current_household_id()) and finet.member_role(id) = 'owner');
--> statement-breakpoint
create policy households_delete on finet.households
  for delete to finet_app
  using (id = (select finet.current_household_id()) and finet.member_role(id) = 'owner');
--> statement-breakpoint

-- --- household_members ------------------------------------------------------------------------
-- Propriile apartenențe (în orice gospodărie) și membrii gospodăriei curente, dacă sunt membru.
create policy household_members_select on finet.household_members
  for select to finet_app
  using (
    user_id = (select finet.current_user_id())
    or (household_id = (select finet.current_household_id())
        and finet.member_role(household_id) is not null)
  );
--> statement-breakpoint
-- Doar un `owner` ACTUAL al gospodăriei curente adaugă pe cineva (admin:add-member, invitațiile
-- din Faza 8). Apartenența `owner` inițială o creează doar finet.create_household().
create policy household_members_insert on finet.household_members
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
              and finet.member_role(household_id) = 'owner');
--> statement-breakpoint
create policy household_members_update on finet.household_members
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and finet.member_role(household_id) = 'owner')
  with check (household_id = (select finet.current_household_id())
              and finet.member_role(household_id) = 'owner');
--> statement-breakpoint
-- Proprietarul scoate pe cineva din gospodăria curentă sau un membru pleacă singur.
create policy household_members_delete on finet.household_members
  for delete to finet_app
  using (
    (household_id = (select finet.current_household_id())
     and finet.member_role(household_id) = 'owner')
    or user_id = (select finet.current_user_id())
  );
--> statement-breakpoint

-- --- audit_events (doar adăugare) -------------------------------------------------------------
create policy audit_events_select on finet.audit_events
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and finet.member_role(household_id) is not null);
--> statement-breakpoint
create policy audit_events_insert on finet.audit_events
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
              and finet.member_role(household_id) is not null
              and actor_user_id = (select finet.current_user_id()));
--> statement-breakpoint

-- --- user_preferences și consents: doar ale utilizatorului curent -------------------------------
create policy user_preferences_own on finet.user_preferences
  for all to finet_app
  using (user_id = (select finet.current_user_id()))
  with check (user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy consents_select on finet.consents
  for select to finet_app
  using (user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy consents_insert on finet.consents
  for insert to finet_app
  with check (user_id = (select finet.current_user_id()));
--> statement-breakpoint
-- Revocarea se face prin `revoked_at` (istoricul rămâne; fără DELETE pentru aplicație).
create policy consents_update on finet.consents
  for update to finet_app
  using (user_id = (select finet.current_user_id()))
  with check (user_id = (select finet.current_user_id()));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime. Nimic pentru anon/authenticated/public (default
-- privileges din roles.sql + revocarea explicită de mai jos). Tabelul de evidență al
-- migrațiilor (__drizzle_migrations) rămâne doar al proprietarului.
-- ---------------------------------------------------------------------------------------------
revoke all on finet.users, finet.auth_sessions, finet.auth_accounts, finet.auth_verifications,
  finet.auth_rate_limits, finet.households, finet.household_members, finet.audit_events,
  finet.user_preferences, finet.consents from public;
--> statement-breakpoint
-- Tabelele de autentificare: drepturi PE COLOANE (M5). Aplicația nu poate scrie
-- `users.is_platform_admin`, `users.status`, `users.email` sau `users.id` după creare (un proces
-- compromis nu se poate face administrator, nu poate reactiva un cont și nu poate muta un cont
-- pe alt email); `is_platform_admin` se setează doar prin finet.promote_first_admin(), iar
-- `status` doar de operator. INSERT-ul în `users` are listă de coloane: `status` și
-- `is_platform_admin` iau valorile implicite (`active`, `false`).
-- Restul: ce scrie Better Auth (sesiuni prelungite, parola la resetare, verificări consumate).
grant select, delete on finet.users to finet_app;
--> statement-breakpoint
grant insert (id, name, email, email_verified, image, created_at, updated_at)
  on finet.users to finet_app;
--> statement-breakpoint
grant update (name, image, email_verified, updated_at) on finet.users to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.auth_sessions, finet.auth_accounts,
  finet.auth_verifications, finet.auth_rate_limits to finet_app;
--> statement-breakpoint
grant update (expires_at, updated_at) on finet.auth_sessions to finet_app;
--> statement-breakpoint
grant update (password, updated_at) on finet.auth_accounts to finet_app;
--> statement-breakpoint
grant update (value, expires_at, updated_at) on finet.auth_verifications to finet_app;
--> statement-breakpoint
grant update (count, last_request) on finet.auth_rate_limits to finet_app;
--> statement-breakpoint
-- households: fără INSERT (crearea doar prin finet.create_household()).
grant select, update, delete on finet.households to finet_app;
--> statement-breakpoint
grant select, insert, update, delete on finet.household_members, finet.user_preferences
  to finet_app;
--> statement-breakpoint
grant select, insert, update on finet.consents to finet_app;
--> statement-breakpoint
grant select, insert on finet.audit_events to finet_app;
