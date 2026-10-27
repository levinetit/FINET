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
-- proprietarului: finet_migrator vede doar ce îi permit politicile `*_migrator_read` de mai jos
-- (households, household_members: doar SELECT, necesar funcțiilor SECURITY DEFINER), restul
-- tabelelor cu RLS îi apar goale. Proprietarul poate totuși dezactiva RLS (ALTER TABLE): FORCE
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
--   drop function finet.household_has_members(uuid), finet.can_claim_household(uuid),
--     finet.member_role(uuid),
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
-- Funcțiile de apartenență (SECURITY DEFINER, proprietar finet_migrator). O politică pe
-- household_members nu poate interoga household_members (recursivitate infinită în RLS), deci
-- verificarea „utilizatorul curent e membru” rulează cu drepturile proprietarului, care vede
-- tabelul prin politica `*_migrator_read`. `member_role` și `can_claim_household` răspund doar
-- despre utilizatorul DIN CONTEXT (nu primesc un user_id ca parametru), deci nu pot fi folosite
-- ca să afli apartenența altcuiva. Excepție: `household_has_members` (mai jos) răspunde pentru
-- orice id de gospodărie, dar spune doar „are / nu are membri” (risc rezidual: cine rulează SQL
-- arbitrar ca finet_app și cunoaște un uuid de gospodărie află dacă are membri; ADR 0003).
-- `search_path` fix: numele sunt calificate, iar un obiect cu același nume în altă schemă nu poate
-- fi strecurat.
-- ---------------------------------------------------------------------------------------------

-- Rolul utilizatorului curent în gospodărie (`owner`/`member`) sau NULL dacă nu e membru.
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

-- Gospodăria a fost creată de utilizatorul curent și nu are încă niciun membru: el se poate
-- adăuga ca `owner` (crearea gospodăriei personale, Faza 1; invitațiile vin în Faza 8).
create function finet.can_claim_household(p_household_id uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select exists (
             select 1 from finet.households h
              where h.id = p_household_id
                and h.created_by = finet.current_user_id()
           )
       and not exists (
             select 1 from finet.household_members m where m.household_id = p_household_id
           )
  $$;
--> statement-breakpoint

-- Gospodăria are cel puțin un membru (fără a spune care; vezi excepția de mai sus). Folosită de
-- politica de citire a gospodăriilor: rândul tocmai inserat nu e vizibil funcțiilor de mai sus în aceeași instrucțiune
-- (instantaneul instrucțiunii), deci `INSERT ... RETURNING` se bazează pe coloana `created_by` a
-- rândului plus această verificare.
create function finet.household_has_members(p_household_id uuid) returns boolean
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select exists (
      select 1 from finet.household_members m where m.household_id = p_household_id
    )
  $$;
--> statement-breakpoint

revoke all on function finet.current_user_id(), finet.current_household_id(),
  finet.member_role(uuid), finet.can_claim_household(uuid),
  finet.household_has_members(uuid) from public;
--> statement-breakpoint
grant execute on function finet.current_user_id(), finet.current_household_id(),
  finet.member_role(uuid), finet.can_claim_household(uuid),
  finet.household_has_members(uuid) to finet_app;
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

-- Citire pentru proprietar, doar pe cele două tabele de care au nevoie funcțiile SECURITY
-- DEFINER de mai sus. Fără INSERT/UPDATE/DELETE pentru finet_migrator.
create policy households_migrator_read on finet.households
  for select to finet_migrator using (true);
--> statement-breakpoint
create policy household_members_migrator_read on finet.household_members
  for select to finet_migrator using (true);
--> statement-breakpoint

-- --- households -------------------------------------------------------------------------------
-- Vizibilă membrilor (lista gospodăriilor mele) și creatorului cât timp nu are membri (ca
-- INSERT ... RETURNING să funcționeze înainte de adăugarea proprietarului).
create policy households_select on finet.households
  for select to finet_app
  using (
    finet.member_role(id) is not null
    or (created_by = (select finet.current_user_id()) and not finet.household_has_members(id))
  );
--> statement-breakpoint
create policy households_insert on finet.households
  for insert to finet_app
  with check (created_by = (select finet.current_user_id()));
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
-- Fie proprietarul gospodăriei curente adaugă pe cineva, fie creatorul unei gospodării fără
-- membri se adaugă pe sine ca `owner`.
create policy household_members_insert on finet.household_members
  for insert to finet_app
  with check (
    (household_id = (select finet.current_household_id())
     and finet.member_role(household_id) = 'owner')
    or (user_id = (select finet.current_user_id())
        and role = 'owner'
        and finet.can_claim_household(household_id))
  );
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
grant select, insert, update, delete on finet.users, finet.auth_sessions, finet.auth_accounts,
  finet.auth_verifications, finet.auth_rate_limits to finet_app;
--> statement-breakpoint
grant select, insert, update, delete on finet.households, finet.household_members,
  finet.user_preferences to finet_app;
--> statement-breakpoint
grant select, insert, update on finet.consents to finet_app;
--> statement-breakpoint
grant select, insert on finet.audit_events to finet_app;
