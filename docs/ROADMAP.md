# FINET — roadmap

Starea fazelor din `docs/FINET_MASTER_PROMPT.md` (secțiunea 7) și `docs/FINET_ANDROID_MASTER_PROMPT.md` (secțiunea 8). Stări: **complet**, **parțial**, **neimplementat**.

## Web

| Fază | Stare | Note |
|---|---|---|
| 0 — Fundație și infrastructură | **parțial** | vezi mai jos și `docs/reports/faza-0.md` |
| 1 — Autentificare, profil, gospodărie | **parțial** (implementat în repo) | F1-A, F1-B, F1-C gata; rămân migrațiile pe Supabase, prima rulare E2E în CI și revizuirea de securitate — vezi mai jos și `docs/reports/faza-1.md` |
| 2 — Conturi, categorii, tranzacții, transferuri | **parțial** (implementat în repo) | F2-A, F2-B, F2-C gata; rămân migrațiile pe Supabase, prima rulare E2E `ledger` în CI, verificarea în browser și revizuirea de securitate — vezi mai jos și `docs/reports/faza-2.md` |
| 3 — Dashboard, bugete, obiective, rapoarte, export, backup | **parțial** (F3-A, F3-B, F3-C, F3-D în repo) | F3-A (date, servicii, corecțiile Fazei 2), F3-B (API `/api/v1`, OpenAPI), F3-C (UI, E2E `planning`) și F3-D (backup restic, restaurare testată pe Postgres efemer) gata; rămân instalarea backup-ului și restaurarea de probă pe producție (operatorul), migrația `0004` pe Supabase, prima rulare E2E `planning` în CI și revizuirea de securitate — vezi mai jos și `docs/reports/faza-3.md` |
| 4 — Stabilizare | **parțial** (implementat în repo) | recuperarea după deploy, `global-error`, date `zz.ll.aaaa`, `tagMatch=all`, accesibilitate de bază, bugetul JS, `0005_perf_indexes`, testele de regresie; rămân prima rulare CI (build, buget, E2E `regressions`), `0005` pe Supabase, cron-ul de curățare și revizuirea `security` — vezi mai jos și `docs/reports/faza-4.md` |
| 5 — Recurențe | **parțial** (F5-A, F5-B în repo) | date, servicii, worker pg-boss (F5-A); API `/api/v1/recurring`, UI `/recurring`, E2E `recurring` (F5-B); rămân migrațiile `0006`/`0007` și workerul pe producție (operatorul), prima rulare CI completă și revizuirea `security` — vezi mai jos și `docs/reports/faza-5.md` |
| 6 — Ingestia bonurilor | **în repo** (F6-A, F6-B, F6-C; de revizuit și de aplicat pe producție) | F6-A: migrația `0008_documents`, stocarea în flux, încărcarea cu validare după conținut, limite, deduplicare, consimțământ, preprocesarea în worker (sharp, pdf.js într-un proces copil limitat) — ADR 0013. F6-B: migrația `0009_receipt_pipeline`, clientul LiteLLM, jobul `receipt.process`, verificările 5.5 și scorul, categorisirea, bonul lung, bugetul global, fixtures sintetice și `pnpm eval:receipts` — ADR 0014. F6-C: API-ul public (`/api/v1/documents`, `/receipts`, `/ai/usage`), paginile `/import`, `/receipts`, `/receipts/[id]`, retenția originalelor (`0011`, `cleanup-documents`), E2E cu serverul AI fals și workerul — ADR 0015. Rămân `0008`–`0011` pe Supabase, evaluarea pe bonuri reale și revizuirea `security` |
| 7 — Extrase bancare, potrivire, abonamente | **în repo** (F7-A + F7-B) | F7-A: migrația `0013_statements`, extracția PDF în procesul copil al workerului, parserele BT, BRD, Raiffeisen, Revolut (fixture-uri sintetice), CSV/XLSX/ZIP cu mapare de coloane, deduplicare, schimb valutar ca transfer, anulare, acoperire — ADR 0018. F7-B: migrația `0014_statement_uploads` (PDF-urile spre worker, 24 h), API-ul `/api/v1/statements/*`, potrivirea bon ↔ tranzacție, plățile recurente detectate, interfața, E2E — ADR 0018 §11, ADR 0019. Rămân `0013`/`0014` pe Supabase, E2E în CI și revizuirea `security` — vezi mai jos |
| 8 — Familie | **parțial** (F8-A și F8-B în repo) | F8-A: migrația `0012_family` (invitații, împărțiri cu verificare amânată a sumei, decontări, gospodăria activă, vizibilitatea personal/comun în RLS pe conturi, tranzacții, etichete, recurențe), serviciile `src/modules/family/` (invitații, membri, roluri, ultimul owner, comutator, împărțiri, solduri, decontări) — ADR 0016. F8-B: API-ul `/api/v1` al familiei, `/family`, `/join/[token]`, comutatorul, împărțirea pe tranzacție, widgetul de pe Acasă, actualizările live (SSE, ADR 0017), E2E `family`. Rămân `0012` pe Supabase, deploy-ul (INFRA 4k) și revizuirea `security` — vezi mai jos |
| 9 — Hardening, PWA, offline | **în repo** (F9-A, F9-B; branch `phase/09-hardening`, de revizuit și de aplicat pe producție) | F9-A: manifest, iconițe, service worker, `/offline`, scanarea offline (IndexedDB), invitația de instalare, `/help`, `/settings`, `/settings/android`, `GET /api/v1/app/android/latest` (ADR 0020). F9-B: migrația `0016_gdpr_stats`, exportul GDPR (ZIP în flux), ștergerea contului, retenția `app_events` (`aggregate-events`), „Statistici” pentru administrator, încercarea upgrade-ului PostgreSQL 17 → 18 (PASS) și workflow-ul `pg-next`, auditul axe (E2E `a11y`), dovezile din SECURITY_CHECKLIST (ADR 0021). **Reper „v1.0 personal”** după deploy — vezi „Faza 9: stare” |
| 10 — Liste de cumpărături și prețuri | **în repo, pe producție** (F10-A…C) | liste de cumpărături, prețuri și inflație, exporturi Excel/PDF, „Întreabă FINET”; vezi `docs/reports/faza-10.md` |
| 11 — Fundația SaaS | **livrată în cod** (11-A…C, revizuire de securitate, ADR 0027–0034) | site public, administrare, înregistrare cu Turnstile, engleză, Google; rămân de făcut de operator: chei reale, juridic, expunere (`docs/EXPOSURE.md`); vezi `docs/reports/faza-11.md` |
| 12 — Planuri, plăți, recomandări | **parțial**: 12-A în repo (ADR 0035: planuri, abonamente, `entitlements` în `saas`, scrieri blocate la expirare); 12-A.2 pe producție (fișiere, istoric, prioritatea cozii; 0024); 12-C felia 1 (stratul de date al recomandărilor, ADR 0037, migrația 0025) în repo, felia 2 (rute `/ref`, înregistrare, pagina `/referrals`) în repo (ADR 0037), felia 3 (recompensă feedback, ADR 0037, migrația 0026) în repo; 12-D în repo (runbook `MIGRARE_PERSONAL_SAAS.md`, script fondator, ADR 0036); 12-B (plăți) așteaptă alegerea furnizorului: **operatorul nu folosește Stripe** | cere de la operator: prețuri, limite pe plan, durata probei, furnizorul de plată |
| 13 — Limbi suplimentare (`saas`) | parțial: paginile publice în 6 limbi noi (ADR 0033), în așteptarea revizuirii; aplicația și formatele rămân | adăugată după analiza finpulse.day |

### Faza 0: ce e gata și ce lipsește
**Gata în repo (verificat local):** proiectul Next.js 16 + TypeScript strict + Tailwind + ESLint + Prettier + Vitest + Playwright; `lib/config.ts`, `lib/money.ts` (cu teste), `lib/storage.ts` (local + schelet S3), `entitlements` pentru `personal`; protecția Access în `src/proxy.ts` și `/api/health`; `Dockerfile` și `ops/docker/docker-compose.yml`; CI; instrucțiunile pentru Cloudflare, Supabase, notificări; documentația și ADR-urile 0001, 0002.

**De ce e „parțial”:**
- Infrastructura nu e deployată și nu e verificată: Supabase, Cloudflare (tunel, Access, WARP) și pornirea containerelor pe VPS le face operatorul (`docs/INFRA.md`, secțiunea 4). Toate criteriile de acceptare care le cer sunt `NOT RUN`.
- Jobul săptămânal pentru versiunea PostgreSQL: neimplementat (`ops/postgres/version-check.md`); la fel workflow-ul de test pe versiunea majoră următoare.
- Notificarea de test nu a fost trimisă efectiv (doar `--dry-run`).
- shadcn/ui: rezolvat în F1-C (componente scrise de mână, tokenii mapați).
- E2E `smoke` (browser) nu a rulat local; din F1-C rulează în CI (job `e2e`), încă nerulat (fără push).
- CI-ul pe GitHub nu a rulat încă pe acest branch (fără push).
- Testul automat „schema `finet` inaccesibilă prin Data API” cere un proiect și un tabel (Faza 1).
- Sarcina umană (bonuri și extrase reale anonimizate în `fixtures/`): neînceput.

### Faza 1: stare
**F1-A (stratul de date), gata în repo, verificat local pe PostgreSQL 17 efemer:**
- Drizzle: schema `finet` (`src/db/schema/`), migrațiile `0000_core` (generată) și `0001_rls` (de mână) în `src/db/migrations/`;
- RLS `ENABLE` + `FORCE` pe `households`, `household_members`, `audit_events`, `user_preferences`, `consents`; contextul per tranzacție (`withRls`, `src/db/rls.ts`); `requireMember`/`withMember` (`src/lib/authz.ts`);
- runner-ul de migrații (`src/db/migrate.ts`, imaginea `finet:tools`, serviciul `finet-migrate`), idempotent, cu evidența în `finet.__drizzle_migrations`;
- teste de integrare pe roluri reale (`finet_app`, `finet_migrator`; `ops/postgres/test-bootstrap.sql`), pași de migrare în CI;
- decizii și abateri: ADR 0003.

**F1-B (autentificarea server-side, fără UI), gata în repo, verificat local pe PostgreSQL 17 efemer:**
- Better Auth 1.7.13 (adaptorul Drizzle pe `users`/`auth_*`, id-uri uuid din bază), parole Argon2id prin `crypto.argon2` din Node (m=19 MiB, t=2, p=1), minimum 10 caractere, HIBP opțional (oprit implicit);
- `personal`: `/api/auth/sign-up/*` → 404, utilizatori doar din CLI; magic link (de unică folosință, 10 minute, nu creează conturi) și resetarea prin email doar cu SMTP (Nodemailer);
- sesiuni în bază (30 de zile, prelungite cel mult o dată pe zi, fără cookie cache), pluginul `bearer` (doar tokenuri semnate) pentru Android, sesiunea mobilă afișată „Telefon Android” (`X-FINET-Client`);
- rate limiting în `auth_rate_limits` pe IP de încredere (`cf-connecting-ip` doar după JWT Access) + email normalizat: login web, login mobil, emailuri, resetare, schimbarea parolei; login-urile eșuate numărate agregat pe zi;
- API `/api/v1/me` (GET/PATCH), `/me/sessions` (GET), `/me/sessions/{id}` (DELETE), `/me/sessions/revoke-others`, `/me/password`; CSRF pe mutațiile cu cookie; erori `{ error: { code, message, fields? } }`;
- gospodăria personală și preferințele create atomic cu utilizatorul; CLI `admin` (`create-user`, `reset-password`, `add-member`; `dist/tools/admin.mjs`, serviciul `finet-admin`); audit pentru login, parolă, sesiuni, creare utilizator, add-member;
- decizii: ADR 0003 („Autentificarea (F1-B)”).

**F1-C (UI, antete, E2E, documentație), gata în repo:**
- antetele de securitate pe toate răspunsurile proxy-ului (inclusiv 403): CSP cu nonce per cerere (fără `unsafe-*` în producție), HSTS fără `preload`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, CORS închis; verificate în teste unitare și pe serverul standalone (`e2e/access.spec.ts`, PASS local);
- paginile `/login`, `/dashboard` (placeholder), `/profile` (preferințe, parolă, sesiuni), logout, `/` și `/register` (404 în `personal`), cu `?next=` validat (fără open redirect); navigare jos pe telefon, meniu lateral pe desktop;
- tokenii `surface-2`/`accent-soft` și numele shadcn mapate corect; componentele UI fără dependențe noi; textele în `src/messages/ro.ts`;
- E2E Playwright (proiectul `auth`, ambele moduri) și job-ul `e2e` în CI; `docs/SECURITY_CHECKLIST.md`; ADR 0003 („UI și antete (F1-C)”).

**Rămâne pentru închiderea Fazei 1:**
- prima rulare a job-ului `e2e` pe GitHub (local NOT RUN: browserele nu se instalează pe hostul agentului) și eventualele ajustări;
- aplicarea migrațiilor pe Supabase de operator (`docs/INFRA.md`, „Faza 1”), apoi verificarea în browser prin Access;
- revizuirea de securitate a Fazei 1: corecțiile H1, M1–M5, L1, L4, L5 făcute (2026-10-28), de re-verificat de `security`;
- înregistrarea publică `saas` cu verificarea emailului: Faza 11 (sign-up rămâne închis și în `saas`);
- OpenAPI (`docs/openapi.json`) pentru `/api/v1`: făcut în F2-B (ADR 0005);
- **TODO:** micșorarea imaginii `finet:tools` (583 MB, include `next`): de exemplu `pnpm deploy --prod` cu doar `postgres`/`drizzle-orm`/`zod` (dependențele externe ale `dist/tools/*.mjs`). Neîncercat: cere un build Docker, nepermis pe hostul cu memorie mică.

### Faza 2: stare
**F2-A (stratul de date și serviciile, fără rute HTTP și UI), gata în repo, verificat local pe PostgreSQL 17 efemer:**
- migrația `0002_ledger` (generată + partea de mână): `accounts`, `categories` (28 de categorii de sistem din 5.4), `category_visibility`, `transactions` (cu `transfer_direction`), `idempotency_keys`, `client_installations`, `app_events`, `app_downloads`; RLS `ENABLE` + `FORCE`, politici pe gospodărie/utilizator, drepturi `UPDATE` pe coloane, triggere `SECURITY INVOKER`, verificarea grupurilor de transfer la COMMIT;
- serviciile `src/modules/{accounts,categories,transactions,transfers}` (`*.schema.ts`, `*.repo.ts`, `*.service.ts`, comun în `src/modules/ledger/`): sold calculat (`bigint`, `money.ts`, totaluri pe monedă), arhivare și ștergere doar a conturilor goale, categorii de sistem ascunse per gospodărie, ștergerea categoriilor cu reasignare, tranzacții cu căutare/filtre/sortare/paginare cu cursor, transferuri atomice (monede diferite cu ambele sume), audit fără sume la ștergeri;
- corecțiile revizuirii automate (MEDIUM 1: proprietarul contului membru al gospodăriei; MEDIUM 2: `installation_id` unic per utilizator);
- decizii: ADR 0004.

**F2-B (API `/api/v1`, idempotență, OpenAPI, statistici de utilizare), gata în repo, verificat local pe PostgreSQL 17 efemer:**
- rutele `/api/v1/households`, `accounts` (+ `archive`/`unarchive`), `categories` (+ `hide`/`unhide`, ștergere cu `?reassignToId=`), `transactions` (filtre, căutare, sortare, cursor), `transfers` (`POST`, `GET/PATCH/DELETE /{groupId}`), `me/consents`, `app/events`; stratul HTTP comun (`src/app/api/v1/_lib/http.ts`: 401/403 CSRF/404/409 `reason`/413/415/422/429/500, rate limiting pe mutații per utilizator), folosit și de `/api/v1/me*`;
- `Idempotency-Key` pe crearea conturilor, categoriilor, tranzacțiilor și transferurilor (aceeași tranzacție cu scrierea, savepoint pentru serviciu, lock consultativ → 409 `request_in_progress`, 422 la reutilizare, 5xx nememorat, expirare 24 h) și migrația `0003_idempotency_purge` (funcția `SECURITY DEFINER` de curățare) + `finet-admin cleanup-idempotency`;
- `X-FINET-Client` (forma completă `cheie=valoare`, strictă; forma veche păstrată pentru sesiuni) → `client_installations`, cel mult o scriere la 15 minute; `POST /api/v1/app/events` cu lista fixă, respingerea oricărui câmp în plus, consimțământul `usage_stats` verificat pe server; `GET/PUT /api/v1/me/consents` cu audit;
- OpenAPI 3.1 din schemele Zod (`src/openapi/`, `docs/openapi.json`, `pnpm openapi:generate` / `openapi:check`, pas nou în CI), test rute reale ↔ registru și verificarea fiecărui răspuns din teste față de schemă; `docs/API.md`;
- decizii: ADR 0005.

**F2-C (UI, E2E, documentația), gata în repo, verificat local (fără browser):**
- paginile `/accounts` (+ `new`, `[id]`), `/transactions` (+ `new`, `[id]`), `/transfers/new`, `/categories`; soldurile și ultimele 5 tranzacții pe `/dashboard`; navigarea cu cele cinci pagini; comutatorul `usage_stats` în `/profile`;
- mutațiile prin `/api/v1/*` cu `Idempotency-Key` per trimitere și blocare la dublu-clic; banii doar prin `money.ts`; `X-FINET-Client` doar cu acord; fără `style=`;
- E2E `e2e/ledger.spec.ts` (proiectul `ledger`, ambele moduri în CI; local NOT RUN), teste unitare noi (613 în total);
- decizii: ADR 0006; raport: `docs/reports/faza-2.md`.

**Rămâne pentru Faza 2:**
- prima rulare E2E (`ledger`, `auth`, `smoke`) în job-ul `e2e`, după push; verificarea paginilor în browser pe producție;
- editarea transferurilor din UI, subcategoriile și culorile categoriilor în UI (opțional, API-ul există);
- aplicarea `0002_ledger` și `0003_idempotency_purge` pe Supabase de operator, după revizuirea `security` (F2-A + F2-B);
- programarea `finet-admin cleanup-idempotency`: linia de cron propusă în `docs/INFRA.md` 4f (pasul 6, Faza 4); instalarea de operator;
- revizuirea `security` a API-ului (F2-B) și a interfeței (F2-C): constatările MEDIUM-1..3, LOW-1, LOW-5 corectate (2026-10-28, `docs/SECURITY_CHECKLIST.md` secțiunea 10; ADR 0004/0005/0006); de re-verificat.

**Amânate din revizuirea F2 (cu motiv):**
- **LOW-2** — retenția `app_events` (13 luni, apoi agregare pe zi/versiune): **închis în F9-B** (`finet-admin aggregate-events`, `app_event_daily`; ADR 0021). Programarea `finet-admin cleanup-idempotency` rămâne decizia operatorului.
- **LOW-3** — `q` (căutarea în tranzacții) circulă în URL: aplicația nu loghează URL-uri, dar proxy-ul/Traefik/Cloudflare le pot înregistra (`docs/PRIVACY_NOTES.md`); alternativa `POST /api/v1/transactions/search` într-o fază viitoare.
- **LOW-4** — plafoane per gospodărie (număr de conturi, categorii, tranzacții) și rate limit pe citiri: fază viitoare.
- **NOTE** — `owner_user_id` nu are efect de autorizare (6.1); `finet_migrator` nu are politici pe `categories`/`transactions` (intenționat).

### Faza 3: stare
**F3-A (date și servicii, fără rute HTTP și UI), gata în repo, verificat local pe PostgreSQL 17 efemer** (ADR 0007):
- corecțiile revizuirii Fazei 2: LOW-1 (lacătul per utilizator în `setConsents`, `upsertInstallation`, `recordEvents`), INFO (citirea după lacăt), LOW-2 (garda 2^53 − 1 la scriere pe cont, ADR 0004/0005 corectate);
- migrația `0004_budgets_goals_tags` (generată + partea de mână): `tags` (5 de sistem), `tag_visibility`, `transaction_tags`, `budgets`, `goals`; RLS `ENABLE` + `FORCE`, bugetele personale vizibile doar proprietarului, triggere `SECURITY INVOKER`, drepturi `UPDATE` pe coloane; pe `transactions` doar `UNIQUE (id, household_id)`;
- serviciile `src/modules/{tags,budgets,goals,dashboard,reports,exports}`: etichete (și `tagIds` pe tranzacții, filtrele `tagIds`/`merchant`), bugete cu semafor în întregi și avertizări, obiective cu contribuții și stare calculată, dashboard pe monedă (comparație, 12 luni, trend zilnic, categorii top N + „Altele”, onboarding), raport lunar, export CSV (BOM, RFC 4180, protecție contra injecției, plafon 50.000);
- `src/lib/calendar.ts` (luni locale, „luna curentă” în `Europe/Bucharest`), `percentOf` în `money.ts`.

**F3-B (API `/api/v1`, fără UI), gata în repo, verificat local pe PostgreSQL 17 efemer** (ADR 0007, „API (F3-B)”; `docs/API.md`):
- rutele `tags`, `budgets` (+ `budgets/status` cu semafor și avertizări), `goals` (+ `contributions` cu `Idempotency-Key` obligatoriu, `abandon`), `dashboard`, `reports/monthly`, `exports/{transactions,goals,budgets}.csv` (`?dialect=rfc4180|ro`, implicit `rfc4180`; flux `ReadableStream`; 409 `export_too_large`; rate limit 10/min; audit `export.downloaded` fără conținut);
- `tags: [{id,name,color}]` în răspunsurile de tranzacție, filtrele `tagIds` (virgulă) și `merchant` în listă; luna validată (ultimele 60 de luni … luna curentă);
- OpenAPI regenerat (componentele `Tag`, `Budget`, `BudgetStatus`, `Goal`, `Dashboard`, `MonthlyReport`; răspunsurile CSV ca `text/csv`), evenimente de utilizare noi; teste de integrare `src/app/api/v1/planning-api.test.ts`.

**F3-C (interfața, E2E, documentație), gata în repo** (ADR 0008; verificat local: lint, format, typecheck, teste fără DB, `openapi:check`, `test:ops`, `playwright test --list`; build și E2E în browser NOT RUN pe host):
- `/dashboard` cu selector de lună, totaluri pe monedă cu comparație, grafice SVG fără bibliotecă (cu tabel text), bugete cu semafor și avertizare, obiective, onboarding în 3 pași;
- `/transactions` cu filtrele `merchant` și etichete, etichetele pe rânduri și în formular, „Export CSV” cu filtrele; `/tags`; `/budgets` (+ `new`, `[id]`); `/goals` (+ `new`, `[id]`, contribuții); `/reports` cu exporturile CSV (`dialect=ro`);
- navigarea nouă (desktop complet; telefon: Acasă, Tranzacții, Bugete, Rapoarte, „Mai mult”);
- E2E `e2e/planning.spec.ts` (proiectul `planning`, ambele moduri în CI).

**F3-D (backup restic + restaurare testată), gata în repo** (ADR 0009, `docs/BACKUP.md`; restaurarea testată local pe PostgreSQL 17 efemer, job CI `backup-restore`):
- imaginea `finet:backup` (restic 0.18, pg_dump 17; ținta `backup` în workflow-ul `images`), serviciul one-shot `finet-backup` (profilul `backup`), destinația S3/SFTP/local prin suprapuneri;
- `backup.sh` (dump prin `--stdin-from-command`, fișiere, retenție 7/4/12, `check`), `restore.sh`, rolul `finet_backup` (BYPASSRLS, doar citire), `run-backup.sh` pe host cu alertă anti-flood prin `notify.sh`.

**Rămâne în Faza 3:** instalarea backup-ului de către operator (destinația, rolul `finet_backup` pe Supabase, secretele, cron, primul backup și **restaurarea de probă reală**; fără ea nu se introduc date reale), aplicarea `0004` pe Supabase (operatorul), revizuirea `security`. Separatorul CSV: decis de coordonator (`rfc4180` implicit pe API, `ro` din UI).

### Faza 4: stare
**Făcut în repo** (ADR 0010; măsurători în `docs/PERFORMANCE.md`; raport `docs/reports/faza-4.md`):
- recuperarea automată la chunk-uri JS vechi după deploy (reîncărcare cel mult o dată la 8 s, banner peste formularele necomise) și pagina `global-error` proprie (închide punctul din F8/Faza 9);
- datele `zz.ll.aaaa` și în paginile Fazei 2 și în sesiunile din profil (5.3);
- `tagMatch=any|all` în API (listă și export CSV), UI, OpenAPI, `docs/API.md`;
- accesibilitate de bază: „Sari la conținut”, `main` focalizabil, focus în „Mai mult”, `prefers-reduced-motion`, contrastul tokenilor testat în ambele teme, titluri unice;
- bugetul First Load JS per rută (`scripts/check-bundle-size.mjs`, pas CI după build; praguri provizorii);
- testul lent pe 50.000 de tranzacții și migrația `0005_perf_indexes` (lista: 116 → 16 ms);
- testele de regresie E2E (proiectul `regressions`): cereri doar către propriul domeniu, prefetch RSC fără sesiune, titluri și `lang`;
- N3 (scanerul de secrete) închis; linia de cron pentru `cleanup-idempotency` documentată (`docs/INFRA.md` 4f).

**Rămâne / amânat (cu motiv):**
- prima rulare CI: `pnpm build`, bugetul JS (calibrarea pragurilor din `docs/PERFORMANCE.md`), E2E `regressions` în ambele moduri — local NOT RUN (memoria hostului, fără browser);
- `0005` pe Supabase, redeploy, cron-ul de curățare: operatorul (`docs/INFRA.md` 4f);
- lista „problemelor găsite în prima săptămână de folosire reală” (acceptarea Fazei 4 din master prompt): nu există încă rapoarte de la utilizatori; se completează în `docs/reports/faza-4.md` după folosire;
- exportul CSV complet (~4,5 s la 50.000 de rânduri, dominat de aplicație): pagini mai mari, `Intl.Collator` reutilizat — fază viitoare;
- căutarea `q` cu `ILIKE '%…%'` (Seq Scan, ~0,1 s la 50.000): index `pg_trgm` doar dacă extensia e disponibilă pe Supabase — fază viitoare;
- ștergerea indexului vechi `transactions_household_occurred_idx` (redundant parțial cu `0005`): migrație separată, cu aprobare;
- `@axe-core/playwright`: Faza 9, odată cu hardening-ul;
- HSTS `preload`: decizia operatorului (Faza 9).

### Faza 5: stare
**Făcut în repo, F5-A** (ADR 0011; branch `phase/05-recurring`):
- migrația `0006_recurring`: `recurring_rules`, `recurring_occurrences` (unicitatea `(rule_id, occurrence_date)` = idempotența), `service_heartbeats`, cheia `transactions.recurring_rule_id` → regulă (`NOT VALID` + `VALIDATE`), RLS `ENABLE`+`FORCE`, GRANT pe coloane, funcția SECURITY DEFINER `due_recurring_rules` (doar id-uri);
- migrația `0007_pgboss` (generată din planul pg-boss 12.38.0, schema creată de operator: `ops/supabase/pgboss-schema.sql`), drepturi minime pentru `finet_app`, fără DDL la rulare;
- calendarul recurențelor (`src/lib/calendar.ts`): ziua 31, 29 februarie, fără deplasarea zilei țintă, DST neutru;
- serviciile `src/modules/recurring/` (CRUD, pauză/reluare fără retroactiv, contoare, generare idempotentă cu recuperare limitată la 12/regulă/rulare, `completed`, garda 2^53, pauză la cont arhivat, fereastra workerului fără înfometare);
- workerul pg-boss (`src/worker/`, imaginea de unelte): `recurring.generate` orar, `recurring.generate-now` la cerere, reîncercări limitate, oprire grațioasă, loguri fără date financiare, semnal de viață → `/api/health` `queue`; memorie măsurată ~86 MB RSS (limita 150 MB).

**Făcut în repo, F5-B** (ADR 0012):
- API `/api/v1/recurring` (listă cu contor, rezumat, CRUD, pauză, reluare, `generate` cu `Idempotency-Key` obligatoriu și limită proprie), `recurringRuleId` pe tranzacții, OpenAPI regenerat, `docs/API.md`, evenimentele `recurring_created`/`recurring_generated`, audit `recurring.generated` fără sume;
- UI `/recurring` (filtre pe stare, contorul „X active · Y reguli scadente · Z total”, „Generează scadentele”), `/recurring/new`, `/recurring/[id]` (pauză/reluare, motivul „cont arhivat”, editare, ștergere cu confirmare); în `/transactions` insigna „recurentă” și filtrul pe sursă; intrarea „Recurențe” în meniu;
- E2E `e2e/recurring.spec.ts` (proiectul `recurring`, utilizatorii `recurring`, `recurring2`).

**Rămâne:**
- cartea „Plăți recurente” pe dashboard (opțională, amânată: decizia F5-B);
- operatorul: schema `pgboss`, migrațiile `0006`/`0007`, pornirea workerului (`docs/INFRA.md` 4g);
- prima rulare CI completă (build, E2E) — local NOT RUN (memoria hostului);
- amânat (cu motiv): fusul orar al gospodăriei pentru „azi” (azi București), reasignarea creatorului unei reguli (fallback pe proprietar), recurențele de tip transfer, detectarea din extrase (Faza 7), notificările; curățarea cheilor de idempotență mutată din cron în worker (posibilă acum, nefăcută: cron-ul din 4f rămâne).

### Faza 6: stare
**F6-A (date, stocare, încărcare, preprocesare, deduplicare), gata în repo, verificat local pe PostgreSQL 17 efemer (subseturi; suita completă și build-ul în CI):**
- migrația `0008_documents` (7 tabele cu RLS ENABLE + FORCE, GRANT-uri pe coloane, triggere, `queued_documents` SECURITY DEFINER, cheia `transactions.document_id`), `document_usage_daily` pentru limita zilnică;
- storage: chei de gospodărie, `putStream` cu plafon, mod doar-citire, curățarea temporarelor;
- încărcarea (`src/modules/documents/`, handlerul `documents-handlers.ts` fără rută publică): busboy în flux, tipul după conținut, HEIC refuzat, limite, deduplicare SHA-256, cotă, limită zilnică, consimțământ `external_ai`, bon lung 2–4 poze;
- preprocesarea în worker (`src/worker/receipts/`): sharp (EXIF eliminat, rotire, 2048 px, JPEG), dHash și „posibil duplicat”, PDF prin pdf.js într-un proces copil sub `prlimit`.

**F6-B (pipeline-ul AI), gata în repo, verificat local pe PostgreSQL 17 efemer și cu serverul AI fals (subseturi; suita completă și build-ul în CI):** migrația `0009` (problemele bonului, legătura de duplicat, `vat_rates`, `ai_budget_usage` + `ai_budget_reserve`/`ai_budget_spent`, `queued_document`), `src/lib/ai/`, `src/modules/receipts/`, joburile `receipt.sweep`/`receipt.process`, fixtures sintetice și evaluarea — ADR 0014.

**Amânate din F6-B (motiv):**
- salvarea automată a bonurilor fără probleme (3.6, setare): decizia de siguranță din Faza 6, nimic nu se salvează fără confirmare; poate veni după evaluarea pe bonuri reale;
- notificarea administratorului la epuizarea bugetului AI (3.6): canalul de notificări nu e configurat (`ops/notify`);
- unirea automată a două încărcări separate cu același CUI și număr de bon: ține de fluxul din UI (F6-C);
- evaluarea pe bonuri reale și alegerea modelelor (3.6): de făcut de operator cu `AI_EVAL=1`;
- verificarea `json_schema` pe LiteLLM-ul real (`AI_RESPONSE_FORMAT`): la primul deploy (INFRA 4h).

**F6-C (API, UI, E2E, retenție), gata în repo, verificat local pe PostgreSQL 17 efemer (subseturi; build-ul, suita completă, bugetul JS și E2E în CI):**
- API-ul: documentele (listă, stare, fișierul în flux cu antete fixe, ștergere), contorul zilei, bonurile (listă cu căutare după magazin/produs/sumă, detaliu, corectare cu verificările recalculate și `product_aliases`, confirmare → o tranzacție `source=receipt`, reprocesare care consumă limita, ștergere), consimțământul `externalAi` care pune în coadă documentele care îl așteptau;
- `/api/v1/documents` exclusă din `src/proxy.ts` (fluxul nu mai e trunchiat la 10 MB), cu aceeași verificare Access în rută (`src/lib/access-guard.ts`);
- paginile `/import`, `/receipts`, `/receipts/[id]`, comutatorul din `/profile`, insigna „din bon”, „Scanează” în bara de jos (în locul lui „Bugete”, mutat în „Mai mult”);
- migrația `0011_document_retention` + `admin cleanup-documents` în serviciul one-shot `finet-cleanup` (închide F9: programarea `cleanupTemp`);
- E2E `receipts` cu serverul AI fals și workerul real în CI — ADR 0015.

**Amânate din F6-C (motiv):** unirea automată a încărcărilor separate cu același bon (se folosește „Mod bon lung”), E2E-ul bonurilor în modul `saas` (timpul jobului; pipeline-ul nu depinde de mod).

**Rămâne:** `0008`–`0011` pe Supabase, programarea `finet-cleanup` (INFRA 4i), evaluarea pe bonuri reale, revizuirea `security`.

### Faza 7: stare
**F7-A (date, extracție, parsere, servicii), gata în repo, verificat local pe PostgreSQL 17 efemer (subseturi; suita completă și build-ul în CI):**
- migrația `0013_statements`: `statement_imports`, `statement_lines`, `statement_usage_daily`; fără modificarea tabelelor existente (tranzacțiile folosesc `source = 'statement'` și `external_ref`); triggere SECURITY INVOKER pentru legătura rând → tranzacție și tranzițiile de stare;
- `src/worker/statements/`: extracția elementelor poziționale din PDF într-un proces copil limitat (`prlimit`, SIGKILL, plafoane);
- `src/modules/statements/`: detectarea băncii, parserele BT/BRD/Raiffeisen/Revolut, verificarea soldurilor, CSV/XLSX/ZIP sigure, maparea de coloane (șablon Wise NEVERIFICAT), deduplicarea, serviciile (previzualizare, confirmare, anulare, renunțare, listă, detaliu, acoperire), cota zilnică.

**Băncile „suportate” (master prompt Faza 7):** niciuna încă în sensul strict (cere un extras REAL anonimizat în `fixtures/statements`; azi fixture-urile sunt sintetice). Parserele BT, BRD, Raiffeisen și Revolut trec local pe extrasele reale ale operatorului (rezultate agregate în raportul F7-A). ING, BCR: mapare manuală; Wise: șablon CSV neverificat.

**Amânate din F7-A (motiv):** PDF-urile băncilor fără parser prin `finet-text-local` / `external_ai_statements` (refuz clar + recomandarea CSV; ADR 0018 §10); extrasele PDF scanate (fără text); stocarea fișierului sursă pentru procesarea în worker (`documents` nu se refolosește: coada bonurilor nu filtrează pe `kind`; ADR 0018 §1); curățarea previzualizărilor neconfirmate vechi; categorisirea automată a tranzacțiilor importate; Revolut/Wise cu mai multe monede în același PDF (un import pe monedă).

**F7-B (API, worker, interfață, potrivire, recurențe), gata în repo, verificat local pe PostgreSQL 17 efemer (subseturi; suita completă, build-ul și E2E în CI):**
- revizuirea F7-A aplicată (cheia `fx`, marcajele de secțiune în descrieri, chei duplicate, anularea transferurilor valutare, contorul zilnic, IBAN-uri);
- migrația `0014_statement_uploads`: `statement_uploads` (PDF-urile până la worker, cel mult 24 h; nu `documents` — ADR 0018 §11), `receipt_match_rejections`, `recurring_suggestion_dismissals`, indexul unic „un bon per tranzacție”, funcțiile SECURITY DEFINER ale cozii și curățării;
- workerul: `statement.sweep` / `statement.parse` (un proces copil odată); curățarea în `cleanup-documents` (PDF-uri expirate, previzualizări > 7 zile);
- API-ul `/api/v1/statements/*`, `/api/v1/receipts/{id}/matches`, `/api/v1/matches`, `/api/v1/recurring/suggestions/*` (OpenAPI regenerat);
- interfața: `/import?tip=extras` (mapare de coloane, coadă PDF), `/statements`, `/statements/[id]` (previzualizare, confirmare), `/statements/coverage`, `/receipts/matches`, potrivirile în `/receipts/[id]`, propunerile în `/recurring`;
- E2E `statements` (scris; NOT RUN local).

**Amânate (motiv):** PDF-urile băncilor fără parser prin AI (`external_ai_statements`; ADR 0018 §10); extrasele scanate; Revolut/Wise cu mai multe monede într-un PDF (refuzat explicit: un extras pe monedă); categorisirea automată a tranzacțiilor importate; evenimente live pentru importuri (un import atinge multe tranzacții).

**Rămâne:** `0013` + `0014` pe Supabase (INFRA 4n, cu verificarea dinainte), E2E și build în CI, revizuirea `security`.

### Faza 8: stare
**F8-A (date și servicii), gata în repo, verificat local pe PostgreSQL 17 efemer (subseturi; suita completă, typecheck-ul complet și build-ul în CI):**
- migrația `0012_family`: `household_invites` (doar hash SHA-256, fără SELECT pe hash și fără DELETE), `transaction_splits` (plătitorul stocat, suma = totalul verificată la COMMIT), `settlements` (anulare o singură dată, fără DELETE), `user_preferences.active_household_id`; `finet.accept_invite` (SECURITY DEFINER, consum atomic, răspuns uniform); triggerele „ultimul owner” și plafonul de 6 membri (sub lock); politicile restrânse prin `ALTER POLICY` pentru vizibilitatea personal/comun; `check_transfer_group` și `due_recurring_rules` redefinite (aceleași semnături);
- serviciile `src/modules/family/`: invitații (create/list/revoke/accept, limită de rată la acceptare, 20/zi la creare), membri (listă, rol, eliminare, plecare, transfer de ownership), comutatorul de gospodărie activă, împărțiri (egal, procente în puncte de bază, sume fixe), solduri (2 și 3 membri, netting pe perechi), decontări (inclusiv parțiale, anulare), audit fără conținut;
- regula conturilor (serviciu + bază): un cont personal doar pentru tine, comun → personal refuzat, personal → comun permis; `updateTransaction` refuză schimbarea sumei/contului/tipului unei cheltuieli împărțite.

**L3 (ultimul owner):** închis în F8-A (ADR 0016, punctul 4).

**Amânate din F8-A (motiv, ADR 0016 punctul 1):**
- vizibilitatea per membru a **documentelor și bonurilor** (`documents`, `receipts`, `receipt_lines`): rămân ale tuturor membrilor, chiar dacă bonul e confirmat pe un cont personal; cere bonuri „personale” și impact pe pipeline-ul Fazei 6;
- **obiective** personale (`goals` rămân comune);
- indexul unic al numelor de conturi pe proprietar (azi un nume de cont personal e „ocupat” pentru toată gospodăria, deci vizibil ca existent);
- semantica bugetelor comune „doar din conturile comune” (azi: din tranzacțiile vizibile cititorului);
- ștergerea contului de utilizator: `accounts.owner_user_id ON DELETE SET NULL` ar face conturile personale comune — **tratat în F9-B** (conturile personale se șterg înainte, în toate gospodăriile; ADR 0021);
- API-ul, UI-ul, SSE și E2E: F8-B (făcut, vezi mai jos).

**F8-B (API, UI, live, E2E), gata în repo (ADR 0017):** endpointurile `/api/v1/family/*`, `/api/v1/invites/accept`, `/api/v1/households/active`, `/api/v1/transactions/{id}/split`, `GET /api/v1/events` (SSE în procesul web, cu rezervă pe interogare periodică); paginile `/family`, `/join/[token]`, comutatorul de gospodărie, cardul de împărțire, widgetul „Ai de dat / Ai de primit”, conturile personale în formular; E2E `family` (modul `personal`).

**Amânate din F8-B (motiv):** evenimente live pentru schimbările făcute de worker/CLI (bon procesat, recurențe generate în fundal: alt proces, ADR 0017); împărțirea direct din formularul de creare a tranzacției (se face din pagina tranzacției după salvare); E2E-ul familiei în modul `saas` (logica nu depinde de mod; timpul job-ului); mai multe instanțe web (magistrala live e în memorie).

**Rămâne:** `0012` pe Supabase (cu verificarea din INFRA 4j) și deploy-ul (INFRA 4k), revizuirea `security` pentru F8-B, verificarea SSE prin tunelul Cloudflare.

### Faza 9: stare (reperul „v1.0 personal”)
**F9-A** (ADR 0020) și **F9-B** (ADR 0021) sunt gata în repo, verificate local pe PostgreSQL 17 (și, pentru F9-B, pe 18) prin subseturi; suita completă, typecheck-ul complet, build-ul, bugetul JS și E2E rulează în CI. Cu Faza 9, varianta `personal` are toate funcțiile din master prompt (Fazele 0–6, 8, 9); **Faza 7 (extrase)** e în lucru pe alt branch și face parte din „v1.0 personal” când e livrată.

**F9-B, gata în repo:** `0016_gdpr_stats` (`app_event_daily`; `finet.erase_current_user`, `aggregate_app_events`, `usage_stats`); `GET /api/v1/me/export`, `GET /api/v1/me/deletion`, `POST /api/v1/me/delete`, `GET /api/v1/admin/stats`; paginile `/settings/privacy` și `/settings/statistics`; `finet-admin aggregate-events`; `ops/postgres/upgrade-test.sh` + `.github/workflows/pg-next.yml`; proiectele E2E `gdpr` și `a11y` (axe-core); SECURITY_CHECKLIST secțiunea 22.

**Rămas pentru „v1.0 personal” (după Faza 9):**
- operatorul: migrația `0016` pe Supabase (`0000`–`0012` sunt aplicate; `0013`–`0015` vin cu Faza 7), deploy-ul F9 (INFRA 4l, 4m), cron-ul `aggregate-events`, backup-ul real și restaurarea de probă, verificarea în browser prin Access;
- CI: prima rulare verde a branch-ului (E2E `pwa`, `gdpr`, `a11y`, `access`; `check:bundle`; `pg-next` manual o dată);
- revizuirile `security` amânate (F2-B … F9-B) și revizuirea independentă a F9-B;
- Lighthouse ≥ 90: rulare manuală pe producție (metoda în `docs/reports/faza-9.md`);
- Faza 7 (extrase), reconcilierea jurnalului de migrații (0013–0015 vs 0016) la merge.

**Amânate din F9-B (motiv):**
- fereastră de grație la ștergerea contului (decizia mea: ștergere imediată, ADR 0021);
- eșecurile de autentificare agregate în „Statistici” (nu se înregistrează încă) și descărcările de pe GitHub (fără acces la API-ul GitHub);
- detaliile pe utilizator în `saas` doar cu motiv în audit (Faza 11);
- jobul care anunță versiunea majoră nouă oferită de Supabase (`ops/postgres/version-check.md`, cere tokenul Management API);
- HSTS `preload` (decizia operatorului; consecințele în SECURITY_CHECKLIST, secțiunea 22).

### Constatări amânate din revizuirea de securitate a Fazei 1 (2026-10-28)
Corectate: H1, M1–M5, L1, L4, L5 (`docs/SECURITY_CHECKLIST.md`, secțiunea 9; ADR 0003). Amânate, cu motivul:
- **L2** — `audit_events` dispar în CASCADE la ștergerea unei gospodării: **închis în F9-B** (decizie: gospodăria se șterge doar la ștergerea contului singurului ei membru, iar jurnalul ei dispare cu ea, ca toate celelalte date; rămâne o linie de log fără id-uri sau conținut; ADR 0021).
- **L3** — protecția „ultimului owner” (nu poate pleca / nu poate fi scos): **închis în F8-A** (triggerul `household_members_guard_owner` + serviciile, ADR 0016).
- **L6** — tokenul de resetare a parolei e stocat în clar (Better Auth nu are `storeToken: "hashed"` pentru resetare): de revăzut la actualizarea Better Auth; azi 30 de minute, unică folosință.
- **L7** — parola generată de CLI apare pe stdout (o singură dată): de decis cu operatorul (fișier 0600 sau doar `--password-stdin`).
- **L8** — `viaBearer` scutește de CSRF și când cererea are și cookie: de restrâns la prima revizuire a clientului Android.
- **Observații din re-verificarea de securitate a Fazei 1 (Low/Info):**
  - N1: `cleanupExpired` din `rate-limit.ts` șterge cel mult 500 de rânduri/min/tip și filtrează cu `left(key, n) = prefix` (fără index); un flood cu emailuri unice depășește rata de ștergere. De trecut la `key like prefix || '%'` cu index `text_pattern_ops` sau la un job periodic cu lot mai mare și `FOR UPDATE SKIP LOCKED`.
  - N2: `releaseRateLimit` după rularea ferestrei decrementează contorul ferestrei noi (câștig de cel mult 1 încercare pe fereastră; neglijabil).
  - N3: cât timp nu există un administrator, un proces `finet_app` compromis își poate promova un utilizator; după primul bootstrap e închis. Un `finet_app` compromis poate rescrie `auth_accounts` (inerent unei aplicații care resetează parole).
  - N4: cheia `/reset-password` are subiect fix per IP; fără IP de încredere (doar dezvoltare) toți împart un bucket global.
- **Ștergerea contului (GDPR)**: **închis în F9-B** (`finet.erase_current_user`, ADR 0021): administratorul platformei e refuzat; gospodăriile cu un singur membru se șterg (nu blochează).
- **Înregistrarea `saas`** va avea nevoie de o funcție de creare a utilizatorilor (Better Auth nu mai creează utilizatori; `finet_app` nu poate insera `status`/`is_platform_admin`).
- Un rol Postgres separat pentru CLI (ar închide și fereastra de bootstrap a `promote_first_admin`): opțional, cere un secret nou.

### Puncte deschise
- **Tokenii shadcn/ui:** închis în F1-C (`surface-2`, `accent-soft`; ADR 0003).
- Versiunea PostgreSQL: confirmată `17` (17.11, eu-west-1, 2026-10-27).
- Planul Supabase (ADR separat).
- Varianta de intrare (tunel vs Traefik) și IP-urile statice.

### Constatări de securitate amânate (revizuirea `security` din Faza 0, T5)
Remediate în Faza 0 (T5): F1 (secrete pe rol, `FINET_ROLE`), F2 (date în `/srv/finet`), F3 (liveness doar `GET`), F4 (`notify.sh` fără LF/CR), F5 (tipare noi în scaner), F7 (`roles.sql` întărit), F8 (`.env.example`). Rămân:
- **F6 — lanțul de aprovizionare CI/imagine** (fără modificări acum la CI și `Dockerfile`):
  - acțiunile GitHub fixate pe SHA de commit, nu pe etichete (`actions/checkout@v7` → `@<sha>`);
  - imaginea de bază fixată pe digest (`node:24.22.1-bookworm-slim@sha256:...`);
  - hash-ul în `packageManager` (`pnpm@12.15.0+sha512...`), verificat de corepack;
  - `pnpm audit --prod` blocant de la severitatea HIGH (acum non-blocant);
  - scanare de secrete în istoric și în PR-uri (gitleaks) în CI.
- **F8 (rest) — antetele de securitate: închis în F1-C** (CSP cu nonce, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`; `docs/SECURITY_CHECKLIST.md`). Rămâne pentru Faza 9: `preload` la HSTS (decizia operatorului). Pagina `global-error` proprie: făcută în Faza 4.
- **F9 — storage local:** închis tehnic în F6-A (`cleanupTemp`, `maxBytes` la `put`); programarea în F6-C (`admin cleanup-documents`, serviciul `finet-cleanup`, cron în INFRA 4i).
- **F2 (rest) / N1 — secretele în data-root-ul Docker: închis tehnic în T7.**
  - Ce s-a făcut: URL-urile bazei și `HEALTH_TOKEN` intră în containere ca fișiere (`secrets:` → `/run/secrets/`, citite prin `*_FILE`, `src/lib/secret-files.ts`), deci nu mai ajung în `config.v2.json`.
  - Fișierele exemplu de mediu nu mai conțin secrete, iar `pnpm test:ops` verifică asta.
  - Ce rămâne: arhiva săptămânală necriptată a `/home/docker` (existentă și viitoare) conține în continuare **mediul ALTOR containere** de pe host. E un risc preexistent, în afara FINET, iar decizia (excludere/criptare) e a operatorului.
  - Logurile `json-file` rămân în arhivă; aplicația nu scrie secrete în ele.
  - Backup-ul propriu criptat al FINET: implementat în Faza 3 (F3-D, restic, `docs/BACKUP.md`); instalarea e a operatorului.
- **F7 (rest) — CA-ul Supabase din cod: închis în T7.**
  - `DATABASE_CA_FILE` + `src/lib/db-client.ts` → `ssl: { ca, rejectUnauthorized: true }` cu `sslmode=verify-full`/`verify-ca`.
  - CA fără sslmode de verificare sau `sslrootcert` în URL → oprire la pornire.
  - `NODE_EXTRA_CA_CERTS` rămâne doar ca variantă de rezervă.
  - Clientul Drizzle din Faza 1 trebuie construit cu `postgresOptions()` din `src/lib/db-client.ts`.
- **Workerul și migrarea reale:** **închis** — `finet-migrate` din Faza 1, `finet-worker` din Faza 5 (F5-A); ambele trec prin `parseConfig` cu `FINET_ROLE` corespunzător.
- **Constatări minore din re-verificarea de securitate (după T5):**
  - N2: **închis în Faza 5** — workerul apelează `parseConfig`; testul `src/worker/worker.test.ts` (`FINET_ROLE=worker` + URL-ul altui rol → cod 1, fără valori în log).
  - N3: **închis în Faza 4** (id Telegram 8–12 cifre; fără excepție pentru JWT `anon`: FINET nu trimite cheia `anon` în browser).
  - N4: pe Supabase (PG16+), `roles.sql` poate cere `grant finet_migrator to current_user;` înainte de `create schema ... authorization`; de verificat pe un proiect real (scriptul se oprește în siguranță la eroare).
  - N5: `notify.sh` scrie antetul `From:` din `SMTP_FROM` întreg; construiește-l din adresa validată plus un nume curățat și refuză virgula.

## Android (`docs/FINET_ANDROID_MASTER_PROMPT.md`)

Audit făcut (2026-11-01): `docs/FINET_ANDROID_AUDIT.md`. Backendul acoperă fazele A–D; mediul local nu poate construi Flutter, deci build-ul rulează doar în GitHub Actions.

| Fază | Stare | Depinde de (web) |
|---|---|---|
| A — Fundație (Flutter în `mobile/`, temă, navigare, client Dio, date simulate, CI) | **în repo** (branch `feature/android-a`, PR de revizuit; ADR 0038): `applicationId` `ro.finet.app`, `minSdk` 29, Flutter 3.47.9; analiză și 113 teste locale trec, APK-ul de debug se construiește doar în CI (`android.yml`); pictograma de lansare e încă cea implicită Flutter (Faza E) | — |
| B — Autentificare și profil | **în repo** (branch `feature/android-b`, ADR 0039): login/logout cu revocare, 401/403, profil și gospodării, `X-FINET-Client`, statistici de utilizare, `FLAG_SECURE`, blocare cu amprentă. Verificat doar pe un server FINET simulat; login pe backendul real și telefonul cu WARP așteaptă hostname-ul și contul de test | Faza 1 + API `/api/v1/` |
| C — Funcții de bază (dashboard, tranzacții, bugete) | neimplementat | Fazele 2–3 |
| D — Recurențe și documente (bonuri, extrase, partajare) | neimplementat | Fazele 5–7 |
| E — Stabilizare și livrare (APK semnat, GitHub Releases) | neimplementat | backend gata în F9-A: `GET /api/v1/app/android/latest`, `/settings/android` |

Telefoanele ajung la FINET prin WARP (`ops/cloudflare/README.md`, pasul 5).

## Paritatea cu produsul de referință finpulse.day (decizie din 2026-10-28)

Operatorul a cerut ca FINET să includă tot ce are produsul de referință, fără să-i copieze defectele. Sursa: `docs/research/rea-finpulse-day-20261028/` (analiza REA și comparația). Funcțiile care lipseau din plan au fost adăugate în `docs/FINET_MASTER_PROMPT.md`:

| Funcție din referință | Faza |
|---|---|
| Plan „Ultra”, prețuri anuale, limite Starter (2.2), tipuri de fișier și prioritate de coadă pe plan | 12 (și 6 pentru coadă și tipuri) |
| Recuperare automată la eroare de încărcare a unui chunk JS | 4 |
| Actualizări live între membri (SSE sau interogare) | 8 |
| Invitație de instalare PWA și ghid `/help` în aplicație | 9 |
| Export pentru contabil (Excel/CSV), indicator de inflație personală, „Întreabă FINET” | 10 |
| Login Facebook, Google Consent Mode v2 pe paginile publice | 11 |
| Recompensă pentru feedback, nivel de suport pe plan | 12 |
| Limbi suplimentare (es, fr, de, it, pl, tr) | 13 |

Nu se preiau defectele referinței (CSP fără `script-src`, categorii suprapuse, duplicate ca funcție plătită, lipsa modului offline, cod de server în bundle-ul de browser): vezi `docs/FINET_MASTER_PROMPT.md` 2.4.

## Rutele aplicației pe faze (paritate cu finpulse.day)

Starea la 2026-10-28: Fazele 0–2 sunt pe producție; paginile Fazei 3 sunt implementate pe `phase/03-dashboard` și ajung în producție după deploy. Coloana „finpulse” arată ruta echivalentă din produsul de referință (analiza REA, `docs/research/rea-finpulse-day-20261028/`).

### Zona autentificată

| Rută FINET | Echivalent finpulse | Faza | Stare |
|---|---|---|---|
| `/login` | `/login` | 1 | producție; Google și Facebook: Faza 11 (`saas`) |
| `/profile` | `/settings` (parțial) | 1 | producție |
| `/settings`, `/settings/android` | `/settings` | 9 | branch (F9-A): ghidul de instalare PWA, aplicația Android (descărcare, QR, pași) |
| `/settings/privacy` | — | 9 | branch (F9-B): exportul GDPR și ștergerea contului |
| `/accounts`, `/accounts/new`, `/accounts/[id]` | — | 2 | producție |
| `/transactions`, `/transactions/new`, `/transactions/[id]` | listă de tranzacții din dashboard | 2 | producție |
| `/transfers/new` | — | 2 | producție |
| `/categories` | — | 2 | producție |
| `/dashboard` | `/dashboard` | 2, extins în 3 | producție (simplu); Faza 3 completă pe branch |
| `/tags` | etichete în dashboard | 3 | branch |
| `/budgets`, `/budgets/new`, `/budgets/[id]` | bugete în dashboard | 3 | branch |
| `/goals`, `/goals/new`, `/goals/[id]` | `/goals` | 3 | branch |
| `/reports` | `/reports` (de bază) | 3; micro-cheltuieli în 10 | branch |
| exporturi CSV (în `/reports` și `/transactions`) | `/export` (CSV) | 3 | branch; Excel și PDF pe `/transactions`, `/goals`, `/budgets`, export pentru contabil pe `/receipts` (F10-C, ADR 0024); pagină `/export` proprie: neimplementată |
| `/recurring`, `/recurring/new`, `/recurring/[id]` | `/recurring` | 5 | branch |
| `/receipts`, `/receipts/[id]` | `/receipts` | 6 | branch (F6-C) |
| `/import` | `/import` | 6 (bonuri), 7 (extrase) | branch (F6-C bonuri; F7-B extrase: fila „Extras bancar”, `?tip=extras`) |
| `/statements`, `/statements/[id]` | „Evidență extrase” | 7 | branch (F7-B): lista importurilor cu anulare, previzualizarea cu confirmare |
| `/statements/coverage` | „Evidență extrase & acoperire” | 7 | branch (F7-B) |
| `/receipts/matches` | — | 7 | branch (F7-B): coada potrivirilor bon ↔ extras |
| `/join/[token]` | — | 8 | branch (F8-B): acceptare prin buton (`POST`), mesaj uniform |
| `/family` | membri, bugete comune, decontări | 8 | branch (F8-B): solduri, decontări, membri, invitații, împărțiri, comun vs personal; comutatorul în antet; împărțirea pe `/transactions/[id]`; widgetul pe `/dashboard` |
| `/offline` | — (la finpulse dă 404) | 9 | branch (F9-A): HTML static, servit din cache de service worker |
| `/help` (ghid în aplicație) | `/help` | 9 | branch (F9-A) |
| `/settings/statistics` | — | 9 | branch (F9-B): statistici de utilizare, doar administratorul platformei (`saas`: panoul de administrare, Faza 11) |
| `/shopping-lists`, `/shopping-lists/[id]`, `/shopping-lists/[id]/compare` | `/shopping-lists` | 10 | branch (F10-A, ADR 0022): liste comune/personale, mod „la raft”, comparație cu bonul confirmat |
| `/insights` | prețuri pe magazin, inflație, rapoarte de micro-cheltuieli | 10 | branch (F10-B, ADR 0023): rapoarte predefinite și proprii, generator cu previzualizare, evoluția prețurilor, inflație personală, export CSV |
| `/ask` | „raport AI în limbaj natural” | 10 | branch (F10-C, ADR 0025): „Întreabă FINET” determinist (set închis de interogări, fără LLM; pasul LLM amânat) și rezumatul lunii pe `/reports` |

### Zona publică și `saas` (Faza 11 și 12)

| Rută FINET | Echivalent finpulse | Faza | Stare |
|---|---|---|---|
| `/` (prezentare randată pe server) | `/` | 11 | branch (11-A, ADR 0027): doar `saas`; în `personal` redirecționează la login sau dashboard |
| `/pricing` | `/pricing` | 11 (pagină), 12 (plăți) | branch (11-A): pagină fără sume, doar `saas`; planurile vin în Faza 12 |
| `/support` (public) | `/support` | 11 | 11-C1 (ADR 0029): șase răspunsuri + contact, doar `saas`; ghidul autentificat rămâne `/help`; 11-C3 (ADR 0031): și în engleză, prin cookie explicit |
| `/terms`, `/privacy` | `/terms`, `/privacy` | 11 | branch (11-A): ciorne marcate vizibil; doar `saas`; revizuirea de către un om și datele firmei rămân de făcut (`SITE_LEGAL_REVIEWED`) |
| `/register` | înregistrare | 11 | branch (11-C1, ADR 0029): doi pași (email → link → parolă), doar `saas` cu `SIGNUP_ENABLED=1` și SMTP; închisă implicit; Turnstile în 11-C2 |
| `/admin` | `/admin` | 11 | branch (11-B, ADR 0028): doar `saas`; 404 pentru non-administratori și în `personal` |
| `/feedback` | feedback și bug-uri (`/api/feedback`, `/api/bug-reports`) | 11 | branch (11-B): un singur formular cu tip feedback/bug, doar `saas`, fără date financiare |
| `/ref/[code]` | `/ref/FIN-XXXXXX` | 12 | planificat, doar `saas` |
| selector de limbă (es, fr, de, it, pl, tr) | limbi multiple | 13 | planificat, doar `saas` |

Nume marcate „provizoriu” se fixează în ADR-ul fazei respective. Rutele din lista de mai sus care apar și la finpulse, dar nu sunt de aici, sunt documentate în `docs/research/rea-finpulse-day-20261028/comparatie-finpulse-finet.md`.
