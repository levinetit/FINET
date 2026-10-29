# Raportul Fazei 8 — Familie (F8-A, F8-B)

Branch `phase/08-family`. Datele și serviciile (F8-A) sunt descrise în ADR 0016 și în `docs/SECURITY_CHECKLIST.md` (secțiunile 19 și 19.1, inclusiv corecțiile revizuirii de securitate F8-A); acest raport detaliază F8-B (ADR 0017) și starea de acceptare a fazei.

## 1. Ce s-a implementat în F8-A (rezumat)

- Migrația `0012_family`: `household_invites` (doar SHA-256), `transaction_splits` (suma = totalul, verificată la COMMIT), `settlements`, `user_preferences.active_household_id`, `finet.accept_invite` (SECURITY DEFINER, consum atomic), ultimul owner, plafonul de 6 membri, vizibilitatea personal/comun în RLS.
- Serviciile `src/modules/family/`: invitații, membri și roluri, transferul de ownership, comutatorul, împărțiri (egal, procente, sume fixe), solduri, decontări (parțiale, anulare de oricare parte), plecarea/eliminarea cu avertisment de sold (`unsettledBalance`, `formerMemberIds`).

## 2. Ce s-a implementat în F8-B (ADR 0017)

- **API `/api/v1`** (`src/app/api/v1/_lib/family-handlers.ts`, 19 operații noi în `docs/openapi.json`): membri, rol, eliminare, transfer, plecare; invitații (tokenul o singură dată, fără `Idempotency-Key`), revocare, acceptare (`POST /invites/accept`, 404 uniform, 429); gospodăria activă (`PUT /households/active`); împărțiri (`GET`/`PUT`/`DELETE /transactions/{id}/split`, `GET /family/splits`); solduri; decontări (`POST` idempotent, anulare); `GET /events` (SSE).
- **Erorile F8-A mapate** în `errorPayload`: `InviteUnavailableError` → 404, `InviteRateLimitedError` → 429 + `Retry-After` (fără ele, API-ul dădea 500).
- **Actualizări live:** magistrală în memoria procesului web, publicată de handlere după COMMIT (tranzacții, transferuri, bon confirmat, împărțiri, decontări, membri); publicul calculat din conturile atinse (personal → doar proprietarul). Clientul: `EventSource` + `router.refresh()`; rezervă pe reîncărcare la 60 s.
- **UI:** `/family`, `/join/[token]`, comutatorul de gospodărie în antetul paginilor autentificate, cardul „Împarte cheltuiala” pe `/transactions/[id]`, widgetul „Împărțeli în familie” pe Acasă, bifa „Cont personal” și insigna „Personal” la conturi, „Familie” în navigare.
- **E2E** `e2e/family.spec.ts` (proiectul `family`, modul `personal`, utilizatorii `family`, `family2`, `family3` adăugați în `e2e/fixtures.ts` și în seed-ul din CI).

## 3. Teste (rulate local pe PostgreSQL 17 efemer, `--memory=256m`, rețeaua `finet-ci-net`)

| Comandă | Rezultat |
|---|---|
| `vitest run src/app/api/v1/family-api.test.ts` (9 teste: 401, invitații/token/idempotență, acceptare uniformă, 429, roluri/ultimul owner, împărțire + 409 `transaction_split` + solduri + decontare parțială cu replay + live filtrat, plafon SSE/puls/durată, `close` la comutare, plecare) | PASS |
| `vitest run ledger-api, receipts-api, idempotency, routes, openapi` | PASS (5 fișiere, 38 de teste, după F8-A final) |
| `vitest run src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/contrast.test.ts src/app/_lib/family-ui.test.ts` | PASS (17) |
| `vitest run src/proxy.test.ts src/app/smoke.test.ts src/app/_lib/next-path.test.ts` | PASS (81) |
| `node scripts/openapi.mjs --check` | PASS |
| `tsc --noEmit` pe un tsconfig temporar cu fișierele F8-B (191 de fișiere din `src` în graf) | PASS |
| `eslint --max-warnings=0` și `prettier` pe fișierele atinse | PASS |
| `playwright test --list --project=family` | 4 teste listate |
| E2E `family` (browser) | NOT RUN local (memoria gazdei; rulează în CI) |
| `pnpm test` complet, `tsc` complet, `next build` | NOT RUN local (memoria gazdei, ~1 GB; rulează în CI) |
| SSE prin tunelul Cloudflare / Traefik | NOT RUN (producția; INFRA 4k, pasul 6) |

## 4. Decizii F8-B (detalii în ADR 0017)

- Crearea invitației refuză `Idempotency-Key` (tokenul ar fi memorat în clar).
- SSE în memoria procesului web (nu `LISTEN/NOTIFY`: pooler în mod tranzacție; nu interogare pe server: creările nu sunt auditate, ștergerile nu se pot filtra).
- Publicul evenimentelor de tranzacție după conturi (personal → doar proprietarul); la modificare, cel mai larg dintre contul vechi și cel nou.
- Acceptarea doar prin buton (`POST`), nu la deschiderea paginii.
- Împărțirea din pagina tranzacției, nu din formularul de creare.
- Comutatorul de gospodărie: pagină completă la Acasă după schimbare.

## 5. Riscuri și puncte deschise

- Evenimentele schimbărilor făcute de worker/CLI nu ajung live; o a doua instanță web ar cere o magistrală comună.
- Tokenul de invitație apare în calea URL-ului (jurnalele proxy-urilor, istoricul browserului).
- Bufferizarea SSE prin tunel: de verificat de operator; rezerva pe reîncărcare periodică acoperă cazul.
- Expirarea unei invitații nu e acoperită în E2E (ceasul bazei); e testată în integrarea F8-A.
- Rămân din F8-A (ADR 0016): bonurile/documentele, obiectivele și numele conturilor personale vizibile/ocupate în toată gospodăria.
- De făcut de operator: INFRA 4j + 4k; revizuirea `security` a F8-B.
