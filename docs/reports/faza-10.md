# Raportul Fazei 10 — Liste, prețuri, rapoarte

Faza are trei părți: **F10-A** (liste de cumpărături și comparația listă ↔ bon; ADR 0022; branch `phase/10-lists`, migrația `0017`), **F10-B** (prețuri, inflație personală, rapoarte de micro-cheltuieli; ADR 0023; branch `phase/10-prices`, migrația `0018`) și **F10-C** (exporturi Excel/PDF/contabil, „Întreabă FINET”, rezumatul lunii; după merge-ul A + B). Acest document conține secțiunea fiecărei părți, pe măsură ce se termină.

## F10-B — Prețuri, inflație personală, rapoarte de micro-cheltuieli

Branch `phase/10-prices` (din `main` ad4d2c2). Producția nu a fost atinsă.

### 1. Ce s-a implementat

- **Date** (`0018_report_definitions`): tabelul `report_definitions` (reguli ca date, JSON versionat), RLS ENABLE + FORCE, plafon de 100 de rapoarte proprii, șase rapoarte de sistem inserate de migrație (pungi și sacoșe; garanția SGR plătită și recuperată; cumpărături de la casă; nealimentare la supermarket; cafea și băuturi la bucată; economii din reduceri și carduri). Nu modifică tabelele existente.
- **Prețuri** (`src/modules/prices`): preț mediu ponderat pe unitate (kg / l / bucată), pe produs normalizat și comerciant (CUI sau nume), serii lunare, cel mai ieftin comerciant, praguri de date; `bigint`, fără float, monede separate.
- **Inflație personală**: indice ponderat cu cheltuiala din perioada de bază, în puncte de bază, doar din articolele cumpărate în ambele perioade; etichetă „estimare din bonurile tale”. Exemplu numeric în teste (421 pb).
- **Rapoarte** (`src/modules/report-definitions`): reguli include/exclude (`exact`/`prefix`/`contains`/`token`, AND/OR plat) evaluate în cod; total, bucăți, preț mediu, proiecție anuală cu prag („date insuficiente”), istoric cu legătură la bon, export CSV; previzualizare; generator propriu.
- **API** `/prices/*`, `/inflation`, `/report-definitions` (+ `/preview`, `/{id}/run`, `/{id}/export.csv`), OpenAPI la zi, rate limit pe rulare.
- **UI** `/insights`: trei secțiuni, grafice SVG proprii cu tabel text, starea în URL; intrare în navigare.
- **GDPR:** exportul include rapoartele create de utilizator.
- **Documentație:** ADR 0023, ROADMAP, API.md, SECURITY_CHECKLIST §26, PRIVACY_NOTES, INFRA 4p.

### 2. Teste rulate local (2026-10-30)

Mediu: `node:24` în container (`--memory` 400–900 MB), PostgreSQL 17 efemer `finet-ci-pg-f10b` (`--memory=256m`) pe rețeaua `finet-ci-net-f10b`.

| Comandă | Rezultat |
|---|---|
| `vitest run src/modules/prices src/modules/report-definitions src/app/_lib/insights-ui.test.ts src/db/report-definitions-rls.test.ts src/app/api/v1/gdpr-api.test.ts` (cu PG) | PASS (10 fișiere, 84 de teste) |
| `vitest run src/app/api/v1/prices-api.test.ts src/db/migrate.test.ts src/openapi src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/api/routes.test.ts src/app/smoke.test.ts src/app/contrast.test.ts` (cu PG) | PASS (8 fișiere, 69 de teste) |
| `FINET_PERF=1 vitest run src/db/perf-prices.test.ts` | PASS (3 teste; rulat la 2026-10-29, nu repetat azi). Timpii: vezi INFRA 4p, **nu sunt sub o secundă** |
| `node scripts/openapi.mjs --check` | PASS |
| `tsc --noEmit` pe tsconfig-uri temporare cu fișierele F10-B (module, pagina `insights`, componente, `app-nav`, `data-export`; fără teste, E2E și rutele API) | PASS |
| `prettier --check` pe fișierele atinse | PASS |
| E2E Playwright (`e2e/insights.spec.ts`, `e2e/a11y.spec.ts`) | NOT RUN local (cere `next build`, nepermis pe host); în CI |
| `eslint`, `pnpm test` complet, `next build` | NOT RUN local (memorie); în CI |

### 3. Decizia mea

- Media **ponderată** (nu mediana) pentru prețul pe unitate: se compune din sume, rămâne exactă pe `bigint` și e stabilă pe puține observații.
- Regulile rapoartelor se evaluează în cod, nu în SQL: nicio interpolare din date de utilizator.
- Bonurile intră în agregate doar dacă sunt confirmate și vizibile; un bon fără tranzacție legată se tratează ca comun (era deja vizibil în `/receipts`).
- Fără LLM și fără apeluri externe în această parte.

### 4. Puncte deschise

- **Performanța** pe ~50.000 de linii: 0,1–6,7 s (mediana) pe un PG cu 256 MB; ADR 0023 §9 și INFRA 4p au fost corectate față de afirmația „sub o secundă” din prima versiune. De reluat pe Supabase.
- E2E și axe pe `/insights`: de rulat în CI.
- Revizuirea `security` pentru F10-B.
- Potrivirea pe nume e euristică: produse cu nume neobișnuite pot scăpa sau intra în plus (de aceea previzualizarea și istoricul cu link la bon).
- La merge cu F10-A: conflicte probabile în `registry.ts`, `ro.ts`, `app-nav`, `data-export.ts`, `ci.yml`, `fixtures.ts`, jurnalul și snapshot-urile migrațiilor; `docs/reports/faza-10.md` se concatenează. Snapshot-ul `0018` trebuie să includă tabelele din `0017` și să aibă `prevId` = `id` din snapshot-ul `0017`.

### 5. Pe producție

`docs/INFRA.md`, secțiunea **4p**. Nimic nu s-a aplicat.
