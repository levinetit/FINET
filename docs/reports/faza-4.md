# Raportul Fazei 4 — Stabilizare

- **Branch:** `phase/04-stabilization` (din `main` `d887f97`). **Data:** 2026-10-28. **Autor:** programmer (F4).
- **Decizii:** `docs/adr/0010-stabilizare.md`. **Măsurători:** `docs/PERFORMANCE.md`.
- **Stare:** implementat în repo; build, buget JS și E2E de rulat în CI; `0005` pe Supabase și cron-ul: operatorul (`docs/INFRA.md` 4f).

## 1. Ce s-a implementat

1. **Recuperarea după deploy** (chunk-uri JS vechi): `src/app/_lib/chunk-recovery.ts` (logica pură), `src/components/app/chunk-recovery.tsx` (ascultători + banner, montat în layout-ul rădăcină), `src/app/error.tsx` și `src/app/global-error.tsx` (aceeași decizie). Reîncărcare cel mult o dată la 8 s (marcaj în `sessionStorage`, try/catch; fără stocare → banner); formular cu modificări (`data-dirty`) → bannerul „Versiune nouă disponibilă. Salvează și reîncarcă.”.
2. **Regresiile din analiza finpulse:** `e2e/regressions.spec.ts` (proiectul nou `regressions`): (a) cereri doar către propriul domeniu pe `/`, `/login`, `/register`, 404; (b) prefetch RSC fără sesiune pe toate rutele din `src/app/(app)/**` (marcaj de date absent, redirecționare la `/login`; controlul pozitiv cu sesiune); (c) titluri unice, `lang="ro"`, „Sari la conținut”. Plus testul static `src/app/a11y-rules.test.ts`.
3. **Bugetul JS:** `scripts/check-bundle-size.mjs` (+ test și tipuri), `pnpm check:bundle`, pas CI după `pnpm build` cu artefactul `bundle-size`; pragurile în `docs/PERFORMANCE.md`.
4. **Performanța DB:** `src/db/perf.test.ts` (50.000 de tranzacții, doar cu `FINET_PERF=1`), migrația `0005_perf_indexes` (indexul pentru ordinea listei), `tagMatch=all` rescris ca semi-join grupat.
5. **Formatul datei** `zz.ll.aaaa` în paginile Fazei 2 (`formatCalendarDate` → `formatDate`) și `zz.ll.aaaa, HH:mm` în sesiunile din profil.
6. **Accesibilitate:** „Sari la conținut” + `main#continut` focalizabil, focusul în „Mai mult”, `prefers-reduced-motion` global, contrastul tokenilor testat (`src/app/contrast.test.ts`). Formularele aveau deja regiuni `aria-live` (`Alert`).
7. **`tagMatch=any|all`** pe `GET /api/v1/transactions` și pe exportul CSV, în UI (radio „Oricare/Toate”), OpenAPI regenerat, `docs/API.md`.
8. **Operațional:** `docs/INFRA.md` 4f (deploy Faza 4 + linia de cron pentru `cleanup-idempotency`, cu `sudo crontab -e`), `docs/ROADMAP.md` (închis/amânat), `docs/SECURITY_CHECKLIST.md` (N3 închis, `global-error` DONE, secțiunea 14).
9. Acest raport.

## 2. Măsurători înainte / după

**Bugetul JS:** NOT RUN local (build imposibil pe host). Praguri provizorii 250 KiB (autentificat) / 150 KiB (`/login`, `/register`); scriptul validat pe manifestele reale Next 16.4.3 dintr-un `.next/dev` (valori de dezvoltare, nereprezentative). Calibrarea: prima rulare CI.

**Baza de date** (PostgreSQL 17 efemer, `finet_app` cu RLS, mediana din 5; host încărcat):

| Operația | Înainte (ms) | După (ms) |
|---|---|---|
| Dashboard | 142,3 | 123,3 |
| Lista, prima pagină | 116,1 | 16,3 |
| Lista, pagina 2 | 68,6 | 16,2 |
| `tagMatch=all` | 252,1 | 55,1 |
| Export CSV 50.000 | 7.676 | 4.652 |

Planul primei pagini: `Seq Scan` + `top-N heapsort` (84 ms) → `Index Scan using transactions_household_date_idx` (~2 ms). Tabelul complet și planurile: `docs/PERFORMANCE.md` 2.

## 3. Comenzi rulate (2026-10-28) și rezultate

Toate prin `scratchpad/dk.sh` (node:24, uid 1009), Postgres `postgres:17-alpine` cu `--memory=256m` pe rețeaua privată `finet-ci-net`, șters la final (`docker rm -fv`, rețeaua, imaginea trasă).

| Comanda | Rezultat |
|---|---|
| `vitest run src/app/_lib/ledger-ui.test.ts src/app/_lib/planning-ui.test.ts src/app/ui-rules.test.ts` | PASS (29) |
| `pnpm openapi:generate` + `vitest run src/app/_lib/transaction-filters.test.ts src/openapi/openapi.test.ts` | PASS (15) |
| `vitest run src/app/_lib/chunk-recovery.test.ts src/app/ui-rules.test.ts` | PASS (14) |
| `vitest run src/app/a11y-rules.test.ts src/app/contrast.test.ts` | PASS (10) |
| `vitest run scripts/check-bundle-size.test.ts`, apoi `vitest run scripts/` | PASS (6), PASS (28) |
| `node scripts/check-bundle-size.mjs --next-dir .next/dev` (doar validarea parserului) | cod 1 cum era de așteptat (dev ≈ 850 KiB) |
| `playwright test --list` | PASS (47 de teste în 6 fișiere) |
| `FINET_PERF=1 vitest run src/db/perf.test.ts` (înainte, după, după reluat) | PASS (5) ×3 |
| `vitest run src/db/migrate.test.ts src/modules/exports/exports.test.ts src/app/api/v1/planning-api.test.ts src/modules/transactions/transactions.test.ts` | prima rulare: FAIL 2 (contoarele de migrații 5 → 6 în `migrate.test.ts`, actualizate pentru `0005`); restul PASS (55) |
| `vitest run src/db/migrate.test.ts src/db/ledger-rls.test.ts src/db/grants.test.ts` | PASS (51) |
| `vitest run src/app/api/routes.test.ts src/app/api/v1/ledger-api.test.ts src/modules/dashboard/dashboard.test.ts` (Postgres 17) | PASS (22) |
| `eslint` + `prettier --check` + `playwright test --list --project=regressions` după corecția spec-ului | PASS (4 teste listate) |
| `vitest run src/app scripts src/openapi src/lib` (fără DB) | PASS (380, 77 sărite fără DB) |
| `eslint --max-warnings=0` pe cele 35 de fișiere TS/JS modificate | PASS |
| `prettier --check --ignore-unknown` pe fișierele modificate | PASS |
| `pnpm typecheck` (container 700 MiB) | **NOT RUN (OOM host)**: oprit de OOM (137), nerelansat |
| `pnpm build`, `pnpm check:bundle`, `pnpm test` complet, `pnpm test:e2e` | **NOT RUN (OOM host)**: sub 1,5 GB liberi; rămân pentru CI |

Testele modificate (nu slăbite): `ledger-ui.test.ts` (formatul nou cerut), `migrate.test.ts` (lista și numărul migrațiilor includ `0005`; testul „0004 peste 0000–0003” acum aplică 0004 + 0005), `scan-client-secrets.test.ts` (cazul negativ de 11 cifre devine pozitiv; negativul trece la 13 cifre).

## 4. Pornire și deploy

`docs/INFRA.md` 4f: imaginile, backup, `0005` (prima rulare „aplicate acum 1”), redeploy `finet-web`, verificările din browser, cron-ul de curățare. Fără variabile de mediu sau secrete noi. CI: un utilizator E2E nou (`regresii`) per mod și pasul „Buget de mărime JavaScript”.

## 5. Decizii proprii

- `tagMatch` fără `tagIds` → 400 (nu ignorat).
- `data-dirty` nu se scoate la `submit` (protecție mai largă, uneori banner în loc de reîncărcare).
- Fără `@axe-core/playwright` și fără jsdom (nicio dependență nouă).
- Indexul vechi rămâne după `0005`.
- `when` al `0005` corectat la `1793300000000` (drizzle-kit a dat unul mai mic decât `0004`).

## 6. Riscuri și limitări

- Pragurile bugetului JS sunt neverificate: primul CI poate pica la pasul nou, caz în care se ajustează `docs/PERFORMANCE.md`, nu scriptul.
- E2E `regressions` nu a rulat niciodată. Cel mai probabil punct de ajustare e forma răspunsului RSC fără sesiune (status 200 cu redirecționare în flux sau 307).
- Recuperarea după deploy nu a fost testată în browser, doar logica de decizie.
- Timpii DB sunt măsurați pe un host încărcat.
- Exportul complet (~4,5 s) și căutarea `q` sunt limitate de aplicație/`ILIKE` (amânate în ROADMAP).
- Acceptarea Fazei 4 cere „lista problemelor găsite în folosirea reală”: nu există încă. Se completează aici după prima săptămână de folosire.

## 7. Următorii pași

Push și CI (coordonatorul), calibrarea pragurilor JS, revizuirea `security` a Fazei 4, aplicarea `0005` și instalarea cron-ului (operatorul), apoi Faza 5 (recurențe).
