-- FINET 0021_purge_unverified (Faza 11, revizia de securitate, SECURITY_CHECKLIST §36): lista
-- conturilor de înregistrare publică rămase neconfirmate, pentru curățarea lor (`admin
-- cleanup-unverified`). Doar o funcție de CITIRE; ștergerea propriu-zisă o face codul aplicației,
-- cu aceeași logică de ștergere a contului ca la GDPR (ADR 0021), în contextul fiecărui utilizator.
-- Scrisă de mână (fără schimbări de schemă). NU modifica fișierul după aplicare: runner-ul
-- (src/db/migrate.ts) compară hash-ul.
--
-- Un cont intră în listă DOAR dacă: email neverificat, stare `active`, nu e administrator al
-- platformei, creat de cel puțin `p_days` zile (1..365), fără parolă, fără sesiune și fără să
-- împartă vreo gospodărie cu altcineva (un cont adăugat de un administrator într-o gospodărie nu
-- se atinge). Întoarce doar id-uri, cel mult `p_limit` (0..500), cele mai vechi întâi.
--
-- Rollback (manual, de operator):
--   drop function finet.stale_unverified_users(integer, integer);
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0021_purge_unverified>';
create function finet.stale_unverified_users(p_days integer, p_limit integer)
  returns table (user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select u.id
      from finet.users u
     where u.email_verified = false
       and u.status = 'active'
       and not u.is_platform_admin
       and u.created_at <= pg_catalog.now()
             - pg_catalog.make_interval(days => least(greatest(coalesce(p_days, 365), 1), 365))
       and not exists (select 1 from finet.auth_accounts a
                        where a.user_id = u.id and a.password is not null)
       and not exists (select 1 from finet.auth_sessions s where s.user_id = u.id)
       and not exists (select 1
                         from finet.household_members m
                         join finet.household_members o
                           on o.household_id = m.household_id and o.user_id <> u.id
                        where m.user_id = u.id)
     order by u.created_at, u.id
     limit least(greatest(coalesce(p_limit, 0), 0), 500)
  $$;
--> statement-breakpoint
revoke all on function finet.stale_unverified_users(integer, integer) from public;
--> statement-breakpoint
grant execute on function finet.stale_unverified_users(integer, integer) to finet_app;
