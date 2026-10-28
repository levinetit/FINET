-- FINET 0003_idempotency_purge (Faza 2, F2-B): curățarea cheilor `Idempotency-Key` mai vechi de
-- 24 de ore (master prompt 6.4). Scrisă de mână (fără tabele noi, deci fără snapshot drizzle).
-- Deciziile: docs/adr/0005-api-v1.md.
--
-- Curățarea rulează FĂRĂ context de gospodărie (comanda `finet-admin cleanup-idempotency`, ca
-- `finet_app`), deci politica `idempotency_keys_household` nu i-ar arăta niciun rând. Funcția de
-- mai jos rulează cu drepturile proprietarului (`finet_migrator`), pe care FORCE RLS îl supune
-- politicilor: cele două politici `*_migrator_purge` îi arată și îi permit să șteargă DOAR
-- rândurile mai vechi de 24 de ore (SELECT e necesar pentru că DELETE-ul citește `created_at`).
-- Funcția nu primește parametri: pragul e fix, deci un apelant nu poate șterge chei recente.
--
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Rollback (manual, de operator; nu atinge datele):
--   drop function finet.purge_idempotency_keys();
--   drop policy idempotency_keys_migrator_purge_select on finet.idempotency_keys;
--   drop policy idempotency_keys_migrator_purge_delete on finet.idempotency_keys;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0003_idempotency_purge>';
create policy idempotency_keys_migrator_purge_select on finet.idempotency_keys
  for select to finet_migrator
  using (created_at < now() - interval '24 hours');
--> statement-breakpoint
create policy idempotency_keys_migrator_purge_delete on finet.idempotency_keys
  for delete to finet_migrator
  using (created_at < now() - interval '24 hours');
--> statement-breakpoint
-- Șterge cheile mai vechi de 24 de ore și întoarce câte au fost șterse. Condiția e repetată și
-- aici (nu doar în politici), ca funcția să rămână corectă chiar dacă politicile se schimbă.
create function finet.purge_idempotency_keys() returns integer
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_count integer;
  begin
    delete from finet.idempotency_keys k
     where k.created_at < pg_catalog.now() - interval '24 hours';
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.purge_idempotency_keys() from public;
--> statement-breakpoint
grant execute on function finet.purge_idempotency_keys() to finet_app;
