# Raportul Fazei 3 — Dashboard, bugete, obiective, etichete, rapoarte, export CSV, backup

- **Branch:** `phase/03-dashboard` (din `main` la `e423b44`), fără push din partea agentului.
- **Data:** 2026-10-28.
- **Stare:** **parțial**. F3-A (date și servicii), F3-B (API) și F3-C (interfața, E2E, documentația) sunt în repo. F3-D (backup restic + restaurare testată pe PostgreSQL efemer) e în repo. Rămân: instalarea backup-ului și restaurarea de probă pe producție (operatorul — **fără backup testat nu se introduc date reale**), aplicarea migrației `0004` pe Supabase (operatorul), prima rulare a job-ului `e2e` cu proiectul `planning` pe GitHub, revizuirea `security`.
- Decizii: [ADR 0007](../adr/0007-planning-reporting.md) (date, servicii, API), [ADR 0008](../adr/0008-planning-ui.md) (interfața). Securitatea: [`docs/SECURITY_CHECKLIST.md`](../SECURITY_CHECKLIST.md), secțiunile 11–12. API: [`docs/API.md`](../API.md).

## 1. Ce s-a implementat

**F3-A — date și servicii:** migrația `0004_budgets_goals_tags` (etichete, vizibilitatea lor, legăturile cu tranzacțiile, bugete, obiective; RLS `ENABLE` + `FORCE`, bugetele personale doar ale proprietarului, drepturi pe coloane), serviciile etichetelor, bugetelor (semafor în întregi), obiectivelor (stare calculată, contribuții), dashboard-ului, raportului lunar și exportului CSV; corecțiile LOW-1, LOW-2 și INFO din revizuirea Fazei 2. Detalii: ADR 0007.

**F3-B — API:** rutele `/api/v1/tags`, `budgets` (+ `status`), `goals` (+ `contributions`, `abandon`), `dashboard`, `reports/monthly`, `exports/*.csv`; `tags` în răspunsurile de tranzacție, filtrele `tagIds`/`merchant`, luna validată, rate limit și audit pe exporturi, OpenAPI. Detalii: ADR 0007, „API (F3-B)”.

**F3-C — interfața (ADR 0008):**
- `/dashboard`: selector de lună (ultimele 12, `?month=`), carduri Venituri/Cheltuieli/Sold net/Tranzacții pe monedă cu comparația față de luna anterioară, graficele „Cheltuieli pe categorii”, „Evoluție lunară”, „Trend zilnic” (SVG fără bibliotecă, cu tabel text), bugetele lunii cu semafor, avertizarea bugetelor, obiectivele active, onboarding-ul în 3 pași, soldurile și ultimele tranzacții, gospodăria;
- `/transactions`: filtrele noi „Comerciantul” și „Etichetele” (oricare), etichetele pe rânduri (și la „Încarcă mai mult”), „Export CSV” cu filtrele aplicate; formularul tranzacției cu etichete (cel mult 10; la editare se păstrează cele curente, inclusiv ascunse);
- `/tags`: etichetele de sistem (ascundere) și ale gospodăriei (creare, redenumire, culoare, ascundere, ștergere cu confirmare);
- `/budgets`, `/budgets/new`, `/budgets/[id]`: semaforul pe luna aleasă, cheltuit/rămas/depășire, pragul pe bară, avertizarea, crearea (general sau pe categorie, prag, `household|personal`), editarea limitei și a pragului, arhivarea, ștergerea, exportul lunii;
- `/goals`, `/goals/new`, `/goals/[id]`: obiectivele pe stări, progresul, crearea/editarea, contribuțiile (adaugă/scade, `Idempotency-Key` mereu), abandonarea/reluarea, ștergerea, exportul;
- `/reports`: raportul lunii (totaluri pe monedă, categorii cu subcategorii, comercianții principali, bugete, obiective) și cele trei exporturi CSV (`dialect=ro`);
- navigarea: meniul lateral complet pe desktop; pe telefon Acasă, Tranzacții, Bugete, Rapoarte și „Mai mult”;
- descărcarea CSV prin `fetch` cu cookie (fără token în URL), mesaje clare la 409 `export_too_large` și 429;
- E2E `e2e/planning.spec.ts` (8 scenarii), proiectul `planning`, utilizatorii `planning`/`planning2` în CI, rulat în ambele moduri;
- teste unitare noi: `src/app/_lib/{planning-ui,download}.test.ts`, extinderea `transaction-filters.test.ts` (etichete, comerciant, export).

**Parțial sau neimplementat:**
- **F3-D (backup restic, restaurare testată):** implementat, vezi „F3-D — backup” mai jos; instalarea pe server și primul backup real: operatorul.
- E2E în browser: **NOT RUN** local (fără browsere pe host); prima rulare e în job-ul `e2e`.
- `pnpm build` și `pnpm scan:client-secrets`: **NOT RUN** local (memoria hostului, vezi 3); le rulează CI-ul.
- Datele paginilor Fazei 2 rămân „28 oct. 2026” (paginile noi folosesc `28.10.2026`, 5.3); datele demo din onboarding, axe în E2E, insigna de avertizare în meniu: amânate (ADR 0008).

## 2. Fișiere (F3-C)
- Pagini noi: `src/app/(app)/tags/{page,tags-manager}.tsx`, `budgets/{page,budget-form}.tsx`, `budgets/new/page.tsx`, `budgets/[id]/page.tsx`, `goals/{page,goal-form}.tsx`, `goals/new/page.tsx`, `goals/[id]/{page,goal-actions}.tsx`, `reports/page.tsx`.
- Pagini modificate: `src/app/(app)/dashboard/page.tsx`, `transactions/{page,transactions-list,transaction-form}.tsx`, `transactions/new/page.tsx`, `transactions/[id]/page.tsx`.
- Biblioteci: `src/app/_lib/{planning-ui,planning-page,download}.ts` (+ teste), `transaction-filters.ts` (+ test), `ledger-options.ts`.
- Componente: `src/components/planning/{charts,summary,month-selector,export-button,tag-chip}.tsx`, `src/components/app/{app-nav,icons}.tsx`; texte: `src/messages/ro.ts`.
- E2E și CI: `e2e/planning.spec.ts` (nou), `e2e/fixtures.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`.
- Documentație: `docs/adr/0008-planning-ui.md` (nou), acest raport, `docs/ROADMAP.md`, `docs/SECURITY_CHECKLIST.md`, `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `CLAUDE.md`.

## 3. Comenzi rulate (F3-C, 2026-10-28) și rezultate
Toate în `node:24` (`scratchpad/dk.sh`), cu `NODE_OPTIONS=--max-old-space-size=600…900`. Hostul avea ~0,8–1,7 GB RAM disponibili (swap plin), deci fără Postgres efemer și fără build.

| Comandă | Rezultat |
|---|---|
| `pnpm install --frozen-lockfile` | PASS (lockfile neschimbat, fără dependențe noi) |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm openapi:check` | PASS (`docs/openapi.json` e la zi; API neschimbat) |
| `pnpm test:ops` | PASS |
| `vitest run --maxWorkers=2` (fără `DATABASE_URL`) | PASS: 39 de fișiere, 480 de teste trecute, 263 sărite (testele de integrare cu PostgreSQL, 20 de fișiere) |
| testele de integrare cu PostgreSQL (`pnpm test` cu `DATABASE_URL`) | NOT RUN în F3-C (memoria hostului; F3-C nu a modificat serviciile, migrațiile sau rutele API; ultima rulare: F3-B) |
| `playwright test --list` | PASS: 43 de teste în 5 fișiere (dintre care 8 în proiectul nou `planning`) |
| `pnpm test:e2e` (browser) | NOT RUN (fără browsere pe host; job-ul `e2e`) |
| `pnpm build` | NOT RUN (OOM host: sub 2 GB disponibili; CI) |
| `pnpm scan:client-secrets` | NOT RUN (cere `.next/static` din build; CI) |

### F3-D — backup (2026-10-28)

**Ce s-a implementat** (ADR 0009, `docs/BACKUP.md`): imaginea `finet:backup` (`ops/backup/Dockerfile`: Alpine 3.22.7, restic 0.18, pg_dump 17, ținta `backup` în workflow-ul `images`, `pull-images.sh … backup`); serviciul one-shot `finet-backup` (profilul `backup`, uid 1000, read-only, `cap_drop: ALL`, 256 MiB, storage read-only, `finet_default`); destinația prin suprapuneri `ops/backup/compose.{s3,sftp,local}.yml` (+ `compose.restore.yml`); `backup.sh` (dump `--schema=finet` direct în restic prin `--stdin-from-command`, fișierele, `forget` 7/4/12 cu gazda fixă `finet`, `check` + subset de date duminica), `restore.sh` (schema pre-creată, listă fără `SCHEMA finet`, o tranzacție, fără `--no-owner/--no-acl`), `entrypoint.sh` (`backup|restore|init|snapshots|check|restic`); rolul `finet_backup` (`backup-role.sql`: BYPASSRLS, doar citire pe `finet`); `run-backup.sh` pe host (cron root, alertă prin `notify.sh`, anti-flood 1/oră, succes săptămânal, `last-success`); testele `ops/backup/test.sh` (în `test:ops`) și `ops/backup/restore-test.sh` (job CI `backup-restore`); fix E2E separat: `e2e/auth.spec.ts` verifica textul vechi al dashboard-ului.

**Fișiere:** noi `ops/backup/{Dockerfile,lib.sh,backup.sh,restore.sh,entrypoint.sh,run-backup.sh,backup-role.sql,restore-test.sh,test.sh,.shellcheckrc,compose.s3.yml,compose.sftp.yml,compose.local.yml,compose.restore.yml,backup-host.env.example}`, `ops/docker/finet.backup.env.example`, `docs/BACKUP.md`, `docs/adr/0009-backup-restic.md`; modificate `ops/docker/docker-compose.yml`, `ops/docker/test-env-examples.sh`, `ops/deploy/pull-images.sh`, `.github/workflows/{ci,images}.yml`, `package.json` (`test:ops`), `.env.example` (marcaje `# secret`), `e2e/auth.spec.ts`, `docs/{INFRA,ROADMAP,SECURITY_CHECKLIST}.md`, acest raport. Fără dependențe npm noi.

| Comandă (F3-D) | Rezultat |
|---|---|
| `restore-test.sh` (Postgres `postgres:17-alpine` + runner `alpine:3.22` cu `restic~0.18` și `postgresql17-client~17`, ambele `--memory=256m`, rețea privată `finet-ci-net`), de 2 ori după modificări | PASS: 35/35 verificări (a–g); amprenta de 500 de linii identică după restaurare; 19 tabele RLS ENABLE+FORCE; 125 de tranzacții; negativele (migrator: „row-level security”, app, parolă DB greșită) fără instantaneu nou; `--enable-row-security` ca `finet_app`: 0 din 125 de rânduri; parola restic greșită: cod 12; retenția: 20 din 49, exact datele așteptate |
| `migrate.mjs` (rolul `migrate`) pe baza restaurată | PASS: „aplicate acum 0, deja aplicate 5” |
| `sh ops/backup/test.sh` (host, dash) și în `alpine:3.22` (busybox) | PASS ambele (după înlocuirea `flock -E`, absent în busybox, cu blocarea pe descriptor) |
| `shellcheck -s sh -x ops/backup/*.sh` (`koalaman/shellcheck:v0.10.0`) | PASS (după corecții; SC1111/SC2015 dezactivate în `ops/backup/.shellcheckrc`, motivat) |
| `sh ops/docker/test-env-examples.sh` | PASS (79 de verificări, inclusiv cele noi pentru `finet-backup`) |
| `docker compose … config` cu `compose.{s3,sftp,local}.yml` și `compose.restore.yml`, `--profile backup`, env și secrete fictive (Compose 2.26.1) | PASS (exit 0); secretele și `_FILE`-urile fuzionate corect; fără profil și cu `--profile migrate`, fără fișierele backup-ului: PASS |
| `prettier --check` + `eslint` pe `e2e/auth.spec.ts`, `pnpm typecheck` | PASS |
| `docker build` al imaginii `finet:backup` (ops/backup/Dockerfile: `COPY --chmod`, utilizatorul 1000 cu HOME `/tmp/home`, scripturile din `/opt/finet-backup`) | NOT RUN (fără build pe host); testul local a folosit `alpine:3.22` cu aceleași pachete și scripturile din repo, deci imaginea se verifică la prima rulare a job-ului `backup-restore` |
| `pnpm install --frozen-lockfile` | NOT RUN în F3-D (singura schimbare în `package.json` e scriptul `test:ops`; lockfile neatins) |
| `pnpm test` cu PostgreSQL, `pnpm build`, `pnpm lint` complet | NOT RUN (memoria hostului; F3-D nu modifică `src/`; CI) |
| Job-urile CI `backup-restore` (build-ul imaginii, testul în imaginea reală, shellcheck pe runner) și `images` (ținta `backup`) | NOT RUN (cer push; coordonatorul) |
| Backup S3/SFTP real, rolul pe Supabase, cron, restaurare de probă pe producție | NOT RUN (în afara scope-ului; operatorul) |

## 4. Pornire și deploy
- Local: ca în Faza 2 (`pnpm dev`, Postgres migrat). E2E: `pnpm test:e2e --project=planning` cu utilizatorii `e2e-planning-<mod>@finet.test` și `e2e-planning2-<mod>@finet.test` (`e2e/fixtures.ts`).
- Producție: `docs/INFRA.md`, „Faza 3 pe producție” (migrația `0004`, redeploy `finet-web`, verificări). UI-ul nu cere pași de deploy proprii. Backup-ul: `docs/INFRA.md` 4e, pașii 6–7, și `docs/BACKUP.md` 5.

## 5. Variabile de mediu noi
F3-C: niciuna. F3-D: doar pentru `finet-backup`, ca fișiere în `/srv/finet/secrets` — `finet_restic_password`, `finet_backup_repository`, `finet_backup_pg_service` (+ `finet_backup_s3_*` sau `finet_backup_sftp_*`, `finet_restore_pg_service` la restaurare); nesecrete în `/srv/finet/env/finet.backup.env` (`FINET_BACKUP_CHECK_DATA_DAY`, `FINET_BACKUP_CHECK_DATA_SUBSET`, `AWS_DEFAULT_REGION`) și `backup-host.env` (`FINET_BACKUP_DEST`, …). Aplicația nu primește nimic nou.

## 6. Riscuri, limitări, securitate
- `q` și `merchant` (text liber) în URL: LOW-3 extins (ADR 0008); aplicația nu loghează URL-uri, proxy-urile le pot înregistra.
- Graficele randate pe server pentru volume mari (Faza 7) citesc toate tranzacțiile lunii/celor 12 luni (ADR 0007).
- E2E nerulate local: riscuri de fiabilitate la prima rulare — timpul de compilare al `next dev` pe paginile noi (scenariul g are `test.slow()`), focusul în scenariul h depinde de stilul `focus-visible` al `Select`.
- Backup (F3-D): nimic nu e verificat încă pe Supabase sau pe o destinație reală (rolul BYPASSRLS poate fi refuzat de `postgres`, vezi `docs/BACKUP.md` 3); pg_dump 17 refuză un server 18 (imaginea se actualizează la upgrade); un root compromis pe VPS poate șterge instantaneele dacă destinația nu are Object Lock/append-only; parola restic pierdută = backup ilizibil.
- Revizuirea `security` a Fazei 3: PASS_WITH_FINDINGS (0 Critical/High). Corectate pe branch: LOW-2 (exporturile CSV cu cookie cer `Sec-Fetch-Site` `same-origin`/`none`, altfel 403; bearer permis; test în `planning-api.test.ts`, OpenAPI cu 403), LOW-1 (`run-backup.sh` refuză un checkout scriibil de alții; cron din `/srv/finet/src`), LOW-3 (digestul imaginii de bază), LOW-4 (`finet_backup` fără CREATE în `public`), INFO-1/2 (docs: date de autentificare în backup, log `0600` + logrotate). Testele vitest, typecheck, lint și `format:check` pe aceste corecții: NOT RUN local (sub 1,5 GB RAM liberi); `ops/backup/test.sh`, `test-env-examples.sh`, shellcheck și `openapi:check`: PASS.

## 7. Următorii pași
1. Operatorul: instalarea backup-ului (`docs/BACKUP.md` 5: destinația, `finet_backup` pe Supabase — verifică BYPASSRLS —, secrete, `init`, primul backup, cron) și restaurarea de probă (condiție pentru date reale).
2. Push + prima rulare CI (`ci`, `e2e` cu `planning` în ambele moduri), corecțiile care rezultă.
3. Revizuirea `security` a Fazei 3.
4. Operatorul: `0004` pe Supabase, redeploy, verificările din `docs/INFRA.md`.
5. Faza 4: alinierea datelor la `zz.ll.aaaa` peste tot, axe în E2E, problemele din prima săptămână de folosire.
