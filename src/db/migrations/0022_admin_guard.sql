-- FINET 0022_admin_guard (Faza 11, revizia de securitate, SECURITY_CHECKLIST §36): un administrator
-- al platformei nu mai poate dezactiva contul altui administrator. Până acum
-- `finet.admin_set_user_status` bloca doar propriul cont; un admin compromis putea deci scoate din
-- joc ceilalți administratori. Reactivarea unui administrator rămâne permisă (nu închide ușa
-- nimănui), iar un administrator poate fi dezactivat de operator, direct în bază.
-- Scrisă de mână: doar înlocuiește corpul funcției (aceeași semnătură, aceleași drepturi). NU
-- modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Rollback (manual, de operator): reia definiția din 0020_admin_feedback.sql (`create or replace`
--   fără verificarea `is_platform_admin` a țintei) și șterge rândul din `finet.__drizzle_migrations`
--   cu hash-ul acestei migrații.
create or replace function finet.admin_set_user_status(p_user uuid, p_status text) returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_changed integer;
  begin
    if not finet.is_platform_admin() then
      raise exception 'admin_set_user_status: doar administratorul platformei' using errcode = '42501';
    end if;
    if p_status is null or p_status not in ('active', 'disabled') then
      raise exception 'admin_set_user_status: stare nevalidă' using errcode = '22023';
    end if;
    if p_user is null or p_user = finet.current_user_id() then
      raise exception 'admin_set_user_status: nu îți poți schimba propriul cont' using errcode = '22023';
    end if;
    if p_status = 'disabled' and exists (
      select 1 from finet.users u where u.id = p_user and u.is_platform_admin) then
      raise exception 'admin_set_user_status: un administrator nu poate fi dezactivat' using errcode = '22023';
    end if;
    update finet.users set status = p_status, updated_at = pg_catalog.now() where id = p_user;
    get diagnostics v_changed = row_count;
    return v_changed = 1;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.admin_set_user_status(uuid, text) from public;
--> statement-breakpoint
grant execute on function finet.admin_set_user_status(uuid, text) to finet_app;
