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

## Android (`docs/FINET_ANDROID_MASTER_PROMPT.md`)

| Fază | Stare | Depinde de (web) |
|---|---|---|
| A — Fundație (Flutter în `mobile/`, temă, navigare, client Dio, date simulate, CI) | neimplementat | — |
| B — Autentificare și profil | neimplementat | Faza 1 + API `/api/v1/` |
| C — Funcții de bază (dashboard, tranzacții, bugete) | neimplementat | Fazele 2–3 |
| D — Recurențe și documente (bonuri, extrase, partajare) | neimplementat | Fazele 5–7 |
| E — Stabilizare și livrare (APK semnat, GitHub Releases) | neimplementat | Faza 9 (pagina de descărcare) |

Telefoanele ajung la FINET prin WARP (`ops/cloudflare/README.md`, pasul 5).
