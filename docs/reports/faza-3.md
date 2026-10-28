# Raportul Fazei 3 — Dashboard, bugete, obiective, etichete, rapoarte, export CSV, backup

- **Branch:** `phase/03-dashboard` (din `main` la `e423b44`), fără push din partea agentului.
- **Data:** 2026-10-28.
- **Stare:** **parțial**. F3-A (date și servicii), F3-B (API) și F3-C (interfața, E2E, documentația) sunt în repo. Rămân: F3-D (backup restic zilnic + restaurare testată efectiv — **fără backup testat nu se introduc date reale**), aplicarea migrației `0004` pe Supabase (operatorul), prima rulare a job-ului `e2e` cu proiectul `planning` pe GitHub, revizuirea `security`.
- Decizii: [ADR 0007](../adr/0007-planning-reporting.md) (date, servicii, API), [ADR 0008](../adr/0008-planning-ui.md) (interfața). Securitatea: [`docs/SECURITY_CHECKLIST.md`](../SECURITY_CHECKLIST.md), secțiunile 11–12. API: [`docs/API.md`](../API.md).

## 1. Ce s-a implementat

**F3-A — date și servicii:** migrația `0004_budgets_goals_tags` (etichete, vizibilitatea lor, legăturile cu tranzacțiile, bugete, obiective; RLS `ENABLE` + `FORCE`, bugetele personale doar ale proprietarului, drepturi pe coloane), serviciile etichetelor, bugetelor (semafor în întregi), obiectivelor (stare calculată, contribuții), dashboard-ului, raportului lunar și exportului CSV; corecțiile LOW-1, LOW-2 și INFO din revizuirea Fazei 2. Detalii: ADR 0007.

**F3-B — API:** rutele `/api/v1/tags`, `budgets` (+ `status`), `goals` (+ `contributions`, `abandon`), `dashboard`, `reports/monthly`, `exports/*.csv`; `tags` în răspunsurile de tranzacție, filtrele `tagIds`/`merchant`, luna validată, rate limit și audit pe exporturi, OpenAPI. Detalii: ADR 0007, „API (F3-B)”.

**F3-C — interfața (ADR 0008):**
- `/dashboard`: selector de lună (ultimele 12, `?month=`), carduri Venituri/Cheltuieli/Sold net/Tranzacții pe monedă cu comparația față de luna anterioară, graficele „Cheltuieli pe categorii”, „Evoluție lunară”, „Trend zilnic” (SVG fără bibliotecă, cu tabel text), bugetele lunii cu semafor, avertizarea bugetelor, obiectivele active, onboarding-ul în 3 pași, soldurile și ultimele tranzacții, gospodăria;
- `/transactions`: filtrele noi „Comerciantul” și „Etichetele” (oricare), etichetele pe rânduri (și la „Încarcă mai mult”), „Export CSV” cu filtrele aplicate; formularul tranzacției cu etichete (cel mult 10; la editare se păstrează cele curente, inclusiv ascunse);
- `/tags`: etichetele de sistem (ascundere) și ale gospodăriei (creare, redenumire, culoare, ascundere, ștergere cu confirmare);
- `/budgets`, `/budgets/new`, `/budgets/[id]`: semaforul pe luna aleasă, cheltuit/rămas/depășire, pragul pe bară, avertizarea, crearea (general sau pe categorie, prag, `household|personal`), editarea limitei și a pragului, arhivarea, ștergerea, exportul lunii;
- `/goals`, `/goals/new`, `/goals/[id]`: obiectivele pe stări, progresul, crearea/editarea, contribuțiile (adaugă/scade, `Idempotency-Key` mereu), abandonarea/reluarea, ștergerea, exportul;
- `/reports`: raportul lunii (totaluri pe monedă, categorii cu subcategorii, comercianții principali, bugete, obiective) și cele trei exporturi CSV (`dialect=ro`);
- navigarea: meniul lateral complet pe desktop; pe telefon Acasă, Tranzacții, Bugete, Rapoarte și „Mai mult”;
- descărcarea CSV prin `fetch` cu cookie (fără token în URL), mesaje clare la 409 `export_too_large` și 429;
- E2E `e2e/planning.spec.ts` (8 scenarii), proiectul `planning`, utilizatorii `planning`/`planning2` în CI, rulat în ambele moduri;
- teste unitare noi: `src/app/_lib/{planning-ui,download}.test.ts`, extinderea `transaction-filters.test.ts` (etichete, comerciant, export).

**Parțial sau neimplementat:**
- **F3-D (backup restic, restaurare testată):** de completat de F3-D în secțiunile de mai jos marcate „F3-D”.
- E2E în browser: **NOT RUN** local (fără browsere pe host); prima rulare e în job-ul `e2e`.
- `pnpm build` și `pnpm scan:client-secrets`: **NOT RUN** local (memoria hostului, vezi 3); le rulează CI-ul.
- Datele paginilor Fazei 2 rămân „28 oct. 2026” (paginile noi folosesc `28.10.2026`, 5.3); datele demo din onboarding, axe în E2E, insigna de avertizare în meniu: amânate (ADR 0008).

## 2. Fișiere (F3-C)
- Pagini noi: `src/app/(app)/tags/{page,tags-manager}.tsx`, `budgets/{page,budget-form}.tsx`, `budgets/new/page.tsx`, `budgets/[id]/page.tsx`, `goals/{page,goal-form}.tsx`, `goals/new/page.tsx`, `goals/[id]/{page,goal-actions}.tsx`, `reports/page.tsx`.
- Pagini modificate: `src/app/(app)/dashboard/page.tsx`, `transactions/{page,transactions-list,transaction-form}.tsx`, `transactions/new/page.tsx`, `transactions/[id]/page.tsx`.
- Biblioteci: `src/app/_lib/{planning-ui,planning-page,download}.ts` (+ teste), `transaction-filters.ts` (+ test), `ledger-options.ts`.
- Componente: `src/components/planning/{charts,summary,month-selector,export-button,tag-chip}.tsx`, `src/components/app/{app-nav,icons}.tsx`; texte: `src/messages/ro.ts`.
- E2E și CI: `e2e/planning.spec.ts` (nou), `e2e/fixtures.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`.
- Documentație: `docs/adr/0008-planning-ui.md` (nou), acest raport, `docs/ROADMAP.md`, `docs/SECURITY_CHECKLIST.md`, `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `CLAUDE.md`.

## 3. Comenzi rulate (F3-C, 2026-10-28) și rezultate
Toate în `node:24` (`scratchpad/dk.sh`), cu `NODE_OPTIONS=--max-old-space-size=600…900`. Hostul avea ~0,8–1,7 GB RAM disponibili (swap plin), deci fără Postgres efemer și fără build.

| Comandă | Rezultat |
|---|---|
| `pnpm install --frozen-lockfile` | PASS (lockfile neschimbat, fără dependențe noi) |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm openapi:check` | PASS (`docs/openapi.json` e la zi; API neschimbat) |
| `pnpm test:ops` | PASS |
| `vitest run --maxWorkers=2` (fără `DATABASE_URL`) | PASS: 39 de fișiere, 480 de teste trecute, 263 sărite (testele de integrare cu PostgreSQL, 20 de fișiere) |
| testele de integrare cu PostgreSQL (`pnpm test` cu `DATABASE_URL`) | NOT RUN în F3-C (memoria hostului; F3-C nu a modificat serviciile, migrațiile sau rutele API; ultima rulare: F3-B) |
| `playwright test --list --project=planning` | PASS: 8 teste listate |
| `pnpm test:e2e` (browser) | NOT RUN (fără browsere pe host; job-ul `e2e`) |
| `pnpm build` | NOT RUN (OOM host: sub 2 GB disponibili; CI) |
| `pnpm scan:client-secrets` | NOT RUN (cere `.next/static` din build; CI) |

F3-D: comenzile backup-ului și ale restaurării.

## 4. Pornire și deploy
- Local: ca în Faza 2 (`pnpm dev`, Postgres migrat). E2E: `pnpm test:e2e --project=planning` cu utilizatorii `e2e-planning-<mod>@finet.test` și `e2e-planning2-<mod>@finet.test` (`e2e/fixtures.ts`).
- Producție: `docs/INFRA.md`, „Faza 3 pe producție” (migrația `0004`, redeploy `finet-web`, verificări). UI-ul nu cere pași de deploy proprii. Backup-ul: F3-D.

## 5. Variabile de mediu noi
F3-C: niciuna. F3-D: de completat (parola restic și destinația stau doar pe server).

## 6. Riscuri, limitări, securitate
- `q` și `merchant` (text liber) în URL: LOW-3 extins (ADR 0008); aplicația nu loghează URL-uri, proxy-urile le pot înregistra.
- Graficele randate pe server pentru volume mari (Faza 7) citesc toate tranzacțiile lunii/celor 12 luni (ADR 0007).
- E2E nerulate local: riscuri de fiabilitate la prima rulare — timpul de compilare al `next dev` pe paginile noi (scenariul g are `test.slow()`), focusul în scenariul h depinde de stilul `focus-visible` al `Select`.
- Revizuirea `security` a F3-A, F3-B, F3-C: TODO.

## 7. Următorii pași
1. F3-D: backup restic zilnic + restaurare testată efectiv (condiție pentru date reale).
2. Push + prima rulare CI (`ci`, `e2e` cu `planning` în ambele moduri), corecțiile care rezultă.
3. Revizuirea `security` a Fazei 3.
4. Operatorul: `0004` pe Supabase, redeploy, verificările din `docs/INFRA.md`.
5. Faza 4: alinierea datelor la `zz.ll.aaaa` peste tot, axe în E2E, problemele din prima săptămână de folosire.
