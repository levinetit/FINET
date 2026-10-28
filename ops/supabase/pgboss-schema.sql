-- FINET (Faza 5, ADR 0011): schema cozii pg-boss în proiectul Supabase.
-- NEEXECUTAT de agent. Îl rulează DOAR operatorul, o singură dată, ÎNAINTEA migrației
-- 0007_pgboss (finet-migrate), conectat ca utilizatorul `postgres` al proiectului:
--
--   psql "<url-postgres-din-panou>?sslmode=verify-full&sslrootcert=<ca.crt>" -f ops/supabase/pgboss-schema.sql
--
-- De ce operatorul: `finet_migrator` nu are CREATE pe bază (ops/supabase/roles.sql), deci nu
-- poate crea scheme; schema se creează aici, deținută de el, iar migrația 0007 îi adaugă tabelele,
-- funcțiile și drepturile minime ale lui `finet_app` (workerul). Idempotent.

\set ON_ERROR_STOP on

begin;

create schema if not exists pgboss authorization finet_migrator;

-- Niciun drept pentru PUBLIC și pentru rolurile Data API ale Supabase (schema nu se adaugă la
-- „Exposed schemas”); USAGE pentru finet_app îl dă migrația 0007.
revoke all on schema pgboss from public;
revoke all on schema pgboss from anon, authenticated;

alter default privileges for role finet_migrator in schema pgboss
  revoke all on tables from anon, authenticated, public;
alter default privileges for role finet_migrator in schema pgboss
  revoke all on sequences from anon, authenticated, public;
alter default privileges for role finet_migrator in schema pgboss
  revoke all on functions from anon, authenticated, public;

commit;

-- Verificare: proprietarul trebuie să fie finet_migrator; anon/authenticated fără USAGE.
select nspname, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss';
select r as rol, has_schema_privilege(r, 'pgboss', 'USAGE') as usage
  from unnest(array['anon', 'authenticated']) as r;
