# FINET — arhitectura (ce există după Fazele 1–4 și F5-A)

Acest document descrie **doar codul existent**. Ce e planificat apare separat, marcat „planificat”. Specificația completă: `docs/FINET_MASTER_PROMPT.md` (secțiunile 3 și 6). Deploy: `docs/INFRA.md`.

## Pe scurt
Monolit Next.js 16 (App Router, TypeScript strict), rulat ca server Node `standalone` într-un container Docker. Din Faza 1: schema Drizzle `finet` cu RLS, Better Auth (parole Argon2id, sesiuni în bază, `bearer`), API-ul `/api/v1/me*`, CLI-ul admin și interfața web de autentificare și profil (F1-C). Din F2-A: registrul financiar (conturi, categorii, tranzacții, transferuri) ca servicii server-side; din F2-B: API-ul `/api/v1` peste ele (cu `Idempotency-Key`), OpenAPI generat și statisticile de utilizare (instalări, evenimente, consimțăminte). Din F2-C: interfața registrului (conturi, tranzacții, transferuri, categorii, soldurile pe dashboard). Nu există încă worker real. Deciziile: ADR 0003 (Faza 1), ADR 0004 (registrul), ADR 0005 (API-ul), ADR 0006 (interfața registrului).

## Structura existentă

```
src/
  app/
    layout.tsx                  # html lang="ro", tema din cookie-ul finet_theme; dinamic (nonce CSP)
    page.tsx                    # `/` → /dashboard sau /login
    login/, register/           # login (email + parolă, magic link doar cu SMTP); /register 404 în personal
    (app)/layout.tsx            # navigare jos pe telefon, meniu lateral pe desktop
    (app)/dashboard, (app)/profile  # paginile protejate (profil: preferințe, parolă, sesiuni)
    not-found.tsx, error.tsx    # 404 și eroarea generică, fără stiluri inline
    _lib/                       # session.ts (sesiunea în pagini, fail closed), next-path.ts (?next= sigur),
                                #   api-client.ts (fetch JSON spre /api), theme.ts, use-hydrated.ts
    _components/logo.tsx        # wordmark-ul FINET (master prompt 3.4)
    fonts.ts, fonts/            # next/font/local: Bricolage Grotesque, IBM Plex Sans/Mono (OFL)
    globals.css                 # tokenii FINET (+ surface-2, accent-soft) și numele shadcn
    api/auth/[...all]           # Better Auth, prin src/modules/auth/handler.ts
    api/v1/me*                  # profil, sesiuni, parolă, consimțăminte (src/app/api/v1/_lib/me-handlers.ts)
    api/v1/{households,accounts,categories,transactions,transfers}  # registrul (_lib/ledger-handlers.ts)
    api/v1/app/events           # evenimentele de utilizare
    api/v1/_lib/http.ts         # stratul comun: sesiune, CSRF, X-FINET-Client, rate limit, erori, corp, idempotență
    api/health/                 # /api/health (protejat) și /api/health/live (liveness)
  components/ui/, components/app/ # Button, Input/Select, Label, Card, Alert; navigarea, iconițele
  messages/ro.ts                # textele interfeței
  proxy.ts                      # Cloudflare Access (fail closed) + antetele de securitate cu nonce
  instrumentation.ts            # validarea configurației la pornire
  lib/
    config.ts, config-startup.ts # mediul, validat cu Zod; oprește pornirea dacă e invalid
    security-headers.ts         # CSP cu nonce, HSTS și celelalte antete (6.3)
    secret-files.ts             # secretele din fișiere (`*_FILE`, Docker secrets)
    db-client.ts, db-url.ts     # clientul Postgres comun (TLS cu DATABASE_CA_FILE)
    access.ts                   # verificarea JWT Access, liveness local, HEALTH_TOKEN
    authz.ts                    # requireMember / withMember (stratul 1 de autorizare)
    money.ts                    # bani în bigint (unități minore), alocare, parsare, formatare RO, procente întregi
    calendar.ts                 # luni calendaristice, data locală / luna curentă în fusul gospodăriei
    storage.ts, storage/        # interfața Storage; driver local; S3 = schelet
    errors.ts, utils.ts
  db/                           # schema Drizzle, migrațiile (0000_core, 0001_rls, 0002_ledger, 0003_idempotency_purge, 0004_budgets_goals_tags), runner-ul, RLS
  modules/auth, profile, sessions, entitlements
  modules/ledger/               # comun registrului: validarea intrărilor (Zod strict, sume prin money.ts),
                                #   `inHousehold` (withMember + traducerea erorilor Postgres), fixture de test
  modules/accounts, categories, transactions, transfers  # *.schema.ts, *.repo.ts, *.service.ts (F2-A)
  modules/tags, budgets, goals  # etichete, bugete (semafor), obiective (F3-A, ADR 0007)
  modules/dashboard, reports, exports  # agregările lunare, raportul lunar, exportul CSV (F3-A; rute în F3-B)
  modules/households/           # gospodăriile utilizatorului (API)
  modules/idempotency/          # Idempotency-Key (rezervare + răspuns în tranzacția scrierii), curățarea
  modules/usage/                # X-FINET-Client → client_installations, consimțăminte, evenimente (6.5)
  openapi/                      # registrul rutelor și schemele răspunsurilor → docs/openapi.json
  tools/admin/                  # CLI-ul admin (dist/tools/admin.mjs)
scripts/scan-client-secrets.mjs # caută secrete în .next/static (CI)
scripts/openapi.mjs, generate-openapi.ts # pnpm openapi:generate / openapi:check
e2e/                            # Playwright: smoke, auth (browser, next dev), access (HTTP, standalone)
ops/                            # docker, cloudflare, supabase, notify, postgres
```

## Fluxul unei cereri
1. Cloudflare (Access) → `cloudflare-tunnel` sau `traefik-main` → `finet-web:3000` (`docs/INFRA.md`).
2. `src/proxy.ts` rulează pe toate căile, cu matcher-ul `["/((?!_next/static/).*)"]`, și apelează `isRequestAllowed` din `src/lib/access.ts`. Ordinea excepțiilor:
   1. asset-urile statice Next (`/_next/static/`), excluse și din matcher, și din cod (`isStaticAssetPath`);
   2. `GET /api/health/live` (doar metoda `GET` și exact această cale; `HEAD`/`POST` etc. cer Access, iar `/api/health/live/` primește întâi un 308 de la Next spre calea exactă) doar dacă cererea e locală (`isLocalProbe`: `Host` loopback, fără `cf-connecting-ip`, `cf-ray`, `cf-ipcountry`, `x-real-ip`, `cf-access-jwt-assertion`, `X-Forwarded-*` doar loopback);
   3. `/api/health` cu `X-Finet-Health-Token` egal cu `HEALTH_TOKEN` (comparare în timp constant), doar dacă tokenul e configurat;
   4. altfel, cu `CF_ACCESS_REQUIRED=true`, e nevoie de un JWT `Cf-Access-Jwt-Assertion` valid (RS256, cheile de la `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud`, `iss`, `exp`).
   - `/favicon.ico` **nu** e exclus (nu există favicon; cererea ar fi randată prin layout).
   - **Fail closed:** orice eroare (configurație invalidă, chei indisponibile, token greșit) → 403 JSON `{"error":{"code":"forbidden",...}}`, `Cache-Control: no-store`.
3. După decizia de acces, `src/proxy.ts` pune antetele de securitate (`src/lib/security-headers.ts`) pe ambele ramuri (403 și cererea permisă): CSP cu un nonce nou per cerere (pus și în antetele cererii, ca Next să-l atașeze scripturilor), HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`; fără antete CORS. `/_next/static/` primește antetele fixe din `next.config.ts`.
4. Route handler-ele / paginile răspund. Paginile protejate verifică sesiunea pe server (`src/app/_lib/session.ts` → `requireSession`); fără sesiune: 307 spre `/login?next=<cale>`. Mutațiile din browser trec prin aceleași rute `/api/auth/*` și `/api/v1/*` ca aplicația Android (rate limiting, CSRF prin `Origin`, audit).

## Configurația
`src/lib/config.ts` citește `process.env` o singură dată (leneș, nu la `next build`) și validează cu Zod. Reguli notabile: `APP_MODE` obligatoriu; `FINET_ROLE` (`web` implicit, `worker`, `migrate`) alege singurul URL de bază de date permis procesului (`DATABASE_URL`, `WORKER_DATABASE_URL`, respectiv `MIGRATOR_DATABASE_URL`); URL-ul altui rol prezent în mediu oprește pornirea, iar serverul Next.js pornește doar cu `FINET_ROLE=web` (`src/lib/config-startup.ts`); `Config.database` are `url` (al rolului curent) și `ca` (PEM-ul din `DATABASE_CA_FILE`, citit o dată; cere `sslmode=verify-full`/`verify-ca`, iar `sslrootcert` din URL e refuzat); fiecare secret poate veni dintr-un fișier, `<NUME>_FILE` (`src/lib/secret-files.ts`: `X` și `X_FILE` împreună = eroare, fișier obișnuit ≤ 4096 octeți, o linie, regula pe rol se aplică și `_FILE`-urilor, ale căror fișiere nici nu se deschid); în producție `CF_ACCESS_REQUIRED=false` e refuzat și `STORAGE_DIR` e obligatoriu (nu pentru `migrate`); `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` obligatorii când Access e cerut, doar pentru `web`; `HEALTH_TOKEN` ≥ 32 caractere; `AI_MONTHLY_BUDGET` parsat ca bani (bigint), monedă `AI_MONTHLY_BUDGET_CURRENCY`; Telegram cere ambele variabile; `SMTP_HOST` cere `SMTP_FROM`. Mesajele de eroare nu conțin valori. Lista: `.env.example`.

## Bani
`src/lib/money.ts`: sume `bigint` în unități minore, monedă obligatorie, fără `Number` pentru sume; alocare cu metoda restului cel mai mare; parsare și formatare românească. Acoperit de `src/lib/money.test.ts`.

## Registrul financiar (F2-A)
Serviciile din `src/modules/{accounts,categories,transactions,transfers}` primesc `(deps: { db }, actor, householdId, input: unknown)`: `actor.userId` vine din sesiune, `householdId` din sesiune sau din ruta validată, iar `input` se validează cu Zod strict (cheile necunoscute, de exemplu `householdId`, sunt respinse). Fiecare operație rulează în `withMember` (apartenența și accesul la date în aceeași tranzacție, contextul RLS setat), iar fiecare query filtrează explicit pe `household_id`. Resursele străine sau inexistente dau `NotFoundError`; regulile de stare dau `ConflictError` (409, cu `reason`), intrările invalide `ValidationError` (400).
- **Conturi:** soldul se calculează la citire (sold inițial + venituri − cheltuieli + transferuri intrate − ieșite), în `bigint`; totalurile pe monedă, fără conversie; arhivare; ștergere doar a conturilor goale.
- **Categorii:** 28 de categorii de sistem (5.4, `system_key` stabil), ascunse per gospodărie prin `category_visibility`; personalizate pe un singur nivel; ștergerea unei categorii folosite cere reasignarea.
- **Tranzacții:** venituri și cheltuieli în moneda contului; căutare (`ILIKE` escapat), filtre, sortare pe dată sau sumă, paginare keyset cu cursor opac (`{ data, nextCursor }`, `limit` ≤ 100); ștergere definitivă cu audit fără sume.
- **Transferuri:** două rânduri `transfer` (`out`/`in`) cu același `transfer_group_id`, scrise în aceeași tranzacție SQL; monede diferite → ambele sume explicit; baza verifică grupul la COMMIT.
- Integritatea e dublată în bază (cheie compusă cont/gospodărie/monedă, CHECK-uri, triggere `SECURITY INVOKER`); detaliile în ADR 0004.

## Planificare și raportare (F3-A)
Serviciile din `src/modules/{tags,budgets,goals,dashboard,reports,exports}` urmează modelul registrului (`inHousehold`, Zod strict, filtru explicit pe gospodărie, RLS); cele care depind de „luna curentă” primesc `PlanningDeps` (`db` + ceasul `now`, injectabil). Bugetele: cheltuit = cheltuielile lunii (fără transferuri și venituri), semafor din comparații exacte în `bigint`, procent `floor`. Dashboard-ul și raportul: totaluri separate pe monedă, subcategoriile agregate la părinte. Exportul CSV: `exportTransactionsCsv` e un `AsyncGenerator<string>` (numărare, apoi pagini de cursor), `exportGoalsCsv`/`exportBudgetsCsv` întorc un șir. Detalii: ADR 0007.

### API-ul planificării (F3-B)
`src/app/api/v1/_lib/planning-handlers.ts` expune etichetele, bugetele (`/budgets/status` cu semafor și `alerts`), obiectivele (contribuții cu `Idempotency-Key` obligatoriu, renunțare), dashboard-ul, raportul lunar și exporturile CSV, peste același `handle()`. Handlerele dau serviciilor ceasul cererii; `?month=` e validat în handler (de la 60 de luni în urmă până la luna curentă a gospodăriei). Răspunsurile de tranzacție au `tags: [{ id, name, color }]` (o interogare pe pagină). Exportul tranzacțiilor e un `ReadableStream` peste generatorul serviciului: primul fragment (validare, numărare, plafon, audit `export.downloaded`) se calculează înaintea răspunsului, ca erorile să iasă ca JSON; exporturile au rate limit propriu (`api_export`, 10/min). Detalii: ADR 0007 („API (F3-B)”), `docs/API.md`.

## API-ul `/api/v1` (F2-B)
Handlerele din `src/app/api/v1/_lib/` sunt subțiri: `handle()` verifică sesiunea (cookie sau bearer), CSRF-ul pe mutațiile cu cookie, înregistrează instalarea din `X-FINET-Client` (fără să blocheze), aplică rate limiting pe mutații și mapează erorile de domeniu în `{ error: { code, message, fields?, reason? } }`. Gospodăria vine din bază (`currentHousehold`). Crearea cu `Idempotency-Key` rulează în `runIdempotent`: o tranzacție cu lock consultativ, rezervarea cheii, serviciul într-un savepoint (`DbOrTx`) și răspunsul memorat. Contractul e în `src/openapi/registry.ts`; `docs/openapi.json` se generează din el, iar testele verifică fiecare răspuns real față de schemă. Detalii: `docs/API.md`, ADR 0005.

## Interfața registrului (F2-C)
Paginile din `src/app/(app)/` apelează fiecare `requireLedgerPage(<cale>)` (`src/app/_lib/ledger-page.ts`: sesiunea, gospodăria curentă din bază, consimțământul `usage_stats`) și citesc datele direct din servicii, pe server; componentele client primesc forma JSON a API-ului. `load()` dă 404 uniform pentru resursele străine sau inexistente. Mutațiile pleacă din browser doar prin `/api/v1/*` (`api-client.ts`, `use-submit.ts`: blocare sincronă la dublu-clic, `Idempotency-Key` legat de corp), urmate de `router.refresh()`. Sumele: `parseAmount` → `toJson` la intrare, `formatMoney(fromJson(...))` la afișare (`ledger-ui.ts`). Filtrele tranzacțiilor sunt un formular GET, transformat în interogarea API de `transaction-filters.ts`; „Încarcă mai mult” folosește cursorul API-ului. `X-FINET-Client` (`usage-client.ts`) pleacă doar cu acordul activ. Detalii: ADR 0006.

## Interfața planificării (F3-C)
Paginile `/dashboard`, `/tags`, `/budgets` (+ `new`, `[id]`), `/goals` (+ `new`, `[id]`) și `/reports` urmează regulile din ADR 0006 (citiri pe server prin servicii, mutații prin `/api/v1/*`). Luna (`?month=`) se validează în pagină cu aceeași fereastră ca API-ul (`planning-page.ts` + `pickMonth` din `planning-ui.ts`); o lună invalidă afișează luna curentă cu un mesaj. Graficele și barele de progres sunt SVG randat pe server (`src/components/planning/charts.tsx`), scalat în întregi prin `percentOf`, cu dimensiunile ca atribute (fără `style=`) și tabel text alternativ. Exporturile CSV se descarcă prin `fetch` cu cookie (`download.ts`), mereu cu `dialect=ro`. Filtrele tranzacțiilor au `merchant` și `tagIds` (un singur parametru cu virgule spre API). Detalii: ADR 0008.

## Recurențe și workerul (F5-A)
`src/modules/recurring/` (schema/serviciu/repo, ca restul registrului): reguli cu stările `active|paused|completed`, generare idempotentă (ocurența `(rule_id, occurrence_date)` se revendică înaintea tranzacției, în aceeași tranzacție SQL; regula blocată `FOR UPDATE SKIP LOCKED`), recuperare limitată la 12 scadențe pe regulă pe rulare, reluare fără retroactiv; calendarul în `src/lib/calendar.ts`. Workerul (`src/worker/`, `FINET_ROLE=worker`, imaginea de unelte `dist/tools/worker.mjs`): pg-boss ca `finet_app` (schema `pgboss` din migrația 0007, fără DDL la rulare), jobul orar `recurring.generate` (scadențele tuturor gospodăriilor prin `finet.due_recurring_rules`, doar id-uri; generarea în contextul RLS al fiecărei gospodării) și `recurring.generate-now` (o gospodărie, un membru). Semnalul de viață în `finet.service_heartbeats`. Detalii: ADR 0011. API-ul (`src/app/api/v1/_lib/recurring-handlers.ts`, rutele `/api/v1/recurring/**`) și UI-ul (`src/app/(app)/recurring/**`, ajutoarele pure `src/app/_lib/recurring-ui.ts`): butonul „Generează scadentele” apelează serviciul direct, în serverul web (fără pg-boss în web), cu `Idempotency-Key` obligatoriu. Detalii: ADR 0012.

## Storage
Interfața `Storage` (`put`/`get`/`delete`/`exists`); cheile `<prefix>/<uuid>` sunt generate de storage, validate strict la citire. Driverul `local` e confinat în `STORAGE_DIR` (realpath, `O_NOFOLLOW`, scriere atomică). Driverul `s3` aruncă `NotImplementedError` (Faza 6).

## Sănătatea
`/api/health`: `db` (`select 1`, clientul comun din `src/lib/db-client.ts` cu o conexiune, `prepare: false`, TLS după `sslmode` și CA), `storage` (scriere/citire/ștergere), `diskFreePercent`; `queue` din semnalul workerului (`ok`, `degraded` peste 180 s, `unknown` dacă workerul e oprit sau n-a pornit; fără pg-boss în serverul web); `ai` = `unknown`. `down` (503) dacă oricare e `down`; `degraded` dacă oricare e `degraded`; `ok` doar dacă `db` și `storage` sunt `ok`; altfel `degraded`. Fără versiuni, căi sau mesaje de eroare în răspuns.

## Deploy și CI
- Imaginea: `Dockerfile` (multi-stage, user non-root, healthcheck). Compose: `ops/docker/docker-compose.yml` (`finet-web`, `finet-worker` și `finet-migrate`, fiecare cu `FINET_ROLE` fixat, propriul `env_file` nesecret din `/srv/finet/env/`, doar secretele rolului său ca fișiere `secrets:` din `/srv/finet/secrets/` și CA-ul Supabase montat read-only).
- CI: `.github/workflows/ci.yml`: job-ul `ci` (install, lint, format, `openapi:check`, typecheck, migrații de două ori, teste cu PostgreSQL `ops/postgres/VERSION`, build, scanarea secretelor, audit non-blocant) și job-ul `e2e` (migrații, utilizatori prin CLI, Playwright Chromium: `smoke`, `auth`, `ledger` în `personal` apoi în `saas`, plus `access` pe serverul de producție). Coverage nu rulează în CI.

## Planificat (nu există încă)
Cozile documentelor (Faza 6), driverul S3, `lib/ai/`, sharp (Faza 6), înregistrarea publică și modul `saas` (Faza 11). Graficele nu folosesc Recharts (SVG propriu, ADR 0008).
