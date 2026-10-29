# Raportul Fazei 9 — Hardening, PWA și offline

Branch `phase/09-hardening` (din `main` 67b1c0c). Faza are două părți: **F9-A** (PWA, service worker, scanarea offline, ghidul, pagina Android; ADR 0020) și **F9-B** (export/ștergere GDPR, „Statistici”, upgrade Postgres, audit Lighthouse/a11y, dovezile din SECURITY_CHECKLIST). Acest document conține ambele secțiuni.

## F9-A — PWA, service worker, scanare offline, ghid, Android

### 1. Ce s-a implementat

- **Manifest și iconițe:** `public/manifest.webmanifest` (`start_url` `/dashboard`, `standalone`, `portrait`, `lang` `ro`, culorile temei, scurtătura „Scanează”), iconițe `any` + `maskable` 192/512 și `apple-touch-icon` 180 (opac), generate determinist de `scripts/make-pwa-icons.mjs` din simbolul logoului. `<link rel="manifest" crossOrigin="use-credentials">` scris manual în `src/app/layout.tsx` (cererea implicită nu trimite cookie-ul Access), `appleWebApp` și iconițele în metadate.
- **Service worker:** `src/pwa/sw-source.ts`, servit de `src/app/sw.js/route.ts` (`no-cache`, `Service-Worker-Allowed: /`), versionat cu `BUILD_ID`. Cache-first doar pentru asset-uri statice; navigări doar prin rețea, cu `/offline` la eșec de rețea; fără `respondWith` pe API/non-GET/alte origini; precache validat; curățarea versiunilor vechi; plafon de intrări; actualizare doar la clic (banner, `SKIP_WAITING`, amânată cu formular necomis).
- **`/offline`:** HTML static (`src/pwa/offline-page.ts`, `src/app/offline/route.ts`) + `public/pwa/offline.{css,js}`, compatibil cu CSP-ul cu nonce din cache; arată numărul scanărilor în așteptare.
- **Scanarea offline:** `src/app/_lib/offline-scans.ts` (logica pură), `offline-scans-idb.ts` (IndexedDB), `offline-scans-client.ts` (orchestrarea: pornire, `online`, Background Sync ca semnal, backoff, Web Locks); integrarea în `/import` (bannerul offline, „Păstrează pentru mai târziu”, lista „În așteptare pe acest dispozitiv” cu „Reîncearcă”/„Șterge”), `OfflineSync` în layout-ul autentificat, ștergerea bazei la deconectare (`app-nav.tsx`).
- **Proprietarul impus de server** (constatarea coordonatorului): încărcările din coadă trimit `X-FINET-Expected-User`/`X-FINET-Expected-Household`; `POST /api/v1/documents` răspunde 409 `owner_mismatch` (`reason: user|household`) la nepotrivire, înainte de citirea corpului; clientul șterge intrarea (alt cont) sau o păstrează (altă gospodărie), nu o retrimite și recitește proprietarul prin `GET /api/v1/me` înaintea fiecărei treceri.
- **Server:** reîncercarea EXACTĂ a unui bon lung → 200 duplicat (`documents.service.ts`, `exactLongReceiptBatch`; `documents.repo.ts`, `countBatchDocuments`). Fără migrație.
- **Instalare și ghid:** invitația de instalare (`InstallPrompt`: Chromium/Android cu `beforeinstallprompt`, iOS cu instrucțiuni; închisă definitiv prin `localStorage`, în try/catch), `/help` (conturi, tranzacții, bonuri, extrase „în curând”, familie, instalare, întrebări frecvente), `/settings`, „Setări” și „Ajutor” în navigare.
- **Android:** `GET /api/v1/app/android/latest` (`src/app/api/v1/_lib/app-handlers.ts`, `src/modules/app-release/android.ts`; sursa `<STORAGE_DIR>/app/android-latest.json`), în OpenAPI (`getAndroidLatest`, tagul `app`) și `docs/API.md`; pagina `/settings/android` cu cod QR generat local (`src/lib/qr.ts`).
- **Documentație:** ADR 0020, SECURITY_CHECKLIST §21, PRIVACY_NOTES („PWA și scanarea offline”), INFRA 4l, API.md, ROADMAP.

### 2. Teste rulate local

Mediu: `node:24` în container (`--memory` 500–950 MB), PostgreSQL 17 efemer `finet-ci-pg-f9` (`--memory=256m`) pe rețeaua `finet-ci-net-f9`, șterse la final.

| Comandă | Rezultat |
|---|---|
| `vitest run src/pwa src/lib/qr.test.ts src/app/_lib/offline-scans.test.ts src/app/_lib/pwa-ui.test.ts src/app/api/v1/app-api.test.ts src/openapi src/proxy.test.ts src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/contrast.test.ts src/app/smoke.test.ts src/app/api/routes.test.ts src/app/_lib/chunk-recovery.test.ts` (cu PG) | PASS (14 fișiere, 143 de teste) |
| `vitest run src/modules/documents/documents.test.ts src/app/api/v1/documents-api.test.ts src/proxy.test.ts` (cu PG) | PASS (3 fișiere, 71 de teste) |
| `node scripts/openapi.mjs` apoi `--check` | PASS (`docs/openapi.json` regenerat, +1 operație) |
| `tsc --noEmit` pe un tsconfig temporar cu fișierele sursă F9-A (fără teste și E2E) | PASS |
| `eslint --max-warnings=0` pe fișierele atinse (inclusiv teste, E2E, `public/pwa/offline.js`) | PASS |
| `prettier --write` pe fișierele atinse | aplicat |
| `playwright test --list --project=pwa --project=access` | 6 teste `pwa` + 14 `access` listate |
| QR: vectori comparați modul cu modul cu python-qrcode 8.2 (7 cazuri, v1–v10, măști 0–7) | PASS |
| E2E `pwa` și `access` (browser / server de producție) | NOT RUN local (memoria gazdei; `next build` interzis local) — rulează în CI |
| `pnpm test` complet, `tsc` complet, `next build`, `check:bundle` | NOT RUN local (regula F9-COMUN; CI) |
| axe / Lighthouse pe paginile noi | NOT RUN (`@axe-core/playwright` nu e instalat; F9-B) |

### 3. Decizii („decizia mea”)

- Nicio excepție nouă de la Access; iconițele cerute fără cookie la instalare = risc acceptat, cu varianta de bypass exact documentată pentru operator (ADR 0020 §1).
- `/offline` ca HTML static, nu pagină React (nonce înghețat în cache, chunk-uri lipsă).
- În dezvoltare SW-ul nu pune în cache `/_next/static`.
- Fără `fake-indexeddb` (arbore `node_modules` comun cu Faza 7): abstracția `ScanStore` + `MemoryScanStore`; IndexedDB real în E2E.
- Plafoanele cozii: 10 încărcări, 50 MB, 7 zile, doar JPEG/PNG.
- Owner = utilizator + gospodăria activă; alți utilizatori → șterse la pornire; aceeași persoană, altă gospodărie → păstrate, încărcate după comutare; deconectare → `deleteDatabase`.
- Fără `Idempotency-Key` la încărcare (SHA-256); reîncercarea exactă a bonului lung devine 200 duplicat.
- Metadatele Android într-un fișier cu cale fixă sub `STORAGE_DIR` (fără variabilă nouă); 404 `android_release_unavailable` când lipsesc.
- Codul QR fără dependență (generator propriu, verificat cu o bibliotecă independentă).
- „Setări” = pagină nouă `/settings` (profilul rămâne `/profile`).

### 4. Puncte deschise

- Rularea E2E `pwa`/`access` și `check:bundle` în CI (componentele PWA sunt în layout → câțiva KiB pe toate rutele autentificate).
- În `saas`, testele E2E ale cozii offline (scanare, eroare permanentă, deconectare) se sar: `/import` și încărcarea depind de `entitlements`, neimplementate în `saas` până în Faza 11 (aceeași situație ca proiectul `receipts`); restul proiectului `pwa` rulează în ambele moduri.
- Background Sync doar trezește paginile deschise; fără pagină deschisă, încărcarea are loc la următoarea deschidere.
- Linkul APK servit de FINET după autentificare (repository privat, promptul Android 12.1): nefăcut; `url` trebuie să fie https (GitHub Releases).
- Audit axe/Lighthouse și revizuirea `security`: F9-B / agenții de revizuire.

## F9-B — GDPR, Statistici, upgrade PostgreSQL, audit (ADR 0021)

### 1. Ce s-a implementat (și ce a rămas parțial)

- **Migrația `0016_gdpr_stats`** (numărul 0016, `when` 1794600000000: 0013–0015 sunt ale Fazei 7, jurnalul se reconciliază la merge). Conține:
  - tabelul `app_event_daily`, cu RLS ENABLE și FORCE, fără drepturi pentru `finet_app`;
  - funcțiile `finet.erase_current_user`, `finet.aggregate_app_events` și `finet.usage_stats`;
  - politicile proprietarului, legate de `finet.definer_scope`.
  - Nu adaugă coloane și nu rescrie date pe tabelele existente.
- **Ștergerea contului:** `POST /api/v1/me/delete`, previzualizarea `GET /api/v1/me/deletion`, serviciul `src/modules/gdpr/account-deletion.ts`, UI-ul `/settings/privacy`.
  - Cere parola (sau o sesiune proaspătă) și textul `ȘTERGE`.
  - Ultimul owner cu alți membri și administratorul platformei primesc 409.
  - Gospodăria în care e singurul membru se șterge, cu fișierele ei.
  - Din gospodăriile comune iese, cu audit.
  - Conturile lui personale se șterg peste tot, fără să devină comune; jumătatea comună a unui transfer devine o tranzacție obișnuită.
  - Rândul `users` se șterge sau, dacă e referit din istoricul altora, se anonimizează.
  - Totul într-o singură tranzacție. În UI, coada offline se golește.
- **Exportul GDPR:** `GET /api/v1/me/export`, o arhivă ZIP în flux (`src/lib/zip.ts`, fără dependență nouă; `src/modules/gdpr/data-export.ts`).
  - Conține JSON, tranzacțiile și în CSV, și fișierele bonurilor utilizatorului.
  - Interogările rulează sub RLS-ul utilizatorului; filtre explicite pentru împărțiri, decontări, audit și documente.
  - 3 exporturi pe oră.
- **Retenția `app_events`:** `finet-admin aggregate-events` agregă evenimentele mai vechi de 13 luni pe zi, nume, platformă, versiune, ecran și cod de eroare, apoi le șterge.
- **„Statistici”:** `GET /api/v1/admin/stats` și `/settings/statistics`, doar pentru administratorul platformei.
  - Conținut: utilizatori activi, instalări pe versiune (cu stare față de ultima versiune Android), descărcări, login-uri, funcții, ecrane, erori, AI și costul de operare, evenimentele arhivate, membrii (doar în `personal`).
  - **Parțial:** eșecurile de autentificare agregate (nu se înregistrează) și descărcările de pe GitHub (fără acces la API-ul GitHub).
- **Upgrade PostgreSQL:** `ops/postgres/upgrade-test.sh` și `upgrade-seed.sql`, workflow-ul săptămânal `.github/workflows/pg-next.yml`, procedura în INFRA §7. Am încercat efectiv 17 → 18 (secțiunea 3).
- **Audit:**
  - accesibilitate: proiectul E2E `a11y` (axe-core, WCAG 2.1 A/AA, 18 pagini);
  - E2E `gdpr` (export, ștergere, statistici);
  - `SECURITY_CHECKLIST` secțiunea 22 (controalele noi, HSTS `preload`, parcurgerea secțiunilor 1–21, lista consolidată a punctelor deschise).
  - **Lighthouse ≥ 90: NOT RUN** (metoda în secțiunea 4).
- **Corecții:** ceasul testului `idempotency.test.ts` pornește de la `Date.now()` (un ceas fix în trecut făcea sesiunile să expire în CI după 10:30Z, PR #30).

### 2. Fișierele

- Noi:
  - `src/db/schema/usage.ts`, `src/db/migrations/0016_gdpr_stats.sql`, `meta/0016_snapshot.json`;
  - `src/modules/gdpr/{gdpr.schema,account-deletion,data-export,testing}.ts` + teste, `src/modules/usage/{stats,stats.schema}.ts` + teste, `src/lib/zip.ts` + teste;
  - `src/app/api/v1/_lib/gdpr-handlers.ts`, rutele `me/{export,deletion,delete}`, `admin/stats`, `gdpr-api.test.ts`;
  - `src/app/(app)/settings/{privacy,statistics}/*`, `e2e/{gdpr,a11y}.spec.ts`;
  - `ops/postgres/{upgrade-test.sh,upgrade-seed.sql}`, `.github/workflows/pg-next.yml`, ADR 0021.
- Modificate:
  - jurnalul migrațiilor, `migrate.test.ts`, `src/db/schema/index.ts`;
  - `http.ts` (limita `gdprExport`), `rate-limit.ts` (tipurile `account_delete`, `gdpr_export`), `audit.ts` (`user.data_exported`), `testing.ts` (contractul);
  - registrul și documentul OpenAPI, `docs/openapi.json`, `cli.ts` (+ test), `/settings`, `ro.ts`;
  - `proxy.test.ts`, `e2e/{access.spec,fixtures}.ts`, `playwright.config.ts`, `ci.yml` (utilizatorii și proiectele E2E);
  - `package.json` și `pnpm-lock.yaml` (`axe-core`);
  - `ops/postgres/{README,version-check}.md`, documentația (ROADMAP, INFRA 4m și §7, PRIVACY_NOTES, API.md, SECURITY_CHECKLIST, acest raport).

### 3. Teste rulate local

Mediu: `node:24` în container (`--memory` 500–1300 MB), PostgreSQL efemer `--memory=256m` pe rețeaua `finet-ci-net-f9b`, șters la final.

| Comandă | Rezultat |
|---|---|
| `vitest run src/db/migrate.test.ts` (PG17) | PASS (34) |
| `vitest run src/modules/gdpr src/app/api/v1/gdpr-api.test.ts src/db/migrate.test.ts` (PG17, după garda administratorului) | PASS (47) |
| `vitest run src/modules/usage/stats.test.ts src/app/api/v1/gdpr-api.test.ts` (PG17) | PASS (8) |
| `vitest run src/tools/admin/cli.test.ts` (PG17) | PASS (10) |
| `vitest run src/lib/zip.test.ts` (Python `zipfile` + `unzip -t`) | PASS (3) |
| `vitest run idempotency.test.ts me.test.ts documents-api.test.ts documents.test.ts` (PG17, după schimbările din `http.ts`/`rate-limit.ts` și ceas) | prima rulare: 1 FAIL sub încărcare (test sensibil la timp, nereprodus); apoi 2 × PASS (56) |
| `vitest run src/openapi`, `node scripts/openapi.mjs --check` | PASS |
| `vitest run ui-rules a11y-rules contrast smoke proxy` | PASS (57) |
| `tsc --noEmit` pe un tsconfig temporar cu fișierele F9-B (surse, UI, E2E) | PASS |
| `eslint --max-warnings=0` și `prettier` pe fișierele atinse | PASS |
| `drizzle-kit generate` după 0016 | „No schema changes” |
| `pnpm install --frozen-lockfile --lockfile-only` (copie izolată, după `axe-core`) | PASS |
| `playwright test --list --project=gdpr --project=a11y --project=access` | 19 teste listate |
| **Încercarea upgrade-ului 17.11 → 18.6** (`upgrade-test.sh`, de două ori; a doua după ultima modificare a 0016) | PASS: amprenta identică (1270 de linii), `finet_app` tot supus RLS; migrațiile pe baza restaurată „aplicate acum 0, deja aplicate 14” |
| pe **PG18**: `src/db/{migrate,rls,grants,family-rls,ledger-rls,planning-rls,household-limit}.test.ts` | PASS (123) |
| pe **PG18**: `src/modules/gdpr`, `usage`, `gdpr-api`, `family.test.ts`, `transactions`, `transfers`, `cli`, `zip` | PASS (84). Excepții: 1 FAIL în `family.test.ts` într-o rulare paralelă, PASS la 2 rulări separate. La a doua încercare, 5 FAIL în `migrate.test.ts` rulat în paralel cu alte fișiere (PG plafonat la 256 MB), PASS (34) rulat singur |
| E2E `gdpr`, `a11y`, `access`, `pwa`; `pnpm test` complet; `tsc` complet; `next build`; `check:bundle`; `pg-next` | NOT RUN local (memoria gazdei, regula F9-COMUN) — CI |
| Lighthouse | NOT RUN (vezi secțiunea 4) |

Constatările încercării 17 → 18:
- PostgreSQL 18 păstrează NOT NULL ca rânduri `pg_constraint` (`contype 'n'`);
- `pg_dump` omite un ACL egal cu implicitul proprietarului.
- Ambele sunt diferențe de catalog, fără efect pe date sau drepturi; amprenta le normalizează (coloanele cu `attnotnull`, ACL-ul efectiv cu `acldefault`).
- Nicio incompatibilitate a migrațiilor, politicilor sau funcțiilor FINET cu PostgreSQL 18.
- `ops/postgres/VERSION` rămâne `17` (versiunea proiectului Supabase).

### 4. Pornire și deploy

`docs/INFRA.md` 4m:
1. verificarea dinainte (doar citire);
2. backup, apoi migrația `0016`;
3. imaginile `finet-web` și `tools`;
4. cron-ul `aggregate-events` la 04:35;
5. verificările în browser (ștergerea doar pe un cont de test).

Lighthouse (țintă ≥ 90 la accesibilitate, bune practici și performanță, pe mobil), metoda manuală: Chrome DevTools → Lighthouse pe producție, prin Access, logat, pe `/dashboard`, `/transactions`, `/import`, `/settings/privacy`; rezultatul se notează în SECURITY_CHECKLIST. În CI ar cere Chrome + `lighthouse` pe serverul de producție din spatele Access, deci nu e configurat.

### 5. Variabile de mediu noi

Niciuna. Niciun secret nou.

### 6. Riscuri, ADR, revizuirea de securitate

- ADR 0021. Riscurile acceptate:
  - fișierele orfane la o ștergere eșuată (procedură manuală);
  - datele unui cont șters rămân în backup-uri până la expirarea instantaneelor;
  - împărțirile cheltuielilor din conturile personale ale celui șters dispar odată cu ele (soldurile față de el se pot schimba; restul istoricului rămâne sub „Cont șters”).
- Revizuirea `security` independentă a F9-B: **TODO**.
- Puncte deschise: SECURITY_CHECKLIST 22.4.

### 7. „Decizia mea”

- Fără fereastră de grație: ștergerea e imediată (exportul e oferit chiar deasupra).
- Conturile personale se șterg (nu se păstrează invizibile, nu devin comune). Jumătatea comună a transferurilor devine venit sau cheltuială, ca soldul comun să rămână corect.
- Rândul `users` se anonimizează când împărțiri sau decontări ale altora îl referă; altfel se șterge.
- Administratorul platformei nu se poate șterge din aplicație.
- Documentele încărcate într-o gospodărie comună rămân ale gospodăriei.
- Evenimentele de utilizare se șterg la ștergerea contului (nu se anonimizează).
- Exportul: membrii fără numele altora; documentele doar ale utilizatorului.
- `axe-core` (deja în arbore) în locul `@axe-core/playwright`; criteriul `serious`/`critical`.
- `ops/postgres/VERSION` neschimbat; un workflow săptămânal `pg-next` în locul unei schimbări temporare a versiunii.
- Costul AI (de operare) apare în „Statistici”.

### 8. Următorii pași

1. Prima rulare CI a branch-ului (E2E `gdpr`, `a11y`, `access`, `pwa`; `check:bundle`; `pg-next` manual).
2. Revizuirea `security` a F9-A și F9-B.
3. Merge cu Faza 7 (jurnalul migrațiilor: 0013–0015, apoi 0016).
4. Deploy-ul (INFRA 4l, 4m) și cron-ul `aggregate-events`.
5. Lighthouse pe producție.

