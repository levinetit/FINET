# Raportul Fazei 5 — Recurențe

- **Branch:** `phase/05-recurring` (din `phase/04-stabilization`). **Data:** 2026-10-28. **Autor:** programmer (F5-A, F5-B).
- **Decizii:** `docs/adr/0011-recurring-worker.md` (date, worker), `docs/adr/0012-recurring-ui.md` (API, UI).
- **Stare:** implementat în repo; build, typecheck complet și E2E de rulat în CI; schema `pgboss`, migrațiile `0006`/`0007` și workerul: operatorul (`docs/INFRA.md` 4g).

## 1. Ce s-a implementat

**F5-A** (detaliat în ADR 0011): migrațiile `0006_recurring` și `0007_pgboss`, calendarul recurențelor, serviciile `src/modules/recurring/` (CRUD, pauză/reluare fără retroactiv, generare idempotentă cu recuperare limitată la 12/regulă/rulare), workerul pg-boss (job orar, job la cerere, semnal de viață în `/api/health`).

**F5-B:**
1. **API** `/api/v1/recurring`: `GET` (listă + `counts`), `POST`, `GET/PATCH/DELETE /{id}`, `POST /{id}/pause`, `/{id}/resume`, `POST /generate` (`Idempotency-Key` obligatoriu, limită 6/min, direct în web, audit doar cu contoare), `GET /summary`. `recurringRuleId` pe tranzacții. OpenAPI regenerat, `docs/API.md`. Evenimentele `recurring_created`, `recurring_generated`.
2. **UI:** `/recurring` (filtre pe stare, contorul „X active · Y reguli scadente · Z total”, „Generează scadentele”), `/recurring/new`, `/recurring/[id]` (stare cu motivul „cont arhivat”, pauză/reluare, editare, ștergere cu confirmare); `/transactions`: insigna „recurentă” și filtrul „Sursa”; meniul „Recurențe”.
3. **Teste:** `src/app/api/v1/recurring-api.test.ts` (9 scenarii pe Postgres real), `src/app/_lib/recurring-ui.test.ts`, `transaction-filters.test.ts` (sursa), `e2e/recurring.spec.ts` (4 scenarii, proiectul `recurring`).
4. **Documentație:** ADR 0012, acest raport, ROADMAP, SECURITY_CHECKLIST (15), ARCHITECTURE, INFRA (4g).

## 2. Teste rulate local (F5-B)

| Comandă | Rezultat |
|---|---|
| `vitest run recurring-api.test.ts openapi.test.ts ledger-api.test.ts planning-api.test.ts` (PG17 efemer, `--memory=256m`) | PASS (4 fișiere, 44 teste) |
| `vitest run src/modules/ledger/input.test.ts` | PASS (26) |
| `vitest run recurring-ui.test.ts transaction-filters.test.ts ui-rules.test.ts a11y-rules.test.ts` | PASS (4 fișiere, 25 teste) |
| `eslint` și `prettier --check` pe fișierele atinse | PASS |
| `node scripts/openapi.mjs` (generare) | `docs/openapi.json` actualizat |
| `playwright test --list --project=recurring` | 4 teste listate |
| `tsc --noEmit` complet, `next build`, `pnpm test` complet, E2E real, `check:bundle`, `scan:client-secrets` | NOT RUN (OOM host: ~0,8 GB disponibil) — CI |

## 3. Decizii

Vezi ADR 0012: generarea în web (coordonator), limita 6/min, contorul „reguli scadente”, auditul cu contoare, CSV-ul neschimbat, cartea de dashboard amânată.

## 4. Riscuri

- `docs/openapi.json` și tipurile verificate doar prin teste; `tsc` complet rulează abia în CI.
- Generarea la cerere ține lock-urile regulilor până la commit-ul cheii de idempotență (o gospodărie cu multe reguli scadente: o cerere mai lungă; plafonul de 12/regulă limitează).
- E2E nerulat local: selectorii (`getByLabel`) pot cere ajustări la prima rulare CI.

## 5. Ce urmează

Operatorul: 4g (schema `pgboss`, `0006`/`0007`, redeploy web, worker). Revizuirea `security` (F5-A + F5-B). Amânate: fusul gospodăriei, cartea de pe dashboard, transferurile recurente, detectarea din extrase (Faza 7), notificările.
