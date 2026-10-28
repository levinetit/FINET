# FINET — roadmap

Starea fazelor din `docs/FINET_MASTER_PROMPT.md` (secțiunea 7) și `docs/FINET_ANDROID_MASTER_PROMPT.md` (secțiunea 8). Stări: **complet**, **parțial**, **neimplementat**.

## Web

| Fază | Stare | Note |
|---|---|---|
| 0 — Fundație și infrastructură | **parțial** | vezi mai jos și `docs/reports/faza-0.md` |
| 1 — Autentificare, profil, gospodărie | **parțial** (implementat în repo) | F1-A, F1-B, F1-C gata; rămân migrațiile pe Supabase, prima rulare E2E în CI și revizuirea de securitate — vezi mai jos și `docs/reports/faza-1.md` |
| 2 — Conturi, categorii, tranzacții, transferuri | neimplementat | |
| 3 — Dashboard, bugete, obiective, rapoarte, export, backup | neimplementat | |
| 4 — Stabilizare (rezervată) | neimplementat | |
| 5 — Recurențe | neimplementat | |
| 6 — Ingestia bonurilor | neimplementat | |
| 7 — Extrase bancare, potrivire, abonamente | neimplementat | |
| 8 — Familie | neimplementat | |
| 9 — Hardening, PWA, offline | neimplementat | |
| 10 — Liste de cumpărături și prețuri | neimplementat | |
| 11 — Fundația SaaS | neimplementat | |
| 12 — Planuri, plăți, recomandări | neimplementat | |

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
- OpenAPI (`docs/openapi.json`) pentru `/api/v1`: odată cu primele endpointuri din Faza 2;
- **TODO:** micșorarea imaginii `finet:tools` (583 MB, include `next`): de exemplu `pnpm deploy --prod` cu doar `postgres`/`drizzle-orm`/`zod` (dependențele externe ale `dist/tools/*.mjs`). Neîncercat: cere un build Docker, nepermis pe hostul cu memorie mică.

### Constatări amânate din revizuirea de securitate a Fazei 1 (2026-10-28)
Corectate: H1, M1–M5, L1, L4, L5 (`docs/SECURITY_CHECKLIST.md`, secțiunea 9; ADR 0003). Amânate, cu motivul:
- **L2** — `audit_events` dispar în CASCADE la ștergerea unei gospodării: aplicația nu șterge încă gospodării; se decide odată cu ștergerea (păstrare anonimizată sau `SET NULL`).
- **L3** — protecția „ultimului owner” (nu poate pleca / nu poate fi scos): odată cu gestiunea membrilor din Faza 8.
- **L6** — tokenul de resetare a parolei e stocat în clar (Better Auth nu are `storeToken: "hashed"` pentru resetare): de revăzut la actualizarea Better Auth; azi 30 de minute, unică folosință.
- **L7** — parola generată de CLI apare pe stdout (o singură dată): de decis cu operatorul (fișier 0600 sau doar `--password-stdin`).
- **L8** — `viaBearer` scutește de CSRF și când cererea are și cookie: de restrâns la prima revizuire a clientului Android.
- **Ștergerea contului (GDPR)**: fază viitoare, printr-o funcție SECURITY DEFINER care refuză administratorii și gospodăriile cu un singur membru; `finet_app` nu are `DELETE` pe `users` (M5).
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
- **F8 (rest) — antetele de securitate: închis în F1-C** (CSP cu nonce, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`; `docs/SECURITY_CHECKLIST.md`). Rămân pentru Faza 9: `preload` la HSTS (decizia operatorului), pagina `global-error` proprie.
- **F9 — storage local (Faza 6, odată cu ingestia):** curățarea fișierelor temporare orfane `*.tmp-*` rămase după o scriere întreruptă; limită de dimensiune la `put` (pe lângă cota totală).
- **F2 (rest) / N1 — secretele în data-root-ul Docker: închis tehnic în T7.**
  - Ce s-a făcut: URL-urile bazei și `HEALTH_TOKEN` intră în containere ca fișiere (`secrets:` → `/run/secrets/`, citite prin `*_FILE`, `src/lib/secret-files.ts`), deci nu mai ajung în `config.v2.json`.
  - Fișierele exemplu de mediu nu mai conțin secrete, iar `pnpm test:ops` verifică asta.
  - Ce rămâne: arhiva săptămânală necriptată a `/home/docker` (existentă și viitoare) conține în continuare **mediul ALTOR containere** de pe host. E un risc preexistent, în afara FINET, iar decizia (excludere/criptare) e a operatorului.
  - Logurile `json-file` rămân în arhivă; aplicația nu scrie secrete în ele.
  - Backup-ul propriu criptat al FINET vine în Faza 3 (restic).
- **F7 (rest) — CA-ul Supabase din cod: închis în T7.**
  - `DATABASE_CA_FILE` + `src/lib/db-client.ts` → `ssl: { ca, rejectUnauthorized: true }` cu `sslmode=verify-full`/`verify-ca`.
  - CA fără sslmode de verificare sau `sslrootcert` în URL → oprire la pornire.
  - `NODE_EXTRA_CA_CERTS` rămâne doar ca variantă de rezervă.
  - Clientul Drizzle din Faza 1 trebuie construit cu `postgresOptions()` din `src/lib/db-client.ts`.
- **Workerul și migrarea reale:** `finet-worker` (Faza 5/6) și `finet-migrate` (Faza 1) sunt stub-uri; când primesc cod, își citesc configurația cu `FINET_ROLE` corespunzător (`parseConfig` e deja pregătit).
- **Constatări minore din re-verificarea de securitate (după T5):**
  - N2: stub-urile `finet-worker`/`finet-migrate` nu apelează `parseConfig`, deci regula pe rol se aplică efectiv doar la `web`; test viitor: `FINET_ROLE=worker` + `DATABASE_URL` setat → ieșire cu cod 1.
  - N3: scanerul (`scripts/scan-client-secrets.mjs`) acceptă id de bot Telegram de 8–10 cifre; extinde la `\d{8,12}` și documentează excepția pentru JWT-ul Supabase `anon` (public prin design).
  - N4: pe Supabase (PG16+), `roles.sql` poate cere `grant finet_migrator to current_user;` înainte de `create schema ... authorization`; de verificat pe un proiect real (scriptul se oprește în siguranță la eroare).
  - N5: `notify.sh` scrie antetul `From:` din `SMTP_FROM` întreg; construiește-l din adresa validată plus un nume curățat și refuză virgula.

## Android (`docs/FINET_ANDROID_MASTER_PROMPT.md`)

| Fază | Stare | Depinde de (web) |
|---|---|---|
| A — Fundație (Flutter în `mobile/`, temă, navigare, client Dio, date simulate, CI) | neimplementat | — |
| B — Autentificare și profil | neimplementat (API-ul web există din F1-B: login `bearer`, `/api/v1/me`, sesiuni) | Faza 1 + API `/api/v1/` |
| C — Funcții de bază (dashboard, tranzacții, bugete) | neimplementat | Fazele 2–3 |
| D — Recurențe și documente (bonuri, extrase, partajare) | neimplementat | Fazele 5–7 |
| E — Stabilizare și livrare (APK semnat, GitHub Releases) | neimplementat | Faza 9 (pagina de descărcare) |

Telefoanele ajung la FINET prin WARP (`ops/cloudflare/README.md`, pasul 5).
