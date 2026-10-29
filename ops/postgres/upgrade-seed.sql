-- FINET: date de control DETERMINISTE pentru încercarea upgrade-ului major PostgreSQL
-- (ops/postgres/upgrade-test.sh, master prompt 3.5; F9-B, ADR 0021). Doar pe un PostgreSQL
-- EFEMER de test, DUPĂ migrații, ca superuser (ocolește RLS; triggerele de integritate rulează).
-- Fără date reale: nume, emailuri și sume inventate. NU se rulează pe producție.
--
-- Două gospodării: H1 (U1 owner, U2 membru; cont comun, cont personal al lui U1, o cheltuială
-- împărțită, un transfer personal → comun, o decontare) și H2 (U3 singur). Plus preferințe,
-- consimțăminte, o instalare, evenimente de utilizare (unul vechi de 14 luni) și un document.
begin;

insert into finet.users (id, email, name) values
  ('00000000-0000-4000-8000-000000000001', 'u1@upgrade.invalid', 'U1'),
  ('00000000-0000-4000-8000-000000000002', 'u2@upgrade.invalid', 'U2'),
  ('00000000-0000-4000-8000-000000000003', 'u3@upgrade.invalid', 'U3');

insert into finet.households (id, name, created_by) values
  ('00000000-0000-4000-8000-0000000000a1', 'H1', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-0000000000a2', 'H2', '00000000-0000-4000-8000-000000000003');

insert into finet.household_members (household_id, user_id, role) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'owner'),
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000002', 'member'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000003', 'owner');

insert into finet.user_preferences (user_id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003');

insert into finet.consents (user_id, kind) values
  ('00000000-0000-4000-8000-000000000001', 'usage_stats');

insert into finet.accounts (id, household_id, owner_user_id, name, type, currency) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', null, 'Comun', 'bank', 'RON'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Personal U1', 'cash', 'RON'),
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000a2', null, 'Numerar', 'cash', 'EUR');

insert into finet.transactions (id, household_id, account_id, created_by_user_id, type, amount_minor, currency, occurred_on, description) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'income', 500000, 'RON', '2026-10-01', 'Salariu (fictiv)'),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001', 'expense', 10001, 'RON', '2026-10-02', 'Cumpărături (fictiv)'),
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000003', 'expense', 2550, 'EUR', '2026-10-03', 'Cafea (fictiv)');

insert into finet.transactions (household_id, account_id, created_by_user_id, type, amount_minor, currency, occurred_on, transfer_group_id, transfer_direction) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001', 'transfer', 2500, 'RON', '2026-10-04', '00000000-0000-4000-8000-0000000000e1', 'out'),
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'transfer', 2500, 'RON', '2026-10-04', '00000000-0000-4000-8000-0000000000e1', 'in');

-- Cheltuiala personală a lui U1, împărțită cu U2 (suma părților = totalul: 5001 + 5000).
insert into finet.transaction_splits (household_id, transaction_id, payer_user_id, user_id, share_minor, currency) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 5001, 'RON'),
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 5000, 'RON');

insert into finet.settlements (household_id, from_user_id, to_user_id, amount_minor, currency, settled_on, created_by_user_id) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 2000, 'RON', '2026-10-05', '00000000-0000-4000-8000-000000000002');

insert into finet.client_installations (installation_id, user_id, platform, app_version, version_code) values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000001', 'android', '1.0.0', 100);

insert into finet.app_events (user_id, household_id, installation_id, name, app_version, occurred_at) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000f1', 'app_open', '1.0.0', now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000f1', 'app_open', '1.0.0', now() - interval '14 months');

insert into finet.documents (id, household_id, uploaded_by_user_id, status, storage_key, detected_mime, size_bytes, sha256) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000003', 'awaiting_consent',
   'households/00000000-0000-4000-8000-0000000000a2/documents/00000000-0000-4000-8000-0000000000b1', 'image/jpeg', 1234, repeat('a', 64));

commit;
