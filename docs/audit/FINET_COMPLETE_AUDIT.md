# FINET — audit complet al depozitului (2026-11-07)

Audit făcut pe `main` la `d78d601` (PR #80), înaintea branch-ului `feature/finet-modernization-2026`. Metoda: citirea structurii, a documentelor (`ARCHITECTURE`, `ROADMAP`, `SECURITY_CHECKLIST` §1–41, `PERFORMANCE`, `BACKUP`, ADR 0001–0044), a schemei Drizzle și a migrațiilor, a stratului HTTP (`src/app/api/v1/_lib/http.ts`), a workflow-urilor CI, a `Dockerfile`, a aplicației Flutter (`mobile/`) și rularea locală a `pnpm outdated`, `pnpm audit --prod`, `pnpm typecheck`. Nu s-a rulat nimic pe producție.

Clasificare: **CRITICAL** (blochează producția sau expune date), **HIGH** (risc real, de rezolvat în această iterație), **MEDIUM** (datorie cu efect vizibil), **LOW** (igienă).

## 1. Arhitectura actuală

| Strat | Ce există |
|---|---|
| Aplicație | Monolit Next.js 16.4 (App Router, React 19, TypeScript 6 strict, Tailwind 4), server Node 24 `standalone` într-un container non-root. 130 de rute `route.ts` sub `/api/v1`, 43 de pagini autentificate, site public `saas`. |
| Date | PostgreSQL 17 (Supabase pe producție), schema `finet`, Drizzle ORM 0.45 + `postgres` 3.4; **26 de migrații** SQL (`src/db/migrations/0000`–`0026`), toate aplicate pe producție. RLS `ENABLE` + `FORCE` pe toate tabelele, politici pe gospodărie/utilizator, roluri separate `finet_app` (NOBYPASSRLS), `finet_migrator`, `finet_backup`. Bani în `bigint` (unități minore), niciodată float. |
| Autentificare | Better Auth 1.7 (Argon2id, sesiuni în bază, `bearer` pentru Android, magic link/resetare prin SMTP, Google doar pentru conturi existente, Turnstile la înregistrarea `saas`). Rate limiting în bază, CSRF prin `Origin`, `Idempotency-Key` pe scrieri. |
| Autorizare | Două straturi: `withMember` (apartenența verificată în aceeași tranzacție) + RLS. `householdId` niciodată din body. Entitlements pe plan în `saas` (ADR 0035), fail-closed. |
| Worker | pg-boss 12 (`FINET_ROLE=worker`): recurențe orare, bonuri (sharp + pdf.js în proces copil sub `prlimit`), extrase, liste de cumpărături; semnal de viață în `service_heartbeats`. |
| AI | Client LiteLLM (compatibil OpenAI) cu listă de hosturi permise, buget lunar global în bigint (`ai_budget_reserve`), consimțământ explicit `external_ai`/`external_ai_ask`; folosit pentru bonuri, potrivirea listelor și „Întreabă FINET” (ADR 0026). |
| Frontend | Componente proprii (fără shadcn runtime), grafice SVG pe server, CSP cu nonce, fără `style=`, buget First Load JS ≤ 200 KiB verificat în CI. PWA cu service worker și scanare offline. |
| Android | Flutter 3.47 în `mobile/` (78 fișiere Dart, 30 de teste), Riverpod, Dio, go_router; `minSdk` 29, AGP 9.1, Gradle 9.3; release 1.0.2 semnat, publicat pe GitHub Releases, verificat de operator pe telefon. |
| Infra | Docker Compose pe VPS (`finet-web`, `finet-worker`, `finet-migrate`, `finet-backup`), imagini construite DOAR în CI (`images.yml`), Cloudflare Tunnel + Access, backup restic → Google Drive (cron 05:10), restaurare testată în CI și pe producție. Installer wizard (ADR 0044). |
| CI | `ci.yml` (lint, format, OpenAPI, typecheck, migrații de două ori, 1.576 teste Vitest, build, scanare secrete client, buget JS, audit non-blocant), job `backup-restore`, job `e2e` (Playwright, 121 de teste în 18 proiecte, ambele moduri), `pg-next` (PostgreSQL 18), `android.yml`, `android-release.yml`, auto-merge Dependabot pentru patch-uri. |
| Documentație | 44 ADR-uri, rapoarte pe faze, `API.md` + `openapi.json` generat și verificat în CI, `SECURITY_CHECKLIST` cu 41 de secțiuni, `INFRA`, `BACKUP`, `INSTALL`, `PERFORMANCE`, master prompt-uri web și Android. |

Verificat local (container Node 24, `pnpm install --frozen-lockfile`): `pnpm audit --prod` → 0 vulnerabilități cunoscute; `pnpm typecheck` → trece.

## 2. Funcții existente față de cerințele master prompt-ului de modernizare

| Cerință | Stare | Unde |
|---|---|---|
| Registru (conturi, categorii, tranzacții, transferuri) | **există** | `src/modules/{accounts,categories,transactions,transfers}` |
| Bugete cu semafor, obiective de economisire cu contribuții | **există** | `budgets`, `goals` (ADR 0007) |
| Recurențe (reguli, generare, pauză) + detectarea plăților recurente din istoric | **există** | `recurring`, `suggestions.ts` (ADR 0011, 0019) |
| Bonuri cu AI, extrase bancare (BT, BRD, Raiffeisen, Revolut, CSV/XLSX), potrivire | **există** | Fazele 6–7 |
| Familie (invitații, împărțiri, decontări, conturi personale/comune) | **există** | Faza 8 |
| Rapoarte lunare, dashboard, export CSV/Excel/PDF, export contabil | **există** | Fazele 3, 10 |
| Rezumatul lunii (determinist) + „Întreabă FINET” (set închis + LLM opțional) | **există** | `summary`, `ask` (ADR 0025–0026) |
| PWA/offline, GDPR export/ștergere, statistici | **există** | Faza 9 |
| SaaS: site, admin, înregistrare, planuri, entitlements, recomandări | **există în cod** | Fazele 11–12 |
| **AI Financial Advisor** (tranzacții neobișnuite, tipare, sugestii de economisire, explicații) | **lipsește** (doar rezumat + întrebări închise) | — |
| **Prognoză cash-flow 30/60/90 zile** cu încredere | **lipsește** | — |
| **Scor de sănătate financiară** explicabil | **lipsește** | — |
| **Avere netă** (active/pasive: investiții, proprietăți, vehicule, credite) | **lipsește**: `accounts.type ∈ {cash, bank, savings, credit_card}`; fără istoric al averii | `src/db/schema/ledger.ts` |
| **Plan de economisire** (zilnic/lunar, fond de urgență) | **parțial**: obiective cu termen, fără plan calculat | `goals` |
| **Manager de abonamente** (cost lunar/anual, reînnoiri, categorii) | **parțial**: regulile recurente sunt abonamente implicite, fără vedere dedicată | `recurring` |
| **Monede** | **parțial**: RON/EUR/USD per cont, fără HUF/GBP, **fără curs valutar și fără conversie** (totaluri separate pe monedă) | `money.ts`, `households.ts` |
| **Limbi în aplicație** | **parțial**: aplicația doar în română (`ro.ts`, 2.325 de linii, importat static în ~130 de fișiere); paginile publice în en/es/fr/de/it/pl/tr | `src/messages` |
| **Notificări** (plăți viitoare, buget, anomalii, obiective, reînnoiri, rezumat lunar) | **lipsește**: doar alerte operator (Telegram/email în `ops/notify`) și SSE live pentru familie | — |
| **Open Banking (PSD2)** | **lipsește** (import doar din fișiere) | — |
| Observabilitate | **parțial**: `/api/health` (db, storage, queue), heartbeat worker, loguri JSON în worker fără date financiare; fără metrici, fără error tracking | `src/lib/access.ts`, `src/worker` |

## 3. Datorie tehnică

| Nivel | Constatare | Detalii |
|---|---|---|
| HIGH | **Acțiunile GitHub nu sunt pinuite pe SHA** în `ci.yml`, `images.yml`, `android.yml`, `pg-next.yml`, `claude-faza.yml` (doar `android-release.yml` și `dependabot-auto-merge.yml` sunt). Deschis din Faza 0 (F6). | `.github/workflows/*.yml` |
| HIGH | **`pnpm audit --prod` e non-blocant** (`continue-on-error: true`). Azi lista e curată, deci poate deveni blocant fără cost. | `ci.yml` |
| HIGH | **Fără CodeQL, fără scanare de secrete în istoric (gitleaks), fără scanare a imaginilor Docker** (Trivy). Scanerul propriu acoperă doar `.next/static`. | `.github/workflows` |
| MEDIUM | **Imaginea de bază nu e fixată pe digest** (`node:24.22.1-bookworm-slim` fără `@sha256`); `packageManager` fără hash. | `Dockerfile`, `package.json` |
| MEDIUM | `ARCHITECTURE.md` descrie „ce există după Fazele 1–6 și F8-A” și `README.md` spune „Faza 2 parțial închisă”: documentația de intrare e cu ~8 faze în urmă față de cod (ROADMAP și ADR-urile sunt la zi). | `docs/ARCHITECTURE.md`, `README.md` |
| MEDIUM | **Logurile nu sunt structurate uniform**: workerul scrie JSON (`log()`), serverul web `console.error` cu text liber în 17 fișiere; fără nivel, fără id de cerere. | `src/app`, `src/lib` |
| MEDIUM | `src/messages/ro.ts` e un singur fișier de 2.325 de linii, importat static peste tot: orice internaționalizare a aplicației cere întâi un strat de indirecție. | `src/messages/ro.ts` |
| MEDIUM | `finet:tools` are 606 MB (include `next` în `node_modules` de producție); TODO din Faza 1 nerezolvat. | `Dockerfile` (`prod-deps`) |
| LOW | `ops/postgres/VERSION` = 17; `pg-next` validează 18; Dependabot propune `postgres:18-alpine` în devcontainer (PR #66) înaintea deciziei pe Supabase. | `.devcontainer` |
| LOW | Căutarea `q` cu `ILIKE '%…%'` rămâne `Seq Scan` (0,1 s la 50.000 de rânduri); `pg_trgm` amânat. | `transactions.repo.ts` |
| LOW | Exportul CSV complet ~4,5 s la 50.000 de rânduri (dominat de aplicație). | `exports` |

## 4. Sănătatea dependențelor (`pnpm outdated`, 2026-11-07)

| Pachet | Curent | Ultim | Tip | Evaluare |
|---|---|---|---|---|
| `postgres` | 3.4.9 | 4.1.0 | **major** | Driverul bazei (14 importuri). PR Dependabot #73. Cere revizuirea release notes și rularea suitei de integrare (vezi `DEPENDENCY_MODERNIZATION.md`). |
| `unpdf` | 1.9.1 | 2.1.0 | **major** | Folosit în două procese copil (`pdf-child.mjs`, `pdf-items-child.mjs`) și teste. PR #69. API-ul (`getDocumentProxy`, `extractText`, `extractImages`) trebuie reverificat. |
| `nodemailer` | 10.2.1 | 10.3.1 | minor | PR #74. Un singur loc de folosire (`mailer.ts`). |
| `better-auth` | 1.7.13 | 1.7.18 | patch | PR #72 (1.7.14). Exclus din auto-merge intenționat; de verificat L6 (`storeToken: "hashed"` la resetare). |
| `jose` | 6.2.13 | 6.2.15 | patch | PR #70. |
| `pg-boss` | 12.38.0 | 12.38.1 | patch | Schema `pgboss` e creată de operator (ADR 0011): un patch nu o schimbă. |
| `next`, `eslint-config-next` | 16.4.3 | 16.4.5 | patch | Sigur. |
| `tailwindcss`, `@tailwindcss/postcss`, `vite` | — | patch | sigur |
| `vitest`, `@vitest/coverage-v8` | 5.0.5 | 5.1.0 | minor | dev. |
| `@playwright/test` | 1.64.1 | 1.65.0 | minor | dev; cere reinstalarea Chromium în CI (automat). |
| `eslint` | 9.39.5 | 10.14.0 | **major** | dev; `eslint-config-next` 16.4 cere ESLint 9. **Nu se face acum.** |
| `typescript` | 6.0.3 | 7.0.2 | **major** | dev; TS 7 (Go) încă nu e suportat de `next build`. **Nu se face acum.** |
| `@types/node` | 24.19.2 | 26.6.6 | major | Runtime-ul e Node 24 (`.nvmrc`, `engines`): rămâne pe 24 (decizia din 2026-10-31). |
| Acțiuni GitHub | `upload-artifact@5`, `setup-buildx-action@3`, `build-push-action@6`, `fetch-metadata@2.5.0` | 7 / 4 / 7 / 3.1.0 | major | PR #65, #67, #68, #79. Majoritatea sunt schimbări de runtime Node 24 pe runner; sigure după citirea notelor. |
| Docker | `node:24.22.1-bookworm-slim` | — | — | La zi; de fixat pe digest. |
| Flutter | 3.47.9, Dart 3.13, AGP 9.1.0, Kotlin 2.4.0, Gradle 9.3.1 | — | — | La zi (noiembrie 2026). |

`pnpm audit --prod`: **0 vulnerabilități**.

## 5. Riscuri de securitate

Controalele existente sunt solide (vezi §1 și `SECURITY_CHECKLIST.md`). Ce rămâne:

| Nivel | Constatare |
|---|---|
| HIGH | Lanțul de aprovizionare CI (acțiuni pe tag, fără CodeQL/gitleaks/Trivy, audit non-blocant) — §3. `claude-faza.yml` are `contents: write` + `id-token: write` și rulează pe comentarii `@claude`: expunere mare, de restrâns la `pull_request`/etichetă și de pinuit. |
| MEDIUM | **L6**: tokenul de resetare a parolei e stocat în clar de Better Auth (30 min, unică folosință). De re-verificat la fiecare actualizare Better Auth. |
| MEDIUM | **L8**: `viaBearer` scutește de CSRF și când cererea are și cookie. De restrâns: bearer ⇒ fără cookie de sesiune acceptat. |
| MEDIUM | **LOW-4 (din F2)**: fără plafoane per gospodărie (număr de conturi, categorii, tranzacții, reguli) în `personal`; în `saas` există doar pe plan. Un client compromis poate umple baza. |
| MEDIUM | Jurnalele LiteLLM pot păstra corpurile cererilor cheii `finet` (date din bonuri): setare pe LiteLLM, nu în repo; de documentat în `PRIVACY_NOTES`. |
| LOW | L1–L5 din §41 (recomandări), L7 (parola CLI pe stdout), N1 (curățarea `auth_rate_limits` fără index), HSTS `preload` oprit (decizie). |
| LOW | `plans` vizibil oricărui utilizator autentificat (inclusiv planul intern `founder`). |

**Nu s-au găsit** căi de scurgere între gospodării/tenanți: fiecare scriere trece prin `handle()`/`handleAlways()` (inventariat în §41), RLS e `FORCE` pe toate tabelele, funcțiile `SECURITY DEFINER` au `search_path = pg_catalog` și întorc doar id-uri.

## 6. Performanță

- Măsurători reale există (`docs/PERFORMANCE.md`): lista de tranzacții 16 ms la 50.000 de rânduri după `0005_perf_indexes`, dashboard ~120 ms, export CSV 4,6 s.
- Riscuri: agregările pe 12 luni citesc toată gospodăria (acceptabil sub 100.000 de rânduri); orice funcție nouă care face agregări pe istoric (prognoză, scor, avere netă) trebuie să refolosească `selectMonthlyTotals` și indexurile existente, nu să adauge interogări pe rând.
- First Load JS: 169–192 KiB pe rutele autentificate, prag 200 KiB. Paginile noi trebuie să rămână server components cu SVG propriu (fără bibliotecă de grafice).
- Worker: ~86 MB RSS, limita 150 MB; PDF în proces copil sub `prlimit`.
- Android: pornire neverificată cu profiler; fără date de referință.

## 7. Riscuri în baza de date

| Nivel | Constatare |
|---|---|
| HIGH | **`ACCOUNT_TYPES` e închis prin CHECK** (`cash, bank, savings, credit_card`) și `goals_currency_valid`/`households_currency_valid`/… repetă lista de monede literal în ~10 CHECK-uri. Orice monedă sau tip de cont nou cere o migrație care rescrie CHECK-urile; o migrație greșită blochează scrierile. Soluție: migrație aditivă cu `DROP CONSTRAINT` + `ADD CONSTRAINT` explicite, testată în CI (migrații de două ori + restaurare). |
| MEDIUM | Migrațiile aplicate sunt imutabile; `drizzle-kit generate` a numerotat greșit o dată (0024 vs 0025). Regula: numerotarea și jurnalul se verifică manual. |
| MEDIUM | Fără partiționare/arhivare pentru `transactions`, `app_events` (agregate la 13 luni), `ai_calls`, `audit_events`. Suficient pentru `personal`; pentru `saas` la scară cere plan. |
| LOW | `transactions_household_occurred_idx` redundant parțial cu `0005` (ștergerea e amânată, cere aprobare). |
| LOW | pg-boss cere schema `pgboss` creată de operator; un upgrade major pg-boss cere `ops/supabase/pgboss-schema.sql` regenerat. |

## 8. Android

- Codul e la zi (Flutter 3.47.9, AGP 9.1, `minSdk` 29), release semnat și verificat pe telefon (1.0.2). Arhitectură curată (features/core), clientul nu calculează sume, `Idempotency-Key` pe POST, `FLAG_SECURE`, blocare biometrică, verificarea actualizărilor.
- Lipsesc: notificări push (nu există canal în backend), widget pe ecranul de pornire, sincronizare în fundal (`WorkManager`), coadă offline pentru tranzacții (există doar pentru scanări), `integration_test` pe emulator, măsurarea timpului de pornire.
- Build-ul se face doar în CI (hostul nu are RAM pentru Gradle); orice schimbare Android se verifică prin `android.yml`.

## 9. Pregătirea pentru producție

| Criteriu | Stare |
|---|---|
| Producție `personal` | rulează pe `d3c1fb8` (web/worker), 26 migrații, backup zilnic + restaurare de probă făcută, Cloudflare Access, healthcheck, 0 restarturi. |
| Mod `saas` | complet în cod, **neactivat**; cere valori de plan, chei Turnstile/Google, texte juridice, furnizor de plată (operatorul nu folosește Stripe). |
| Observabilitate | health + heartbeat; fără metrici/error tracking; alerte doar pentru backup. |
| Operare | installer wizard netestat pe server gol; `cleanup-idempotency` neinstalat în cron. |

## 10. Recomandări prioritizate

| # | Nivel | Acțiune | Efort |
|---|---|---|---|
| 1 | HIGH | CI: pinuire pe SHA a tuturor acțiunilor; `pnpm audit --prod` blocant de la HIGH; CodeQL (JS/TS); gitleaks pe PR + istoric; Trivy pe imaginea `web`; `claude-faza.yml` cu drepturi minime. | mic |
| 2 | HIGH | Dependențe: merge `nodemailer`, `jose`, `better-auth` (după verificarea L6), acțiunile GitHub (#65, #67, #68, #79); `postgres` 4 și `unpdf` 2 doar după teste de integrare (document separat). | mic-mediu |
| 3 | HIGH | `Dockerfile`: imagine de bază pe digest; `packageManager` cu hash. | mic |
| 4 | MEDIUM | Securitate: L8 (bearer + cookie), plafoane per gospodărie în `personal`, test de regresie pentru izolarea între gospodării pe fiecare modul nou. | mic |
| 5 | **Funcții P2** | Scor de sănătate financiară, prognoză cash-flow 30/60/90, analiza deterministă a tranzacțiilor neobișnuite + tipare („consilier” explicabil, cu LLM opțional în spatele consimțământului existent). Toate ca funcții pure peste agregatele existente, fără migrație. | mediu |
| 6 | **Funcții P3** | Avere netă (tipuri noi de cont + `net_worth_snapshots` lunar din worker), planul de economisire pe obiectiv, managerul de abonamente peste recurențe. | mediu |
| 7 | **Funcții P4** | Notificări în aplicație (tabelă + job de evaluare + preferințe), apoi email; curs valutar istoric (tabelă + job ECB) și conversie în moneda de bază doar pentru afișare; HUF/GBP; interfață de furnizor Open Banking (fără implementare de furnizor plătit). | mediu-mare |
| 8 | MEDIUM | Documentație: `ARCHITECTURE.md` și `README.md` aliniate la cod. | mic |
| 9 | LOW | Loguri structurate în serverul web, `finet:tools` mai mic, `pg_trgm` dacă e disponibil pe Supabase. | mic |

Ordinea de execuție și dependențele sunt în `docs/roadmap/FINET_MODERNIZATION_PLAN.md`.
