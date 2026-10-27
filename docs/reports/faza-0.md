# Raportul Fazei 0 — Fundație și infrastructură

- **Branch:** `phase/00-fundatie` (din `main` la `2b28ce4`), fără push.
- **Data:** 2026-10-27.
- **Stare:** **parțial**. Codul și documentația sunt în repo; infrastructura (Supabase, Cloudflare, pornirea pe VPS) așteaptă operatorul.
- **Abatere de la master prompt:** deploy în Docker pe VPS-ul `docker-apps`, nu nativ pe LXC 1999 ([ADR 0002](../adr/0002-deploy-docker-pe-vps.md)).

## 1. Ce s-a implementat și ce a rămas

**Implementat:**
- Scheletul Next.js 16.4.3 (App Router, TypeScript strict), Tailwind 4 cu tokenii FINET, logo-ul `<Logo />`, fonturile locale; ESLint, Prettier, Vitest, Playwright; Dev Container cu PostgreSQL și Mailpit.
- `src/lib/config.ts`: mediul validat cu Zod, oprire la pornire dacă e invalid, Access obligatoriu în producție.
- `src/lib/money.ts`: bani în `bigint`, unități minore, alocare, parsare, formatare RO, cu teste.
- `src/modules/entitlements`: `personal` (permis, cu limitele tehnice); `saas` neimplementat.
- `src/lib/storage.ts`: interfața, driverul local confinat, scheletul S3.
- `src/proxy.ts` + `src/lib/access.ts`: verificarea JWT Cloudflare Access, fail closed; liveness local; `HEALTH_TOKEN`.
- `/api/health` (db, storage, disc; queue/ai `unknown`) și `/api/health/live`.
- `Dockerfile` multi-stage, non-root, healthcheck; `ops/docker/docker-compose.yml` (rețeaua `apps`, IP static, fără porturi, rootfs read-only, `cap_drop: ALL`, limite).
- CI: `.github/workflows/ci.yml` (lint, format, typecheck, teste cu PostgreSQL din `ops/postgres/VERSION`, build, scanarea secretelor, audit non-blocant); Dependabot.
- Instrucțiunile operatorului: `ops/cloudflare/`, `ops/supabase/` (+ `roles.sql`), `ops/notify/notify.sh` (+ teste), `ops/postgres/`.
- Documentația: `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `docs/PRIVACY_NOTES.md`, `docs/ROADMAP.md`, ADR 0001 și 0002.

**Parțial / neimplementat:** proiectul Supabase și securitatea lui; tunelul/Access/WARP; pornirea containerelor pe VPS; jobul săptămânal pentru versiunea PostgreSQL (`ops/postgres/version-check.md`) și workflow-ul de test pe versiunea următoare; notificarea de test trimisă efectiv; componentele shadcn/ui; E2E în CI; colectarea bonurilor și extraselor (sarcină umană). Unitățile systemd și vhost-ul nginx din master prompt nu se mai fac (ADR 0002).

## 2. Fișiere create sau modificate (tot branch-ul)
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `vitest.config.mts`, `playwright.config.ts`, `components.json`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.nvmrc`, `.gitignore`, `.env.example`, `.dockerignore`, `Dockerfile`, `.devcontainer/*`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `src/**` (app, proxy, instrumentation, lib, modules/entitlements), `scripts/scan-client-secrets.*`, `e2e/smoke.spec.ts`, `e2e/access.spec.ts`, `fixtures/*/.gitkeep`, `public/.gitkeep`, `ops/**`, `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `docs/PRIVACY_NOTES.md`, `docs/ROADMAP.md`, `docs/adr/0001-stack.md`, `docs/adr/0002-deploy-docker-pe-vps.md`, `docs/reports/faza-0.md`. Documentele canonice (`docs/FINET_MASTER_PROMPT.md`, `docs/GHID_CONSTRUIRE.md`, `docs/FINET_ANDROID_MASTER_PROMPT.md`) nu au fost modificate.

## 3. Verificări rulate și rezultate

Mediu: container `node:24`, uid 1009, 2 GB RAM, pnpm 12.15.0 prin corepack, pe hostul docker-apps. Rulate la 2026-10-27, după ultimele modificări de cod (T4).

| Comandă | Rezultat |
|---|---|
| `pnpm install --frozen-lockfile` (după adăugarea `@vitest/coverage-v8`) | PASS („Lockfile is up to date”) |
| `pnpm lint` | PASS (0 avertismente) |
| `pnpm format:check` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` cu `DATABASE_URL` către un PostgreSQL 17 efemer (rețea privată) | PASS: 8 fișiere, 203 teste |
| `pnpm test:coverage` | PASS; total: 89,87% instrucțiuni, 88,78% ramuri, 92,5% funcții, 91,24% linii (`src/lib` 98,51%, `src/lib/storage` 80,34%, `scripts` 53,03%); fără prag |
| `pnpm build` | PASS (rute: `/`, `/_not-found`, `/api/health`, `/api/health/live`; Proxy) |
| `pnpm scan:client-secrets` | PASS („Scanare curată … 5 tipare, 9 nume de variabile”) |
| `E2E_SERVER=prod pnpm test:e2e --project=access` (server standalone, `CF_ACCESS_REQUIRED=true`, fără browser) | PASS: 6 teste (`/` → 403 fără JWT, `/api/health` → 403, JWT invalid → 403, `HEALTH_TOKEN` greșit → 403, liveness local → 200, liveness cu antet Cloudflare → 403) |
| `pnpm test:e2e --project=smoke` | **NOT RUN**: browserele Playwright nu sunt instalate (instalarea e prea grea pentru hostul partajat) |
| `pnpm test:ops` (`sh ops/notify/test.sh`, fără rețea; și cu `bash`) | PASS: 17 verificări |
| `sh -n ops/notify/notify.sh ops/notify/test.sh` | PASS |
| `shellcheck` | **NOT RUN**: nu e disponibil în container sau pe host |
| `docker compose -f ops/docker/docker-compose.yml --env-file <compose.env.example cu FINET_ENV_FILE=finet.env.example> --profile worker config` (Compose 2.26.1, fără `up`) | PASS; fără `FINET_HOST` → eroare explicită (exit 15), cum e intenționat |
| `ops/supabase/roles.sql` cu psql pe PostgreSQL 17 efemer (superuser local, cu rolurile `anon`/`authenticated` create înainte) | PASS: fără parole → eroare (exit 3); parole scurte → eroare (exit 3); cu parole fictive → roluri `nobypassrls`, schema deținută de `finet_migrator`, `anon`/`authenticated` fără `USAGE`. **Nu** e verificat pe Supabase (rolul `postgres` acolo nu e superuser) |
| `docker build` al imaginii | rulat în T1 (log existent `dbuild.log`, build reușit), **nu reverificat în T4** |
| Pornirea serverului standalone cu configurații invalide și verificările proxy | rulat în T3 (script de test local), **nu reverificat în T4** în afara E2E `access` de mai sus |
| CI pe GitHub Actions | **NOT RUN** (fără push) |
| Toate criteriile de acceptare care cer Cloudflare, Supabase, telefon, IP extern, notificare reală, pornire pe VPS | **NOT RUN – așteaptă operatorul** (`docs/INFRA.md`, secțiunea 6) |

Containerele și rețeaua de test (`finet-ci-pg`, `finet-ci-net`) au fost șterse după rulare (`docker rm -fv`, `docker network rm`).

## 4. Pornire și deploy
- Local: `README.md` („Rulare locală”).
- VPS: `docs/INFRA.md`, secțiunea 4 (pașii operatorului, în ordine), cu `ops/docker/docker-compose.yml`.

## 5. Variabile de mediu (nume și scop, fără valori)
- Aplicație (validate în `src/lib/config.ts`): `APP_MODE`, `APP_URL`, `NEXT_PUBLIC_APP_NAME`, `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATOR_DATABASE_URL`, `STORAGE_DRIVER`, `STORAGE_DIR`, `STORAGE_QUOTA_MB`, `STORAGE_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`, `CF_ACCESS_REQUIRED`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `HEALTH_TOKEN`, `AI_DAILY_DOCUMENT_LIMIT`, `AI_MONTHLY_BUDGET`, `AI_MONTHLY_BUDGET_CURRENCY`, `NOTIFY_TELEGRAM_BOT_TOKEN`, `NOTIFY_TELEGRAM_CHAT_ID`, `SMTP_HOST/PORT/USER/PASSWORD/FROM`.
- Noi în T4: `NOTIFY_EMAIL_TO` (destinatarul alertelor pe email, doar pentru `ops/notify/notify.sh`); interpolarea compose: `FINET_HOST`, `FINET_IMAGE`, `FINET_ENV_FILE`, `FINET_DATA_DIR`, `FINET_WEB_IP`, `FINET_WORKER_IP`, `FINET_TRAEFIK_ENABLE`, `FINET_CERTRESOLVER`; teste E2E: `E2E_SERVER`, `E2E_DEV_PORT`, `E2E_PROD_PORT`, `E2E_BASE_URL`; `roles.sql`: `FINET_MIGRATOR_PASSWORD`, `FINET_APP_PASSWORD` (doar în sesiunea psql a operatorului).
- Opțional: `NODE_EXTRA_CA_CERTS` (CA-ul Supabase în container, de confirmat).

## 6. Riscuri, limitări, ADR-uri, securitate
- ADR-uri: [0001 stack](../adr/0001-stack.md), [0002 deploy Docker pe VPS](../adr/0002-deploy-docker-pe-vps.md).
- Memoria hostului e mică (~1,1 GB disponibili la măsurare) → risc de OOM; consumul real al `finet-web` nemăsurat.
- Cu varianta Traefik, o cerere directă la IP primește 403 (nu „niciun răspuns”).
- Liveness: un container de pe `apps` cu `Host: 127.0.0.1` primește „ok” (fără alte informații).
- Toate containerele de pe `apps` pot ajunge la `finet-web:3000`; protecția e JWT-ul Access (fail closed) și, din Faza 1, login-ul.
- `/home/docker-apps/finet/` poate intra în backup-ul hostului pe Google Drive: de verificat (`docs/PRIVACY_NOTES.md`).
- Revizuirea de securitate dedicată (agentul `security`) nu a fost rulată în T4.
- Tokenii shadcn (`muted`, `accent`) intră în conflict cu semantica FINET: de rezolvat înainte de prima componentă.

## 7. Pașii următori, prioritizați
1. Revizuirea PR-ului și CI-ul pe GitHub.
2. Operatorul: Supabase (`ops/supabase/README.md`), apoi versiunea reală în `ops/postgres/VERSION`.
3. Operatorul: Cloudflare (`ops/cloudflare/README.md`), directoarele și fișierele de mediu, `docker compose up -d --build finet-web`, criteriile de acceptare.
4. Notificarea de test reală; apoi jobul de versiune PostgreSQL (după Supabase).
5. Rularea E2E `smoke` într-un mediu cu browsere (Codespaces sau CI) și, eventual, E2E în CI în ambele moduri.
6. Tokenii shadcn, apoi Faza 1.
