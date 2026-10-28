# ADR 0011 — Recurențe și primul worker real (pg-boss pe Supabase)

- **Stare:** propus (F5-A, branch `phase/05-recurring`). Schema `pgboss` (operatorul), migrațiile `0006`/`0007` pe Supabase și pornirea workerului: operatorul (`docs/INFRA.md` 4g). API-ul și UI-ul: F5-B.
- **Legături:** master prompt Faza 5 (7), 3.2 (pg-boss), 3.5 (conexiuni), 5.1 (bani), 5.2 (date), 6.1 (`recurring_rules`, `recurring_occurrences`), 6.2 (RLS), 6.3; ADR 0002 (deploy), 0004 (registrul, plafoane), 0005 (garda 2^53), 0007 (calendarul).

## Context

Regulile recurente (abonamente, chirie, rate) trebuie să genereze tranzacții la scadență, **o singură dată per scadență**, atât din worker (orar), cât și la cerere („Generează tranzacțiile scadente”, F5-B). Workerul rulează ca `finet_app` (NOBYPASSRLS), deci nu vede nicio regulă fără contextul unei gospodării, iar contextul cere un **membru** (`member_role(current_household_id())`). `finet_migrator` nu are CREATE pe bază, deci nu poate crea schema pg-boss. Hostul are puțină memorie: ținta containerului e ≤ 150 MB.

## Decizii

### Datele (`0006_recurring`)

- `recurring_rules`: cont (cheie compusă `(account_id, household_id, currency)` → moneda = a contului, `ON DELETE CASCADE`: doar un cont gol se poate șterge, iar regula lui dispare), categorie opțională (`SET NULL`), `type` `income|expense` (fără transferuri în Faza 5), `amount_minor` 1..10^13, `description` obligatorie (1..500, **decizia mea**: e numele regulii în UI), `merchant`, `frequency` `daily|weekly|monthly|yearly`, `interval` 1..100 (**decizia mea**), `day_of_month` 1..31 obligatoriu la lunar/anual și interzis altfel (CHECK), `start_on`, `next_run_on` (următoarea scadență negenerată), `end_on`, `max_occurrences` 1..1200, `occurrences_count`, `status` `active|paused|completed`, `created_by_user_id`, plus `last_error_code` și `retry_after` (vezi „Fereastra workerului”). Tipul, `start_on`, gospodăria și creatorul nu se pot schimba (GRANT pe coloane).
- `recurring_occurrences`: **cheia primară `(rule_id, occurrence_date)` = garanția de idempotență**; `(rule_id, household_id)` → regulă (`CASCADE`); `(transaction_id, household_id)` → tranzacție cu `ON DELETE SET NULL (transaction_id)` și `DEFERRABLE INITIALLY DEFERRED`: dacă utilizatorul șterge tranzacția generată, ocurența rămâne, deci data **nu se regenerează**. `finet_app`: doar SELECT și INSERT.
- `transactions.recurring_rule_id` (din 0002, fără cheie) primește cheia compusă `(recurring_rule_id, household_id)` → regulă, `ON DELETE SET NULL (recurring_rule_id)`, adăugată `NOT VALID` apoi `VALIDATE` în aceeași migrație (fără rescrierea datelor; coloana era goală) și un index parțial. Ștergerea regulii păstrează tranzacțiile generate.
- Trigger `recurring_rules_check_refs` (SECURITY INVOKER, `search_path = pg_catalog`, ca în 0002): contul vizibil și nearhivat, categoria de sistem sau a gospodăriei, de același tip.
- RLS `ENABLE` + `FORCE` pe toate trei tabelele, politici pe gospodărie ca în 0002/0004. `service_heartbeats` (fără date de gospodărie): politică `using (true)` pentru `finet_app`, CHECK pe `service in ('worker')`.

### Selecția scadențelor fără BYPASSRLS

`finet.due_recurring_rules(p_today date, p_limit int)`: SECURITY DEFINER, proprietar `finet_migrator`, `search_path = pg_catalog`, EXECUTE doar pentru `finet_app` (revocat de la PUBLIC). FORCE RLS îi arată proprietarului din `recurring_rules` DOAR regulile active (politica `recurring_rules_migrator_due`); membrii îi vede prin politica existentă `household_members_migrator_read`.

- **Ieșirea: `(rule_id, household_id, actor_user_id)`** — **decizia mea, abatere de la brief** (care cerea doar `(rule_id, household_id)`): fără un membru, workerul nu poate intra în contextul RLS al gospodăriei (politicile cer `member_role`), deci nici citi regula. Actorul: creatorul regulii dacă e încă membru activ; altfel cel mai vechi proprietar activ; altfel regula e omisă. Fără sume, descrieri, conturi. Testat pe coloanele exacte.
- Garduri: `p_today` plafonat la data curentă din București (un apelant nu „vede în viitor” toate regulile active), `p_limit` la 0..1000; regulile cu `retry_after` în viitor sunt omise. Risc rezidual: un `finet_app` compromis poate afla id-urile regulilor scadente ale tuturor gospodăriilor (doar id-uri; `finet_app` are oricum drepturile datelor sub RLS).
- Generarea rulează apoi ca `finet_app`, prin `withMember` (apartenența verificată în bază), în contextul gospodăriei și al actorului; tranzacțiile au `created_by_user_id` = actorul.

### Generarea (idempotentă, cu recuperare limitată)

- O regulă = o tranzacție SQL: regula se blochează `FOR UPDATE SKIP LOCKED` (o generare paralelă o sare, nu așteaptă, nu dublează); pentru fiecare scadență ≤ azi se **revendică** întâi ocurența (`INSERT … ON CONFLICT DO NOTHING`, cu id-ul tranzacției generat în aplicație), apoi se creează tranzacția (`source = 'recurring'`, `recurring_rule_id`). Un conflict = deja generată → nu se scrie nimic. Orice eroare (inclusiv pe al doilea rând) anulează tot lotul regulii.
- **Recuperare limitată:** cel mult 12 scadențe pe regulă pe rulare (`MAX_CATCH_UP_PER_RUN`); restul la rularea următoare (o rată ratată 14 luni → 12 acum, 2 după).
- `next_run_on` avansează, `occurrences_count` crește doar pentru tranzacțiile create acum; regula trece la `completed` după `end_on` sau la `max_occurrences`.
- Garda 2^53 (`assertAccountsWithinJsonRange`) rulează după lot: o depășire anulează lotul (`MoneyOverflowError`).
- **Reluarea de pe pauză nu generează retroactiv:** scadența devine prima ≥ max(azi, scadența veche, ultima ocurență + 1 zi). O modificare a calendarului (frecvență, interval, zi) recalculează la fel.
- **Contul arhivat** pune regula pe pauză (`last_error_code = account_archived`, **decizia mea**): altfel ar eșua la fiecare rulare.
- „Azi” = data locală din `Europe/Bucharest` (**decizia mea**: fusul aplicației; `households.timezone` nu e încă folosit pentru recurențe).

### Calendarul

`src/lib/calendar.ts` (pe cifre, fără fus orar, deci DST nu deplasează datele): grila pornește din ancoră (`start_on`), a n-a dată se calculează direct, fără acumulare: ziua 31 → ultima zi a lunii, 29 februarie → 28 în anii nebisecți, **fără deplasarea zilei țintă** (31 ian → 28/29 feb → 31 mar). Lunar/anual: `day_of_month` (implicit ziua din `start_on`); anual: luna din `start_on`; săptămânal = 7 × interval zile.

### Fereastra workerului (fără înfometare)

O regulă care pică la fiecare rulare ar ocupa primul loc din `LIMIT` (ordinea e `next_run_on, id`) înaintea celor sănătoase. La eșec, workerul scrie (în altă tranzacție) `last_error_code` (cod fix: `amount_out_of_range`, `generation_failed`, …) și `retry_after = now() + 6 h`; funcția le omite până atunci. Testat cu `limit = 1` și regula stricată prima. Reluarea manuală (`resume`) șterge ambele câmpuri.

### pg-boss pe Supabase

- `pg-boss` **12.38.0** (MIT, fără scripturi de instalare; dependențe JS: `pg`, `cron-parser`, `rrule-temporal`, `serialize-error`; peer `@opentelemetry/api`, instalat automat de pnpm). Fără alternativă în dependențele existente; e decizia din master prompt (3.2).
- Schema `pgboss`: creată de **operator** (`ops/supabase/pgboss-schema.sql`, deținută de `finet_migrator`), populată de migrația **`0007_pgboss`**, generată de `scripts/pgboss-plan.mjs` din `getConstructionPlans('pgboss', { createSchema: false })`, fără `BEGIN`/`COMMIT`/`SET LOCAL` (runner-ul are tranzacția și lock-ul lui; un `COMMIT` din plan i-ar închide tranzacția) și despărțită în instrucțiuni (postgres.js nu trimite mai multe comenzi într-un mesaj). Prima instrucțiune verifică schema și proprietarul și eșuează explicit. **O versiune nouă a pg-boss cere o migrație nouă** (`getMigrationPlans`); testul `scripts/pgboss-plan.test.ts` pică dacă fișierul nu mai corespunde pachetului instalat.
- Workerul pornește cu `migrate: false`, `createSchema: false`, `reindex: false` (REINDEX cere proprietarul), `persistQueueStats: false` (partițiile zilnice ar cere CREATE TABLE), `persistWarnings: false`, cozi nepartiționate: **doar DML la rulare**. Verificat pe Postgres 17 efemer ca `finet_app` (pornire, cozi, programare, trimitere, procesare, mentenanță, oprire).
- Drepturile lui `finet_app` pe `pgboss`: USAGE pe schemă; SELECT/INSERT/UPDATE/DELETE pe `job`, `job_common`, `queue`, `schedule`, `subscription`, `job_dependency`, `instance`; doar SELECT pe `version`, `bam` (comenzile din `bam` sunt executate de pg-boss: workerul nu le poate scrie), `warning`, `queue_stats`; UPDATE pe `version` doar pe coloanele de timp ale monitoarelor; EXECUTE doar pe `job_now()` și `create_queue(text, jsonb)`. Nimic pentru PUBLIC/`anon`/`authenticated`. Tabelele pg-boss nu au RLS: nu conțin date financiare (joburile la cerere au doar id-ul gospodăriei și al membrului). Testat în `grants.test.ts`.
- TLS, **fail-closed** (corecție după review-ul automat de securitate, MEDIUM „TLS downgrade / parser differential”): pg-boss folosește `pg`, care **înlocuiește** opțiunea `ssl` cu ce deduce din parametrii URL-ului, deci CA-ul Supabase s-ar pierde în tăcere. `src/worker/boss.ts` acceptă DOAR un `sslmode` scris exact (`verify-full`, `verify-ca`, `require`, `disable`); orice alt parametru TLS în orice grafie (`ssl=…`, `SSLMODE`, `sslrootcert`, `uselibpqcompat`, `sslnegotiation`), o valoare goală/necunoscută (`no-verify`, `prefer`, `allow`) sau un duplicat → eroare la pornire (`PgTlsConfigError`, fără URL în mesaj); TLS-ul se dă apoi explicit, `ssl: { ca, rejectUnauthorized: true }`. După revizuirea `security` F5 (I2), regula e aceeași **în orice `NODE_ENV`**: `parseConfig` și `boss.ts` cer pentru `FINET_ROLE=worker` exact `sslmode=verify-full` și `DATABASE_CA_FILE` (oprire înaintea oricărei conexiuni). Singura excepție e explicită: `FINET_ALLOW_INSECURE_DB=1` (doar teste/CI, Postgres efemer fără TLS), refuzată în producție; numai cu ea se acceptă `disable`/lipsă, `require` sau `verify-*` fără CA. Testat fără rețea (`worker.test.ts`, `config.test.ts`) și cu bundle-ul real (refuză `sslmode=disable` în producție, cod 1).
- Conexiunea: pooler-ul în **modul sesiune (5432)**, `finet_app`, pool `pg` de 3 + postgres.js de 2.

### Joburile și procesul

- `recurring.generate`: cron `5 * * * *`, `Europe/Bucharest`, coadă `singleton` (cel mult un job activ) cu `singletonKey`; `recurring.generate-now`: pe gospodărie (`singletonKey` = gospodăria), date validate cu Zod (`householdId`, `userId`), membrul verificat de serviciu (altfel `not_member`, fără reîncercări). Reîncercări 2 (pauză 60 s, exponențial), expirare 10 min, retenție 7 zile.
- Logurile: linii JSON cu numele jobului, contoare și coduri; fără sume, descrieri, comercianți, id-uri sau mesaje de eroare (testat).
- Oprire grațioasă la SIGTERM/SIGINT: pg-boss termină jobul curent (≤ 25 s; `stop_grace_period: 35s`), apoi `stopped_at`, apoi închiderea pool-urilor.
- Workerul rulează din **imaginea de unelte** (`dist/tools/worker.mjs`, `scripts/build-tools.mjs`, cu `pg-boss`/`pg` externe): ieșirea standalone a Next.js nu conține pg-boss. Memorie măsurată (bundle-ul real, Postgres efemer fără TLS, înaintea regulii fail-closed din producție, `--memory=150m`, ~60 s cu programare și mentenanță): RSS de vârf ~86 MB, `memory.peak` al cgroup-ului ~97 MB. Compose: `mem_limit: 150m`, `--max-old-space-size=96`.

### `/api/health` → `queue`

Workerul scrie `finet.service_heartbeats` la pornire, la 60 s și la oprire; serverul web îl citește cu clientul de sănătate (fără pg-boss în web): fără rând sau oprit grațios → `unknown`; semnal > 180 s → `degraded` (starea generală `degraded`, 200, nu 503: workerul nu oprește serverul web); altfel `ok`. O eroare de citire → `unknown` (starea bazei o dă `db`).

### Plafoane anti-abuz la creare (revizuirea `security` F5, L2)

- cel mult **200 de reguli pe gospodărie** (orice stare) → 409 `recurring_limit_reached`; numărarea rulează sub un lock consultativ pe gospodărie (`pg_advisory_xact_lock`), deci două creări simultane nu trec amândouă de prag;
- `startOn` cel mult **5 ani** în urmă față de azi (București; 29 februarie → 28) → altfel 400 pe `startOn`;
- fără `maxOccurrences`, restanța inițială (scadențele de la început până azi sau până la `endOn`) cel mult **1200** → altfel 400 pe `startOn` (o regulă zilnică pornită acum 5 ani ar genera ~1.800 de tranzacții). Cu `maxOccurrences` (≤ 1200) plafonul e dat de numărul de rate.

### Reluarea unei reguli completate (revizuirea `security` F5, I4)

Codul se aliniază cu documentația (**decizia mea**: varianta cu cod, riscul e mic, aceeași funcție de calcul ca reluarea de pe pauză): `resume` pe o regulă `completed` e acceptat dacă, după o modificare a `endOn`/`maxOccurrences`, mai există scadențe (regula redevine `active`, de la prima scadență ≥ max(azi, scadența veche, ultima ocurență + 1 zi), deci tot fără retroactiv); altfel 409 `recurring_completed`, fără nicio schimbare.

### Workerul fără storage (revizuirea `security` F5, I1)

Workerul recurențelor nu atinge fișierele: serviciul `finet-worker` nu mai montează `storage`, iar `STORAGE_DIR` nu mai e cerut pentru rolul `worker`. Documentele (Faza 6) îl vor monta din nou, cu motivul notat.

### Riscuri acceptate și limitări cunoscute (revizuirea `security` F5)

- **L1 — același rol `finet_app` pentru web și worker:** serverul web (conectat tot ca `finet_app`) poate scrie `finet.service_heartbeats` și tabelele `pgboss.*` (de exemplu să falsifice semnalul de viață sau să insereze/anuleze joburi; joburile la cerere sunt totuși validate strict și membrul e verificat în bază). Remedierea reală e un rol `finet_worker` separat, cu drepturile pe `pgboss` și pe semnal mutate de pe `finet_app`; e **amânată**: cere un rol și un secret nou pe Supabase (pasul operatorului), un URL nou pentru worker și separarea drepturilor pe tabelele registrului pe care workerul le scrie sub RLS; de făcut odată cu cozile documentelor (Faza 6) sau la prima revizuire a rolurilor.
- **`due_recurring_rules` nu adaugă expunere nouă** (argumentul revizuirii): un `finet_app` compromis poate deja enumera utilizatorii (SELECT pe `users`, tabel de autentificare fără RLS) și gospodăriile lor (politicile pe `household_members` arată propriile apartenențe; `member_role` e apelabil), deci id-urile regulilor scadente, fără sume sau descrieri, nu schimbă clasa de risc.
- **I3 — semnalul de viață arată doar că procesul trăiește**, nu că joburile reușesc: un worker care pornește dar pică la fiecare job apare `ok`. TODO: un semnal pe ultimul job terminat (momentul și rezultatul ultimei rulări `recurring.generate`) și `degraded` dacă lipsește peste 2 ore.
- **I5 — rollback total cu `Idempotency-Key`:** generarea la cerere prin API rulează într-o tranzacție externă (înregistrarea cheii de idempotență); dacă cererea eșuează, rollback-ul anulează și înregistrarea eșecului pe regulă (`last_error_code`/`retry_after`). Efectul: eșecul nu apare în UI până la rularea workerului; nu se pierd și nu se dublează date.

## Consecințe

- Pași noi pentru operator, în ordine: schema `pgboss` → `finet-migrate` (`0006`, `0007`) → `finet-worker` (`docs/INFRA.md` 4g).
- F5-B adaugă API-ul și UI-ul peste serviciile din `src/modules/recurring/` (butonul poate apela `generateDueForHousehold` direct, aceleași garanții, sau trimite `recurring.generate-now`).
- Rămân deschise: fusul gospodăriei pentru „azi”, reasignarea creatorului unei reguli (azi: fallback pe proprietar), transferurile recurente, detectarea din extrase (Faza 7), notificările.
