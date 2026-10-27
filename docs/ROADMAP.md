# FINET — roadmap

Starea fazelor din `docs/FINET_MASTER_PROMPT.md` (secțiunea 7) și `docs/FINET_ANDROID_MASTER_PROMPT.md` (secțiunea 8). Stări: **complet**, **parțial**, **neimplementat**.

## Web

| Fază | Stare | Note |
|---|---|---|
| 0 — Fundație și infrastructură | **parțial** | vezi mai jos și `docs/reports/faza-0.md` |
| 1 — Autentificare, profil, gospodărie | **parțial** | F1-A (date, RLS, authz, migrații) și F1-B (Better Auth, API, CLI) gata; F1-C în lucru — vezi mai jos |
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
- shadcn/ui: doar `components.json`, nicio componentă.
- E2E `smoke` (browser) nu a rulat (browserele Playwright nu sunt instalate în mediul agentului); E2E nu rulează în CI.
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

**Rămâne:** F1-C (UI login/profil/sesiuni, antete CSP, E2E Playwright în CI, `docs/SECURITY_CHECKLIST.md`). Înregistrarea publică în `saas` (cu verificare email) nu e implementată (sign-up rămâne închis și în `saas`: `/api/auth/sign-up/email` e cale dezactivată, 404). OpenAPI (`docs/openapi.json`) pentru `/api/v1` nu e generat încă (6.4; de făcut odată cu primele endpointuri din Faza 2 sau în F1-C). Aplicarea migrațiilor pe Supabase o face operatorul (`docker compose ... --profile migrate run --rm finet-migrate`), după revizuiri și backup.

### Puncte deschise
- **Tokenii shadcn/ui:** în FINET `muted` e o culoare de **text** și `accent` e albastrul saturat al acțiunilor, dar shadcn folosește `muted` și `accent` ca **fundaluri** discrete. Înainte de prima componentă shadcn trebuie nume separate (de exemplu `surface-2`, `accent-soft`, ca în demo), altfel componentele ies cu fundaluri greșite.
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
- **F8 (rest) — antetele de securitate:** CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors` → **Faza 9** (hardening).
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
