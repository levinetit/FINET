# FINET — instrucțiuni pentru agent

- Specificația completă și regulile permanente: `docs/FINET_MASTER_PROMPT.md` (secțiunile 1–6 se aplică mereu; fazele sunt în secțiunea 7).
- Aplicația Android: `docs/FINET_ANDROID_MASTER_PROMPT.md`.
- Starea fazelor: `docs/ROADMAP.md` (creat în Faza 0).
- Ghidul operatorului (infrastructură, Supabase, Cloudflare, secrete): `docs/GHID_CONSTRUIRE.md`.
- Deploy (Docker pe VPS, ADR 0002): `docs/INFRA.md`.
- Echipa de agenți și workflow-ul: `docs/ai-team/WORKFLOW.md`.

Reguli scurte:
- O singură fază pe sesiune, pe un branch `phase/...`, cu PR către `main`. Niciodată push direct pe `main`.
- Fără secrete în cod, commit-uri, issue-uri sau PR-uri.
- Sumele în bani, ca numere întregi; niciodată float.
- Raportează exact comenzile rulate și rezultatele; nu pretinde verificări nefăcute.
- Pașii care cer acces la server, Supabase, Cloudflare sau secrete se scriu ca instrucțiuni pentru operator, nu se execută.

Comenzi (Node 24, pnpm prin corepack):
- `pnpm install --frozen-lockfile`, `pnpm dev`, `pnpm build`
- `pnpm check` (lint + typecheck + teste), `pnpm format:check` (rulat și de CI)
- `pnpm test`, `pnpm test:coverage`, `pnpm test:e2e`, `pnpm test:ops`, `pnpm scan:client-secrets`
- `docker compose -f ops/docker/docker-compose.yml --env-file <compose.env> config` (validare; `up` doar operatorul)
- `pnpm build:tools` (migrații + CLI admin în `dist/tools/`), `pnpm admin:create-user --email <e> --name <n> --password-stdin` (`FINET_ROLE=admin`)
- E2E: `pnpm test:e2e` (`smoke`, `auth`, `ledger`, `planning`, `access`); `auth`, `ledger` și `planning` cer Postgres migrat, utilizatorii din `e2e/fixtures.ts`, `E2E_PASSWORD`, `E2E_APP_MODE=personal|saas`; `E2E_SERVER=prod pnpm test:e2e --project=access` merge fără browser (după `pnpm build`)
- Securitate: `docs/SECURITY_CHECKLIST.md` (actualizată la fiecare revizuire); antetele și CSP-ul cu nonce în `src/lib/security-headers.ts` (fără atribute `style=` în markup)
- UI-ul planificării (ADR 0008): grafice SVG fără bibliotecă, scalate prin `percentOf`, cu tabel text; luna din URL validată în pagină (`planning-page.ts`); exporturile CSV prin `fetch` cu cookie și `dialect=ro`.
- UI-ul registrului (ADR 0006): fiecare pagină apelează `requireLedgerPage(<cale>)`; mutațiile doar prin `/api/v1/*` (`useSubmit`, `Idempotency-Key`); sume doar prin `src/lib/money.ts` (`src/app/_lib/ledger-ui.ts`); texte în `src/messages/ro.ts`; `src/app/ui-rules.test.ts` interzice `style=` și aritmetica float în UI.
