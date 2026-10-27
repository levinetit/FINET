# FINET

Aplicație de finanțe personale și de familie pentru România: bonuri fiscale citite automat, extrase bancare, bugete, recurențe și decontări în familie.

**Stare:** Faza 0 (fundație) **parțială**: scheletul aplicației, configurația, banii, storage-ul, protecția Cloudflare Access, `/api/health`, imaginea Docker și CI există; infrastructura (Supabase, Cloudflare, containerele pe VPS) așteaptă operatorul. Nicio funcție de business încă. Detalii: [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Documentație
- Specificația: [`docs/FINET_MASTER_PROMPT.md`](docs/FINET_MASTER_PROMPT.md) · Android: [`docs/FINET_ANDROID_MASTER_PROMPT.md`](docs/FINET_ANDROID_MASTER_PROMPT.md)
- Ghidul operatorului: [`docs/GHID_CONSTRUIRE.md`](docs/GHID_CONSTRUIRE.md) (pentru deploy, [`docs/INFRA.md`](docs/INFRA.md) are prioritate: Docker pe VPS, [ADR 0002](docs/adr/0002-deploy-docker-pe-vps.md))
- Arhitectura existentă: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Stack și versiuni: [ADR 0001](docs/adr/0001-stack.md)
- Confidențialitate: [`docs/PRIVACY_NOTES.md`](docs/PRIVACY_NOTES.md) · Raportul Fazei 0: [`docs/reports/faza-0.md`](docs/reports/faza-0.md)
- Demo interactiv (date fictive): [`docs/demo/finet-demo.html`](docs/demo/finet-demo.html)

## Rulare locală

Cerințe: Node 24 și pnpm 12 (prin corepack, versiunea din `packageManager`).

**Varianta 1 — Dev Container / Codespaces** (recomandat): deschide repo-ul în container; `.devcontainer/` pornește Node 24, PostgreSQL (versiunea din `ops/postgres/VERSION`) și Mailpit, apoi rulează `pnpm install`.

**Varianta 2 — local:**
```bash
corepack enable          # sau: corepack enable --install-directory ~/.local/bin
pnpm install
cp .env.example .env.local   # valori de dezvoltare; APP_MODE=personal, CF_ACCESS_REQUIRED=false
pnpm dev                     # http://localhost:3000
```
Fără `DATABASE_URL`, `/api/health` raportează `db: unknown` (`degraded`).

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
| `pnpm test:e2e` | Playwright: `smoke` (browser, `pnpm dev`) și `access` (HTTP, server de producție, după `pnpm build`); `E2E_SERVER=dev|prod` pornește doar unul |
| `pnpm test:ops` | testele `ops/notify/notify.sh` (fără rețea) |
| `pnpm scan:client-secrets` | caută secrete în `.next/static` (după build) |
