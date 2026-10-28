-- FINET: rolul `finet_backup` pentru pg_dump (docs/BACKUP.md, „Rolul bazei de date”).
-- NEEXECUTAT de agent. Îl rulează operatorul, o singură dată, în DOI pași:
--
-- Pasul 1 (acest fișier, partea „ca postgres”): conectat ca utilizatorul `postgres` al
-- proiectului Supabase (ca la ops/supabase/roles.sql), creează rolul:
--   read -rs FINET_BACKUP_PASSWORD; export FINET_BACKUP_PASSWORD
--   psql "<url-postgres>?sslmode=verify-full&sslrootcert=<ca.crt>" -v step=role -f ops/backup/backup-role.sql
--
-- Pasul 2 (același fișier, partea „ca finet_migrator”): conectat ca `finet_migrator`
-- (proprietarul schemei; URL-ul migratorului), dă drepturile de citire pe schema `finet`, pe
-- obiectele existente ȘI pe cele create de migrațiile viitoare (privilegii implicite):
--   psql "<url-migrator>?sslmode=verify-full&sslrootcert=<ca.crt>" -v step=grants -f ops/backup/backup-role.sql
--   unset FINET_BACKUP_PASSWORD
--
-- De ce BYPASSRLS (verificat de ops/backup/restore-test.sh pe PostgreSQL 17 cu rolurile reale):
--   - pg_dump pune `row_security = off`; pentru un rol supus RLS asta dă EROARE la primul tabel
--     cu politici, nu un dump filtrat. Toate tabelele FINET au `FORCE ROW LEVEL SECURITY`, care
--     se aplică și proprietarului, deci nici `finet_migrator`, nici `finet_app` nu pot face dump.
--   - `--enable-row-security` ar „reuși”, dar ar scrie DOAR rândurile vizibile rolului (zero,
--     fără context de gospodărie): un backup gol care pare reușit. Nu se folosește.
--   - `pg_read_all_data` dă SELECT pe tot clusterul (inclusiv schema `auth` a Supabase) și NU
--     ocolește RLS; nu ajută și ar da mai mult decât trebuie.
-- Varianta cu cel mai mic privilegiu care produce un dump COMPLET: un rol dedicat, LOGIN,
-- BYPASSRLS, fără superuser/CREATEDB/CREATEROLE/replicare, cu USAGE pe schema `finet` și
-- SELECT pe tabelele și secvențele ei (nimic altceva: nu scrie, nu vede alte scheme).
--
-- DE VERIFICAT de operator pe Supabase: din PostgreSQL 16, doar un rol care are el însuși
-- BYPASSRLS poate crea un rol BYPASSRLS. Înainte de pasul 1:
--   select rolbypassrls, rolcreaterole from pg_roles where rolname = current_user;
-- Dacă `postgres` nu are BYPASSRLS, varianta de rezervă (mai largă) e dump-ul cu `postgres`
-- însuși, într-un fișier de servicii separat; vezi docs/BACKUP.md.
--
-- Parola: `openssl rand -base64 32` (fără `'`). Ca în roles.sql, `create role ... password`
-- ajunge la server ca text; varianta cu `\password` e în ops/supabase/README.md.

\set ON_ERROR_STOP on

\if :{?step}
\else
  do $$ begin raise exception 'Lipsește -v step=role sau -v step=grants.'; end $$;
\endif

select :'step' = 'role' as is_role_step, :'step' = 'grants' as is_grants_step \gset

\if :is_role_step
  \getenv backup_password FINET_BACKUP_PASSWORD
  \if :{?backup_password}
  \else
    do $$ begin raise exception 'Lipsește FINET_BACKUP_PASSWORD în mediu.'; end $$;
  \endif
  select length(:'backup_password') < 24 as parola_scurta \gset
  \if :parola_scurta
    do $$ begin raise exception 'Parola trebuie să aibă cel puțin 24 de caractere.'; end $$;
  \endif

  -- O singură tranzacție: dacă verificarea de mai jos eșuează, rolul nu rămâne creat.
  begin;
  -- Două sesiuni sunt de ajuns (un backup pe zi; restore-ul folosește migratorul).
  create role finet_backup login password :'backup_password'
    nosuperuser nocreatedb nocreaterole noreplication bypassrls
    connection limit 2;
  -- Sesiunile rolului sunt doar de citire. DOAR apărare în plus: un client poate face
  -- `set default_transaction_read_only = off`; protecția reală e că rolul are doar SELECT.
  alter role finet_backup set default_transaction_read_only = on;
  revoke create on schema public from finet_backup;

  select rolname, rolbypassrls, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole,
         rolreplication, rolconnlimit, rolconfig
    from pg_roles where rolname = 'finet_backup';
  -- Așteptat: false (revizuirea Fazei 3, LOW-4). Dacă e true (un GRANT vechi către PUBLIC pe
  -- Supabase), scriptul se oprește.
  select has_schema_privilege('finet_backup', 'public', 'CREATE') as create_in_public \gset
  \if :create_in_public
    do $$ begin raise exception 'finet_backup poate crea obiecte în schema public; revocă dreptul (și de la PUBLIC).'; end $$;
  \endif
  select 'finet_backup' as rol, false as create_in_public_asteptat, :'create_in_public' as create_in_public;
  commit;
\elif :is_grants_step
  begin;
  grant usage on schema finet to finet_backup;
  grant select on all tables in schema finet to finet_backup;
  grant select on all sequences in schema finet to finet_backup;
  -- Tabelele și secvențele create de migrațiile viitoare (ca finet_migrator): altfel backup-ul
  -- ar eșua (permission denied) la prima migrație cu un tabel nou.
  alter default privileges for role finet_migrator in schema finet
    grant select on tables to finet_backup;
  alter default privileges for role finet_migrator in schema finet
    grant select on sequences to finet_backup;
  commit;

  select count(*) as tabele_fara_select
    from pg_class c
   where c.relnamespace = 'finet'::regnamespace and c.relkind in ('r', 'p', 'S')
     and not has_table_privilege('finet_backup', c.oid, 'SELECT');
\else
  do $$ begin raise exception 'step trebuie să fie role sau grants.'; end $$;
\endif
