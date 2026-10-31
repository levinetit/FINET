-- FINET 12-D (ADR 0036): planul „fondator” pentru gospodăriile EXISTENTE, la trecerea
-- `personal` → `saas`. Master prompt, 3.3 și Faza 12: gospodăriile existente primesc un plan
-- „fondator” fără limite. Se rulează O SINGURĂ DATĂ, ca `finet_migrator`, ÎNAINTE de a schimba
-- `APP_MODE=saas` (altfel gospodăriile fără abonament și fără plan implicit primesc 503
-- `plans_not_configured`), după backup și după `founder-plan-check.sql`:
--   psql "<url-migrator>?sslmode=verify-full&sslrootcert=<ca.crt>" -X -v ON_ERROR_STOP=1 \
--        --single-transaction -f ops/saas/founder-plan.sql
-- (`--single-transaction`: ori se aplică tot, ori nimic.)
--
-- Idempotent și neagresiv:
--   - planul `founder` se creează doar dacă lipsește (`on conflict do nothing`): dacă l-ai
--     modificat, scriptul NU îl rescrie;
--   - abonamentele se adaugă doar gospodăriilor FĂRĂ abonament (`on conflict do nothing`): un
--     abonament existent (manual, probă, plătit) rămâne neatins;
--   - NU creează planul implicit și nu atinge gospodăriile create după rulare: acelea primesc
--     planul implicit pe care îl alegi tu (INFRA 4y). Valorile lui nu sunt aici.
--
-- „Fără limite” înseamnă valoarea maximă întreagă sigură pentru fiecare limită numerică din
-- plan și toate funcțiile cunoscute (inclusiv istoric permanent de bonuri). `queue.priority`
-- lipsește (0): fondatorii nu trec în fața nimănui în coadă, echitatea din 0010 rămâne. Limitele
-- tehnice globale (`AI_MONTHLY_BUDGET`, dimensiunea maximă tehnică a fișierului) rămân valabile.
-- Abonamentul nu are sfârșit de perioadă, deci nu expiră singur.
--
-- Rollback (doar cu decizia operatorului; gospodăriile rămân fără abonament):
--   delete from finet.subscriptions where provider = 'founder';
--   delete from finet.plans where code = 'founder';

insert into finet.plans (code, name, is_default, limits, features)
values (
  'founder', 'Fondator', false,
  '{"ai.dailyDocuments": 9007199254740991,
    "storage.quotaMb": 9007199254740991,
    "household.maxMembers": 9007199254740991,
    "documents.maxFileMb": 9007199254740991}'::jsonb,
  array['ask.finet', 'reports.custom', 'documents.jpeg', 'documents.png', 'documents.webp',
        'documents.pdf', 'receipts.archive']
)
on conflict (code) do nothing;

insert into finet.subscriptions (household_id, plan_id, status, provider)
select h.id, p.id, 'active', 'founder'
  from finet.households h
  cross join (select id from finet.plans where code = 'founder' and active) p
on conflict (household_id) do nothing;

-- Raport: câte gospodării au acum abonament „fondator” și câte au rămas fără abonament.
select
  (select count(*) from finet.subscriptions where provider = 'founder') as abonamente_fondator,
  (select count(*) from finet.households h
    where not exists (select 1 from finet.subscriptions s where s.household_id = h.id)) as fara_abonament;
