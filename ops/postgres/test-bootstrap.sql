-- FINET: rolurile și schema pentru un PostgreSQL EFEMER de test (CI, dezvoltare locală).
-- NU se rulează pe producție (acolo: ops/supabase/roles.sql, rulat de operator).
--
-- Emulează ops/supabase/roles.sql: `finet_migrator` (proprietarul schemei `finet`, fără
-- superuser, fără BYPASSRLS) și `finet_app` (NOBYPASSRLS, doar USAGE pe schemă; drepturile pe
-- tabele vin din migrații), plus rolurile Data API ale Supabase (`anon`, `authenticated`), ca
-- NOLOGIN, ca testele să poată verifica faptul că nu primesc nimic.
--
-- Parolele de mai jos sunt FICTIVE, doar pentru containerul de test (rețea privată, șters după
-- rulare); nu sunt secrete și nu se folosesc nicăieri altundeva.
--
-- Idempotent: rolurile (globale în cluster) se creează doar dacă lipsesc, iar rularea în paralel
-- (mai multe fișiere de test, câte o bază fiecare) e tolerată. Se rulează ca superuser, conectat
-- la baza de test: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ops/postgres/test-bootstrap.sql`
-- sau din teste (src/db/testing.ts), ca un singur șir SQL.

do $$
begin
  begin
    create role finet_migrator login password 'finet_migrator_ci'
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 20;
  exception when duplicate_object or unique_violation then null;
  end;
  begin
    create role finet_app login password 'finet_app_ci'
      nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 50;
  exception when duplicate_object or unique_violation then null;
  end;
  begin
    create role anon nologin;
  exception when duplicate_object or unique_violation then null;
  end;
  begin
    create role authenticated nologin;
  exception when duplicate_object or unique_violation then null;
  end;
end
$$;

-- Ca în roles.sql. `alter role` modifică un catalog comun al clusterului; rulat în paralel (mai
-- multe fișiere de test) ar putea da `tuple concurrently updated`, deci doar dacă lipsește.
do $$
begin
  if not exists (
    select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
     where r.rolname = 'finet_app' and s.setdatabase = 0
       and 'search_path=finet' = any (s.setconfig)
  ) then
    alter role finet_app set search_path = finet;
  end if;
exception when others then
  -- O rulare concurentă a setat-o între timp; se verifică mai jos.
  null;
end
$$;
do $$
begin
  if not exists (
    select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole
     where r.rolname = 'finet_app' and s.setdatabase = 0
       and 'search_path=finet' = any (s.setconfig)
  ) then
    raise exception 'search_path pentru finet_app nu e setat';
  end if;
end
$$;

create schema if not exists finet authorization finet_migrator;
grant usage on schema finet to finet_app;
revoke create on schema public from finet_app, finet_migrator;
revoke all on schema finet from public;
revoke all on schema finet from anon, authenticated;

alter default privileges for role finet_migrator in schema finet
  revoke all on tables from anon, authenticated, public;
alter default privileges for role finet_migrator in schema finet
  revoke all on sequences from anon, authenticated, public;
alter default privileges for role finet_migrator in schema finet
  revoke all on functions from anon, authenticated, public;
