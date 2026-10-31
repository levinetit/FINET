-- FINET 12-D: verificare (DOAR CITIRE) înainte și după acordarea planului „fondator”.
-- Se rulează ca `finet_migrator`:
--   psql "<url-migrator>?sslmode=verify-full&sslrootcert=<ca.crt>" -X -v ON_ERROR_STOP=1 -f ops/saas/founder-plan-check.sql
-- Nu scrie nimic. Rezultat: o singură linie cu contoarele.
select
  (select count(*) from finet.households)                                           as gospodarii,
  (select count(*) from finet.subscriptions)                                        as cu_abonament,
  (select count(*) from finet.households h
    where not exists (select 1 from finet.subscriptions s where s.household_id = h.id)) as fara_abonament,
  (select count(*) from finet.plans where code = 'founder')                         as plan_fondator_exista,
  (select count(*) from finet.plans where is_default and active)                    as plan_implicit;
