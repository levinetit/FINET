-- FINET: rolurile și schema în proiectul Supabase (master prompt 3.5).
-- NEEXECUTAT de agent. Îl rulează DOAR operatorul, o singură dată, cu psql (nu din SQL Editor:
-- variabilele psql `:'...'` nu funcționează acolo), conectat ca utilizatorul `postgres` al
-- proiectului (conexiunea directă sau pooler-ul în modul sesiune):
--
--   read -rs FINET_MIGRATOR_PASSWORD; export FINET_MIGRATOR_PASSWORD
--   read -rs FINET_APP_PASSWORD;      export FINET_APP_PASSWORD
--   psql "<url-postgres-din-panou>?sslmode=verify-full&sslrootcert=<ca.crt>" -f ops/supabase/roles.sql
--   unset FINET_MIGRATOR_PASSWORD FINET_APP_PASSWORD
--
-- Parolele se citesc din mediu (`\getenv`, psql 15+), ca să nu apară în argumente, în istoricul
-- shell-ului sau în fișier. Generare: openssl rand -base64 32 (fără caracterul `'`).
-- Scriptul nu e idempotent: dacă un rol există deja, se oprește la prima eroare.

\set ON_ERROR_STOP on

\getenv migrator_password FINET_MIGRATOR_PASSWORD
\getenv app_password FINET_APP_PASSWORD

-- O variabilă lipsă dă o eroare explicită (cod de ieșire ≠ 0), nu o oprire „reușită”.
\if :{?migrator_password}
\else
  do $$ begin raise exception 'Lipsește FINET_MIGRATOR_PASSWORD în mediu.'; end $$;
\endif
\if :{?app_password}
\else
  do $$ begin raise exception 'Lipsește FINET_APP_PASSWORD în mediu.'; end $$;
\endif
-- Parole prea scurte (inclusiv goale) sunt refuzate.
select length(:'migrator_password') < 24 or length(:'app_password') < 24 as parole_scurte \gset
\if :parole_scurte
  do $$ begin raise exception 'Parolele trebuie să aibă cel puțin 24 de caractere.'; end $$;
\endif

begin;

-- Proprietarul schemei; folosit doar pentru migrații.
create role finet_migrator login password :'migrator_password';

-- Rolul aplicației: doar drepturi pe date, supus RLS.
create role finet_app login password :'app_password' nobypassrls;

-- Schema FINET (nu `public`), deținută de migrator.
create schema finet authorization finet_migrator;

grant usage on schema finet to finet_app;

-- Niciun drept pentru rolurile Data API ale Supabase și pentru PUBLIC.
revoke all on schema finet from public;
revoke all on schema finet from anon, authenticated;

-- Tabelele, secvențele și funcțiile create ulterior de migrator nu primesc drepturi implicite
-- pentru anon/authenticated. Drepturile pentru finet_app le dau migrațiile, explicit.
alter default privileges for role finet_migrator in schema finet
  revoke all on tables from anon, authenticated, public;
alter default privileges for role finet_migrator in schema finet
  revoke all on sequences from anon, authenticated, public;
alter default privileges for role finet_migrator in schema finet
  revoke all on functions from anon, authenticated, public;

commit;

-- Verificare (rezultatul așteptat e în ops/supabase/README.md).
select rolname, rolbypassrls, rolsuper, rolcanlogin
  from pg_roles
 where rolname in ('finet_migrator', 'finet_app')
 order by rolname;

select nspname, pg_get_userbyid(nspowner) as owner
  from pg_namespace
 where nspname = 'finet';

select r as rol, has_schema_privilege(r, 'finet', 'USAGE') as usage
  from unnest(array['anon', 'authenticated', 'finet_app']) as r;
