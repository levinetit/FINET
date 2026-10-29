# Raportul Fazei 10 — Liste, prețuri, rapoarte

Faza are trei părți: **F10-A** (liste de cumpărături și comparația listă ↔ bon; ADR 0022; branch `phase/10-lists`, migrația `0017`), **F10-B** (prețuri, inflație personală, rapoarte de micro-cheltuieli; ADR 0023; branch `phase/10-prices`, migrația `0018`) și **F10-C** (exporturi Excel/PDF/contabil, „Întreabă FINET”, rezumatul lunii; după merge-ul A + B). Acest document conține secțiunea fiecărei părți, pe măsură ce se termină.

## F10-A — Liste de cumpărături și comparația listă ↔ bon

Branch `phase/10-lists` (din `main` ad4d2c2). Producția nu a fost atinsă și nu s-a făcut push.

### 1. Ce s-a implementat

- **Date** (`0017_shopping_lists`): `shopping_lists`, `shopping_list_items`, `shopping_list_ai_requests`; RLS ENABLE + FORCE, drepturi minime pe coloane, chei străine compuse cu gospodăria, plafoane (100 de liste, 300 de articole) prin triggere și CHECK. Pe `receipt_lines`, doar cheia unică `(id, household_id)`.
- **Servicii și API** `/api/v1/shopping-lists` (CRUD pe liste și articole, bifare idempotentă, reordonare, arhivare, copiere, sugestii, bonuri recente, comparație, acțiuni pe potriviri), `Idempotency-Key` la creare, evenimente live `shopping_list` (doar tip + id), OpenAPI la zi.
- **Potrivire în cod** (`match.ts`): scor 0–100 pe cuvinte de conținut, praguri 80/50, alocare 1–la–1, învățare din confirmări și respingeri. Rezultat: potrivite / neplanificate / uitate.
- **Pas opțional cu LLM** (`ai-match.ts`, `worker/shopping/list-match-jobs.ts`): oprit implicit (`AI_LIST_MATCH=0`), cere consimțământul `external_ai`, buget AI, doar nume normalizate, ieșire constrânsă la candidați. Vezi ADR 0022 §4.
- **UI:** `/shopping-lists`, `/shopping-lists/[id]` (mod „la raft”), `/shopping-lists/[id]/compare`; intrare în navigare, `/help`.
- **GDPR:** export și ștergerea listelor personale la ștergerea contului.
- **Documentație:** ADR 0022, ROADMAP, API.md, SECURITY_CHECKLIST §25, PRIVACY_NOTES, INFRA 4o.

### 2. Teste rulate local (2026-10-30)

Mediu: `node:24` în container (`--memory` 400–850 MB), PostgreSQL 17 efemer `finet-ci-pg-f10a` (`--memory=256m`) pe rețeaua `finet-ci-net-f10a`.

| Comandă | Rezultat |
|---|---|
| `vitest run src/modules/shopping src/worker/shopping src/lib/config.test.ts src/worker/worker.test.ts src/worker/pgboss.test.ts` (cu PG) | PASS (7 fișiere, 115 teste) |
| `vitest run src/db/shopping-rls.test.ts src/modules/gdpr src/openapi` (cu PG) | PASS (3 fișiere, 24 de teste) |
| `vitest run src/app/api/v1/shopping-api.test.ts src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/api/routes.test.ts src/app/smoke.test.ts src/app/_lib` (cu PG) | PASS (20 de fișiere, 182 de teste) |
| Testul nou „coada AI: al doilea membru…” (`shopping-rls.test.ts`) | PASS; **pică** dacă se scoate garda `setWhere` din `upsertAiRequest` (verificat prin mutație, apoi restaurat) |
| `node scripts/openapi.mjs --check` | PASS |
| `sh ops/docker/test-env-examples.sh` | PASS |
| `tsc --noEmit` pe un tsconfig temporar cu fișierele F10-A (fără teste și E2E) | PASS |
| `prettier --check` pe fișierele atinse | PASS |
| E2E Playwright (`e2e/shopping.spec.ts`) | NOT RUN local (cere `next build`, nepermis pe host); în CI |
| `eslint`, `pnpm test` complet, `next build` | NOT RUN local (memorie); în CI |

### 3. Decizia mea

- Listele sunt **comune** implicit (cumpărăturile sunt un proces de familie); personale la cerere.
- Potrivirea o face codul; LLM-ul e un pas opțional, oprit implicit, doar pentru perechi ambigue.
- Fără coadă offline nouă pentru liste (ADR 0020 rămâne neschimbat).
- Nu există rolul `viewer` în repo (doar `member` și `owner`), deci cerința „viewer doar citește” din brief nu are obiect.

### 4. Puncte deschise

- E2E (`e2e/shopping.spec.ts`) și axe pe paginile noi: de rulat în CI.
- Revizuirea `security` pentru F10-A; CSRF pe mutațiile listelor nu are test dedicat (mecanism comun al `/api/v1`).
- Exportul GDPR include listele (`data-export.ts`), dar fără test dedicat.
- Evaluarea calității potrivirii pe bonuri reale ale operatorului (în afara repo-ului): neîncepută.
- La merge cu F10-B: conflicte probabile în `registry.ts`, `ro.ts`, `app-nav`, `data-export.ts`, jurnalul și snapshot-urile migrațiilor.

### 5. Pe producție

`docs/INFRA.md`, secțiunea **4o**. Nimic nu s-a aplicat.
