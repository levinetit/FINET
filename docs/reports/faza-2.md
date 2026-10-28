# Raportul Fazei 2 — Conturi, categorii, tranzacții, transferuri

- **Branch:** `phase/02-transactions` (din `phase/01-auth` la `0beb029`), fără push din partea agentului.
- **Data:** 2026-10-28.
- **Stare:** **parțial**. Codul Fazei 2 e complet în repo (F2-A, F2-B, F2-C). Închiderea cere: revizuirea `security` (F2-B + F2-C), aplicarea migrațiilor `0002_ledger` și `0003_idempotency_purge` pe Supabase (operatorul), prima rulare a job-ului `e2e` (inclusiv proiectul nou `ledger`) pe GitHub și verificarea în browser pe producție.
- Decizii: [ADR 0004](../adr/0004-ledger.md) (registrul), [ADR 0005](../adr/0005-api-v1.md) (API-ul), [ADR 0006](../adr/0006-ledger-ui.md) (interfața). Securitatea: [`docs/SECURITY_CHECKLIST.md`](../SECURITY_CHECKLIST.md). API: [`docs/API.md`](../API.md), [`docs/openapi.json`](../openapi.json).

## 1. Ce s-a implementat

**F2-A — date și servicii:** migrația `0002_ledger` (conturi, 28 de categorii de sistem, vizibilitatea categoriilor, tranzacții cu `transfer_direction`, `idempotency_keys`, `client_installations`, `app_events`, `app_downloads`; RLS `ENABLE` + `FORCE`, drepturi pe coloane, triggere `SECURITY INVOKER`); serviciile conturilor (sold calculat în `bigint`, totaluri pe monedă, arhivare, ștergere doar a conturilor goale), categoriilor (ascundere per gospodărie, ștergere cu reasignare), tranzacțiilor (căutare, filtre, sortare, cursor), transferurilor (două rânduri atomice, ambele sume la monede diferite).

**F2-B — API:** `/api/v1/households`, `accounts`, `categories`, `transactions`, `transfers`, `me/consents`, `app/events`; stratul HTTP comun (401/403/404/409/413/415/422/429/500), `Idempotency-Key` pe creări, migrația `0003_idempotency_purge` + `finet-admin cleanup-idempotency`, `X-FINET-Client` → `client_installations`, evenimentele cu listă fixă și consimțământ, OpenAPI 3.1 generat și verificat în CI.

**F2-C — interfața, E2E, documentația:**
- paginile `/accounts` (solduri, totaluri separate pe monedă, conturi arhivate separat), `/accounts/new`, `/accounts/[id]` (editare, arhivare/dezarhivare, ștergere doar pentru conturile fără tranzacții), `/transactions` (căutare, filtre pe cont/categorie/tip/date/sume, sortare, „Încarcă mai mult” cu cursor, transferurile marcate „Transfer”), `/transactions/new?type=expense|income`, `/transactions/[id]` (editare/ștergere; pentru un transfer: detaliile și ștergerea ambelor rânduri), `/transfers/new` (două sume la monede diferite), `/categories` (sistem + personalizate, ascundere/afișare, creare, redenumire, ștergere cu reasignare);
- `/dashboard`: placeholder-ul Fazei 3 păstrat, plus „Soldurile tale” și ultimele 5 tranzacții;
- navigarea Acasă, Tranzacții, Conturi, Categorii, Profil (jos pe telefon, lateral pe desktop);
- `/profile`: comutatorul `usage_stats` (`PUT /api/v1/me/consents`) cu textul de informare; `X-FINET-Client` (`platform=web; installation=<uuid>; locale=ro-RO`) pleacă doar cu acordul activ;
- mutațiile prin `/api/v1/*` cu `Idempotency-Key` per trimitere și blocare sincronă la dublu-clic; banii doar prin `src/lib/money.ts`; texte în `src/messages/ro.ts`; fără `style=`, fără dependențe noi;
- E2E `e2e/ledger.spec.ts` (9 scenarii a–i din brief), proiectul `ledger` în `playwright.config.ts`, job-ul `e2e` actualizat (utilizatorii `ledger`, `ledger2`, `seed`; `ledger` și în `saas`; timeout 55 min);
- teste unitare noi: `src/app/_lib/{idempotency-key,usage-client,ledger-ui,transaction-filters}.test.ts`, `src/app/ui-rules.test.ts` (fără `style=` și fără aritmetică float pe sume în UI).

**Parțial sau neimplementat:**
- E2E în browser (`smoke`, `auth`, `ledger`): **NOT RUN** local (browserele nu se instalează pe hostul agentului). Scenariile sunt scrise toate, fără `test.skip`; prima rulare e în job-ul `e2e`. Riscuri de fiabilitate de urmărit la prima rulare: (e) face 56 de cereri API cu utilizatorul `seed` (sub limita de 120/min, dar o reîncercare imediată se apropie de ea); (i) depinde de starea consimțământului (testul pornește explicit din „oprit”).
- Editarea transferurilor din UI (API-ul există), subcategoriile și culorile/pictogramele categoriilor în UI: neimplementate (ADR 0006).
- Migrațiile pe Supabase, verificarea prin Access: operatorul (`docs/INFRA.md`, secțiunea 4d).

## 2. Fișiere (F2-C)
- Pagini: `src/app/(app)/accounts/{page,accounts-list,account-form}.tsx`, `accounts/new/page.tsx`, `accounts/[id]/{page,account-actions}.tsx`, `src/app/(app)/transactions/{page,transactions-list,transaction-form}.tsx`, `transactions/new/page.tsx`, `transactions/[id]/{page,transfer-details}.tsx`, `src/app/(app)/transfers/new/{page,transfer-form}.tsx`, `src/app/(app)/categories/{page,categories-manager}.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/app/(app)/page-header.tsx`, `src/app/(app)/profile/{page,usage-consent}.tsx`.
- Biblioteci: `src/app/_lib/{ledger-page,ledger-options,ledger-ui,transaction-filters,idempotency-key,usage-client,use-submit,api-client}.ts` (+ teste), `src/app/ui-rules.test.ts`.
- Componente: `src/components/ledger/{field,confirm-button,usage-sync}.tsx`, `src/components/app/{app-nav,icons}.tsx`; texte: `src/messages/ro.ts`.
- E2E și CI: `e2e/ledger.spec.ts` (nou), `e2e/fixtures.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`.
- Documentație: `docs/adr/0006-ledger-ui.md` (nou), acest raport, `docs/ROADMAP.md`, `docs/SECURITY_CHECKLIST.md`, `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `README.md`, `CLAUDE.md`.

## 3. Comenzi rulate (F2-C, 2026-10-28) și rezultate
Toate în `node:24` (`scratchpad/dk.sh`, 2 GB), Postgres 17 efemer (`postgres:17-alpine`, `--memory=256m`, rețea privată `finet-ci-net`).

| Comandă | Rezultat |
|---|---|
| `pnpm install --frozen-lockfile` | PASS (lockfile neschimbat) |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm exec vitest run` (cu `DATABASE_URL` pe Postgres efemer) | PASS — 44 fișiere, **613 teste trecute**, 5 sărite (cele existente din `db-client.test.ts`); înainte de F2-C: 572 |
| `pnpm build` | prima încercare: „Failed to type check.” fără niciun diagnostic (memorie: 2 GB, `NODE_OPTIONS=--max-old-space-size=1600`); a doua încercare (`next build --debug`, aceleași limite): PASS, toate rutele `ƒ` (dinamice) |
| `pnpm scan:client-secrets` | PASS (9 tipare, 9 nume) |
| `pnpm test:ops` | PASS |
| `pnpm openapi:check` | PASS (`docs/openapi.json` la zi; F2-C nu schimbă API-ul) |
| `pnpm exec playwright test --list` | PASS — 35 de teste în 4 fișiere (inclusiv cele 9 din `ledger`) |
| `pnpm exec playwright test` | **NOT RUN** (fără browsere pe host) |

**Verificarea HTTP pe `next dev`** (fără browser; bază migrată cu `finet-migrate`, doi utilizatori creați cu `finet-admin`, curl dintr-un container pe aceeași rețea privată). Serverul dev a fost oprit de limita de memorie (OOM la 2 GB) după câteva rute compilate, așa că paginile s-au verificat în grupuri, cu repornirea serverului între grupuri:
- fără sesiune: `/dashboard`, `/accounts`, `/accounts/new`, `/transactions`, `/transactions/new?type=expense`, `/transfers/new`, `/categories`, `/profile` → **307** către `/login?next=<cale>`;
- cu sesiune: toate cele de mai sus, plus `/accounts/<id>` și `/transactions/<id>` → **200**, antetul CSP cu `'nonce-…'` prezent, **0 atribute `style=`** în HTML; soldul afișat `974,50 lei` (1.000,00 − 25,50);
- al doilea utilizator: `/accounts/<id străin>`, `/transactions/<id străin>`, `/api/v1/accounts/<id străin>` → **404**; `/accounts` nu conține contul primului utilizator.

## 4. Pornire și deploy
- Local: `README.md` (bază cu `ops/postgres/test-bootstrap.sql`, `finet-migrate`, `finet-admin create-user`, `pnpm dev`).
- Producție (operatorul, după revizuiri): `docs/INFRA.md`, secțiunile 4c (migrațiile `0002`+`0003`, `cleanup-idempotency`) și 4d (ordinea completă a Fazei 2).
- **Variabile de mediu noi:** niciuna în F2-C. Faza 2 nu adaugă secrete; limitele API sunt constante în cod (ADR 0005).

## 5. Riscuri
- Prima rulare E2E `ledger` poate scoate la iveală probleme de selectori sau de timp (dev server rece); se corectează testul, nu se slăbește.
- Memoria hostului: build-ul și `next dev` ating limita de 2 GB; verificările locale grele sunt fragile (vezi tabelul). Imaginile se construiesc în CI.
- `X-FINET-Client`: serverul nu verifică acordul la înregistrarea instalării; regula e în client (ADR 0006). Un client care trimite antetul fără acord creează un rând în `client_installations` (fără date personale). De decis la revizuirea `security` dacă serverul trebuie să verifice și el.
- Pagina `global-error` implicită a Next (stiluri inline) rămâne TODO din Faza 1.

## 6. Pași următori
1. Revizuirea `security` (F2-B + F2-C) și corecțiile.
2. Push de coordonator, prima rulare `ci` + `e2e` (proiectele `smoke`, `auth`, `ledger`, `access`).
3. Operatorul: backup, migrațiile `0002`+`0003`, redeploy `finet-web`, verificarea în browser prin Access, programarea `cleanup-idempotency`.
4. Faza 3: dashboard real, bugete, obiective, rapoarte, export.
