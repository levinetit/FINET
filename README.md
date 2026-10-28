# FINET

Aplicație de finanțe personale și de familie pentru România: bonuri fiscale citite automat, extrase bancare, bugete, recurențe și decontări în familie.

**Stare:** Faza 1 (autentificare, profil, gospodărie) e pe producție. Faza 2 (conturi, categorii, tranzacții, transferuri) e **implementată în repo, parțial închisă**: servicii cu RLS, API `/api/v1` cu `Idempotency-Key` și OpenAPI, paginile `/accounts`, `/transactions`, `/transfers/new`, `/categories`, soldurile pe `/dashboard`, E2E `ledger`. Rămân migrațiile `0002`/`0003` pe Supabase (operatorul), prima rulare E2E pe GitHub și revizuirea de securitate. Detalii: [`docs/ROADMAP.md`](docs/ROADMAP.md), [`docs/reports/faza-2.md`](docs/reports/faza-2.md).

## Documentație
- Specificația: [`docs/FINET_MASTER_PROMPT.md`](docs/FINET_MASTER_PROMPT.md) · Android: [`docs/FINET_ANDROID_MASTER_PROMPT.md`](docs/FINET_ANDROID_MASTER_PROMPT.md)
- Ghidul operatorului: [`docs/GHID_CONSTRUIRE.md`](docs/GHID_CONSTRUIRE.md) (pentru deploy, [`docs/INFRA.md`](docs/INFRA.md) are prioritate: Docker pe VPS, [ADR 0002](docs/adr/0002-deploy-docker-pe-vps.md))
- Arhitectura existentă: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Stack și versiuni: [ADR 0001](docs/adr/0001-stack.md)
- Confidențialitate: [`docs/PRIVACY_NOTES.md`](docs/PRIVACY_NOTES.md) · Securitate: [`docs/SECURITY_CHECKLIST.md`](docs/SECURITY_CHECKLIST.md) · Autentificare: [ADR 0003](docs/adr/0003-auth.md)
- Rapoarte: [Faza 0](docs/reports/faza-0.md) · [Faza 1](docs/reports/faza-1.md) · [Faza 2](docs/reports/faza-2.md)
- API: [`docs/API.md`](docs/API.md), [`docs/openapi.json`](docs/openapi.json) · Registrul: [ADR 0004](docs/adr/0004-ledger.md), [ADR 0005](docs/adr/0005-api-v1.md), [ADR 0006](docs/adr/0006-ledger-ui.md)
- Demo interactiv (date fictive): [`docs/demo/finet-demo.html`](docs/demo/finet-demo.html)

## Rulare locală

Cerințe: Node 24 și pnpm 12 (prin corepack, versiunea din `packageManager`).

**Varianta 1 — Dev Container / Codespaces** (recomandat): deschide repo-ul în container; `.devcontainer/` pornește Node 24, PostgreSQL (versiunea din `ops/postgres/VERSION`) și Mailpit, apoi rulează `pnpm install`.

**Varianta 2 — local:**
```bash
corepack enable          # sau: corepack enable --install-directory ~/.local/bin
pnpm install
cp .env.example .env.local   # valori de dezvoltare; APP_MODE=personal, Access oprit implicit (NODE_ENV≠production), FINET_ROLE=web implicit
pnpm dev                     # http://localhost:3000
```
Fără `DATABASE_URL`, `/api/health` raportează `db: unknown` (`degraded`), iar paginile duc la `/login` (fără sesiune posibilă).

Cu autentificarea (Faza 1): PostgreSQL cu rolurile din `ops/postgres/test-bootstrap.sql`, apoi
```bash
pnpm build:tools
FINET_ROLE=migrate MIGRATOR_DATABASE_URL=postgres://finet_migrator:...@localhost:5432/finet node dist/tools/migrate.mjs
FINET_ROLE=admin DATABASE_URL=postgres://finet_app:...@localhost:5432/finet pnpm admin:create-user --email ana@exemplu.ro --name Ana
# .env.local: DATABASE_URL (rolul finet_app), BETTER_AUTH_SECRET (openssl rand -base64 32), APP_URL=http://localhost:3000
pnpm dev                     # http://localhost:3000/login
```

**Varianta 3 — imaginea de producție:** `docker build -t finet:local .`; rularea pe VPS e descrisă în `docs/INFRA.md` (cere Access configurat: în producție `CF_ACCESS_REQUIRED=false` e refuzat).

## Comenzi

| Comandă | Ce face |
|---|---|
| `pnpm dev` | server de dezvoltare |
| `pnpm build` / `pnpm start` | build de producție (`output: standalone`) / pornire |
| `pnpm check` | lint + typecheck + teste |
| `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, `pnpm format` | calitate |
| `pnpm test` | Vitest (unit + integrare; cu `DATABASE_URL` setat, și verificarea bazei) |
| `pnpm test:coverage` | Vitest cu acoperire (v8), fără prag |
| `pnpm test:e2e` | Playwright: `smoke`, `auth` și `ledger` (browser, `pnpm dev`; `auth` și `ledger` cer bază migrată, utilizatorii E2E și `E2E_PASSWORD`, `E2E_APP_MODE=personal|saas`) și `access` (HTTP, server de producție, după `pnpm build`); `E2E_SERVER=dev|prod` pornește doar unul |
| `pnpm build:tools`, `pnpm db:migrate`, `pnpm admin:*` | unelte: migrații și CLI-ul admin (`create-user`, `reset-password`, `add-member`) |
| `pnpm test:ops` | testele `ops/notify/notify.sh` (fără rețea) |
| `pnpm scan:client-secrets` | caută secrete în `.next/static` (după build) |
