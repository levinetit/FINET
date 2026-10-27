# Raportul Fazei 1 — Autentificare, profil, gospodărie

- **Branch:** `phase/01-auth` (din `main` la `56d1309`), PR #16 draft, fără push din partea agentului.
- **Data:** 2026-10-28.
- **Stare:** **parțial**. Codul Fazei 1 e complet în repo (F1-A, F1-B, F1-C). Închiderea cere încă: migrațiile pe Supabase (operatorul), prima rulare a job-ului `e2e` pe GitHub și revizuirea de securitate.
- Deciziile și abaterile sunt în [ADR 0003](../adr/0003-auth.md). Starea securității: [`docs/SECURITY_CHECKLIST.md`](../SECURITY_CHECKLIST.md).

## 1. Ce s-a implementat și ce a rămas

**F1-A — stratul de date:** schema Drizzle `finet` (`users`, `auth_*`, `households`, `household_members`, `user_preferences`, `consents`, `audit_events`), migrațiile `0000_core` și `0001_rls` (RLS `ENABLE` + `FORCE`, `finet.create_household` atomic), contextul RLS per tranzacție, `requireMember`/`withMember`, runner-ul de migrații propriu (imaginea `finet:tools`, serviciul `finet-migrate`).

**F1-B — autentificarea server-side:** Better Auth 1.7.13 (Argon2id prin `crypto.argon2` din Node, sesiuni în bază fără cookie cache, `bearer` semnat pentru Android, magic link și resetare doar cu SMTP), rate limiting în `auth_rate_limits` (login web, login mobil, emailuri, resetare, schimbarea parolei), `/api/v1/me`, `/me/sessions`, `/me/sessions/{id}`, `/me/sessions/revoke-others`, `/me/password`, CSRF prin `Origin`, gospodăria personală automată, CLI-ul admin (`create-user`, `reset-password`, `add-member`).

**F1-C — interfața, antetele, E2E, documentația:**
- antetele de securitate (6.3) pe toate răspunsurile `src/proxy.ts` (și pe 403): CSP cu nonce per cerere, fără `unsafe-*` și fără `strict-dynamic` în producție; HSTS un an cu `includeSubDomains`, fără `preload`; `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`; CORS închis. Asset-urile statice primesc antetele fixe din `next.config.ts`. Verificarea Access rămâne prima și neschimbată;
- paginile `/` (redirecționare), `/login` (email + parolă; magic link doar cu SMTP, flag calculat pe server), `/dashboard` (placeholder onest, gospodăria și rolul), `/profile` (nume, temă, limbă, fus orar, monedă; schimbarea parolei; sesiunile, cu revocare individuală și „Deconectează celelalte”, cu confirmare), logout prin `POST /api/auth/sign-out`, `/register` (404 în `personal`; în `saas`, un mesaj că înregistrarea vine în Faza 11), pagini 404 și de eroare proprii;
- `?next=` validat (doar cale relativă internă), redirecționări HTTP 307 pentru rutele protejate;
- mutațiile din browser folosesc aceleași rute ca Android (rate limiting, CSRF, audit într-un singur loc); formularele trimit doar după hidratare;
- tokenii `surface-2`, `accent-soft`, `*-soft` și maparea numelor shadcn; componentele UI scrise de mână, fără dependențe noi; textele în `src/messages/ro.ts`;
- E2E Playwright: proiectul `auth` (12 scenarii, rulate în ambele moduri), header-ele de producție în `access`, job-ul `e2e` în CI;
- `docs/SECURITY_CHECKLIST.md`, acest raport și actualizarea documentației.

**Parțial sau neimplementat:**
- E2E în browser (`smoke`, `auth`): **NOT RUN** local. Browserele nu se instalează pe hostul agentului (memorie mică). Prima rulare e în job-ul `e2e`, după push.
- Migrațiile pe Supabase, primul utilizator în producție, verificarea prin Access în browser: operatorul (`docs/INFRA.md`, secțiunea 4b).
- Revizuirea de securitate a F1-B + F1-C: neefectuată.
- Înregistrarea publică `saas` cu verificarea emailului: Faza 11. Sign-up rămâne închis în ambele moduri.
- OpenAPI pentru `/api/v1`: odată cu Faza 2.
- Micșorarea imaginii `finet:tools`: TODO în ROADMAP (cere un build Docker).
- Tema pe un dispozitiv nou se aplică după prima salvare din profil (cookie, nu bază).

## 2. Fișiere create sau modificate

**F1-C** (commit-uri `1b3b72a`, `6da22f2`, `794d70b`, `b0fe32a`, `6532ae1`, `5420946` și commit-ul de documentație):
- Antete: `src/lib/security-headers.ts` (nou), `src/lib/security-headers.test.ts` (nou), `src/proxy.ts`, `src/proxy.test.ts`, `next.config.ts`.
- Tokeni și componente: `src/app/globals.css`, `src/app/_components/logo.tsx`, `src/components/ui/{button,input,label,card,alert}.tsx`, `src/components/app/{app-nav,icons}.tsx`.
- Pagini: `src/app/{layout,page,not-found,error}.tsx`, `src/app/login/{page,login-form}.tsx`, `src/app/register/page.tsx`, `src/app/(app)/{layout,page-header}.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/profile/{page,profile-form,password-form,sessions-list}.tsx`, `src/app/_lib/{session,next-path,next-path.test,api-client,theme,use-hydrated}.ts`, `src/messages/ro.ts`.
- E2E și CI: `e2e/{auth.spec,fixtures}.ts` (noi), `e2e/{smoke,access}.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`.
- Documentație: `docs/SECURITY_CHECKLIST.md` (nou), `docs/reports/faza-1.md` (nou), `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `docs/adr/0003-auth.md`, `CLAUDE.md`, `README.md`.

`src/lib/security-headers.ts` e în afara fișierelor listate pentru F1-C (decizia mea): ține regulile antetelor într-un modul pur, folosit și de `src/proxy.ts`, și de `next.config.ts`. `package.json` și lockfile-ul nu s-au schimbat.

**F1-A și F1-B:** vezi commit-urile `aaf2e8c`..`3ffd287` și ADR 0003.

## 3. Verificări rulate și rezultate

Mediu: container `node:24` (uid 1009, `--memory=2g`), pnpm 12.15.0 prin corepack, PostgreSQL 17 efemer (`postgres:17-alpine`, `--memory=256m`) pe rețeaua privată `finet-ci-net`, cu rolurile din `ops/postgres/test-bootstrap.sql`. Rulate la 2026-10-28 pe HEAD-ul F1-C (codul final; commit-ul de documentație nu schimbă cod).

| Comandă | Rezultat |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm lint` | PASS (0 avertismente) |
| `pnpm format:check` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` (cu `DATABASE_URL` spre Postgres-ul efemer) | PASS: 22 fișiere, **417 trecute, 5 sărite (422)**; înainte de F1-C: 375 + 5 (380) |
| `pnpm build` | PASS; toate rutele dinamice (`ƒ`), inclusiv `/_not-found` |
| `pnpm scan:client-secrets` | PASS (scanare curată, 9 tipare, 9 nume) |
| `pnpm test:ops` | PASS |
| `pnpm exec playwright test --list` | PASS: 25 de teste în 3 fișiere (`smoke` 1, `auth` 12, listate pentru modul curent, `access` 12) |
| `E2E_SERVER=prod pnpm test:e2e --project=access` (serverul standalone, doar HTTP) | PASS: **12/12**, inclusiv antetele de producție pe 403 și pe liveness, nonce diferit pe cereri, CORS închis |
| `pnpm test:e2e --project=smoke --project=auth` (browser) | **NOT RUN** (fără browsere pe host); rulează în job-ul `e2e` |

Cele 5 teste sărite sunt cele din `src/lib/db-client.test.ts` care cer un CA real (neschimbate față de F1-B).

**Verificări manuale pe serverul standalone** (`node .next/standalone/server.js`, producție, Access obligatoriu, fetch cu `redirect: manual`):
- `GET /login` → 403 cu `content-security-policy` (nonce, fără `unsafe-*`), `strict-transport-security: max-age=31536000; includeSubDomains`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy`, `permissions-policy`, `cache-control: no-store`;
- `GET /api/health/live` (loopback) → 200 cu aceleași antete; `POST /api/auth/sign-in/email` fără JWT → 403 cu antete;
- `/_next/static/chunks/*.js` → antetele fixe, fără CSP.

**Verificări funcționale pe `next dev`** (Postgres efemer migrat, utilizator creat cu CLI-ul admin, Access dezactivat doar acolo; HTTP cu `fetch`, fără browser):
- `/` → 307 `/login`; `/dashboard` fără sesiune → 307 `/login?next=%2Fdashboard`; `/register` → 404 (`personal`), 200 cu mesajul (`saas`);
- `/login`: 21 de `<script>`, **toate** cu nonce-ul din antet; 0 atribute `style=`; label-urile prezente; butonul de magic link absent fără SMTP;
- parolă greșită → 401 uniform; login cu emailul în altă formă (` DEV@finet.test `) → 200 și cookie; `/login?next=//evil.com` cu sesiune → 307 `/dashboard`;
- `/dashboard` → 200 cu placeholderul, „Gospodăria mea” și „Proprietar”; `/profile` → 200 cu sesiunea curentă; `PATCH /api/v1/me` → 200; logout → 200, cookie șters; `/dashboard` după logout → 307 spre login;
- 6 încercări pe un email inexistent → `401 ×5, 429` cu `Retry-After: 899`; o pagină inexistentă → 404, fără `style=`.

## 4. Pornire și deploy
- Local: `README.md` („Rulare locală”, varianta cu autentificare).
- E2E: `CLAUDE.md` și comentariul din `e2e/fixtures.ts` (utilizatorii se creează cu CLI-ul admin, parola din stdin).
- Producție: `docs/INFRA.md`, secțiunea 4b (backup, secretul Better Auth, `finet.admin.env`, migrațiile de două ori, primul utilizator, redeploy-ul `finet-web`, verificarea antetelor, rollback). Agentul nu a atins producția.

## 5. Variabile de mediu noi (nume și scop)
- F1-C nu adaugă variabile pentru aplicație.
- Doar pentru E2E: `E2E_APP_MODE` (modul serverului de test), `E2E_PASSWORD` (parola utilizatorilor de test din baza temporară), `E2E_DEV_PORT`/`E2E_PROD_PORT`/`E2E_SERVER`/`E2E_BASE_URL` (existente).
- F1-B: `BETTER_AUTH_SECRET` (`_FILE`), `AUTH_HIBP_ENABLED`, `AUTH_*_MAX_ATTEMPTS`/`AUTH_*_WINDOW_SECONDS`, `FINET_ROLE=admin`.

## 6. Riscuri, limitări, ADR-uri, securitate
- **E2E nerulate în browser.** Scenariile sunt scrise cu selectori după rol și label și validate cu `tsc`, lint și `--list`. Fluxurile echivalente au fost verificate prin HTTP pe `next dev`. Riscuri de iterat pe CI: timpii primei compilări în `next dev` (timeout 90 s), mesajele exacte, curățenia sesiunilor rămase între rulări.
- **Dezvoltare vs. producție la CSP:** E2E-ul din browser rulează pe `next dev` (CSP cu `unsafe-eval`/`unsafe-inline` pe stiluri). CSP-ul strict de producție e verificat doar prin HTTP pe serverul standalone, nu în browser. Un script sau un stil inline fără nonce în producție s-ar vedea abia la verificarea manuală prin Access. Recomandare: o verificare în browser pe producție după deploy.
- **`style-src` fără `unsafe-inline`:** orice atribut `style="…"` randat pe server va fi blocat în producție. Regula e în ADR 0003 și în `CLAUDE.md`.
- **Rate limiting fără IP de încredere în dezvoltare:** contorul e pe email (cunoscut din F1-B).
- **Tema** se aplică pe un dispozitiv nou abia după o salvare în profil.
- `global-error` implicit (stiluri inline) rămâne pentru Faza 9.
- ADR: 0003 completat cu „UI și antete (F1-C)”.
- Constatări de securitate rămase (F6, N2–N5, arhiva `/home/docker`): `docs/SECURITY_CHECKLIST.md` și `docs/ROADMAP.md`.
- `playwright.config.ts`: serverul de producție al proiectului `access` primea un mediu fără `BETTER_AUTH_SECRET`/`APP_URL` https. Din F1-B, rolul `web` de producție le cere și s-ar fi oprit la pornire. Corectat cu valori fictive.

## 7. Pașii următori, prioritizați
1. Push-ul și prima rulare a job-ului `e2e` (ambele moduri), cu iterarea scenariilor după rezultate.
2. Revizuirea de securitate a Fazei 1 (F1-B + F1-C) și actualizarea listei.
3. Operatorul: secțiunea 4b din `docs/INFRA.md` (migrații pe Supabase, primul utilizator, redeploy, verificarea în browser prin Access, inclusiv consola fără încălcări CSP).
4. Faza 2, cu OpenAPI generat pentru `/api/v1`.
5. Micșorarea imaginii `finet:tools` și punctele F6 (SHA-uri pentru acțiuni, digest pentru imagine, audit blocant, gitleaks).
