# FINET — roadmap

Starea fazelor din `docs/FINET_MASTER_PROMPT.md` (secțiunea 7) și `docs/FINET_ANDROID_MASTER_PROMPT.md` (secțiunea 8). Stări: **complet**, **parțial**, **neimplementat**.

## Web

| Fază | Stare | Note |
|---|---|---|
| 0 — Fundație și infrastructură | **parțial** | vezi mai jos și `docs/reports/faza-0.md` |
| 1 — Autentificare, profil, gospodărie | neimplementat | |
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

### Puncte deschise
- **Tokenii shadcn/ui:** în FINET `muted` e o culoare de **text** și `accent` e albastrul saturat al acțiunilor, dar shadcn folosește `muted` și `accent` ca **fundaluri** discrete. Înainte de prima componentă shadcn trebuie nume separate (de exemplu `surface-2`, `accent-soft`, ca în demo), altfel componentele ies cu fundaluri greșite.
- Versiunea PostgreSQL reală (provizoriu `17`).
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
- **F2 (rest) — secretele în data-root-ul Docker:** arhiva săptămânală necriptată a `/home/docker` conține mediul containerelor (`config.v2.json`). Decizia operatorului (excludere/criptare); ulterior, secrete Docker montate ca fișiere (`secrets:`) în locul `env_file` pentru URL-urile bazei de date. Backup-ul propriu criptat al FINET: Faza 3 (restic).
- **F7 (rest) — CA-ul Supabase din cod:** `ssl: { ca }` explicit în clientul Postgres (Faza 1, cu Drizzle), ca să fie acceptat doar CA-ul Supabase; până atunci `NODE_EXTRA_CA_CERTS`. postgres.js nu citește `sslrootcert` din URL.
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
| B — Autentificare și profil | neimplementat | Faza 1 + API `/api/v1/` |
| C — Funcții de bază (dashboard, tranzacții, bugete) | neimplementat | Fazele 2–3 |
| D — Recurențe și documente (bonuri, extrase, partajare) | neimplementat | Fazele 5–7 |
| E — Stabilizare și livrare (APK semnat, GitHub Releases) | neimplementat | Faza 9 (pagina de descărcare) |

Telefoanele ajung la FINET prin WARP (`ops/cloudflare/README.md`, pasul 5).
