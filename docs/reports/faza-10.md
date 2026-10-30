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
| E2E Playwright (`e2e/shopping.spec.ts`: listă nouă + bifare, izolare listă personală, comparație cu bon sintetic, CSP) | SCRIS; `tsc` PASS pe spec; NOT RUN local (cere `next build`, nepermis pe host); în CI |
| `eslint`, `pnpm test` complet, `next build` | NOT RUN local (memorie); în CI |

### 3. Decizia mea

- Listele sunt **comune** implicit (cumpărăturile sunt un proces de familie); personale la cerere.
- Potrivirea o face codul; LLM-ul e un pas opțional, oprit implicit, doar pentru perechi ambigue.
- Fără coadă offline nouă pentru liste (ADR 0020 rămâne neschimbat).
- Nu există rolul `viewer` în repo (doar `member` și `owner`), deci cerința „viewer doar citește” din brief nu are obiect.

### 4. Puncte deschise

- E2E (`e2e/shopping.spec.ts`): scris, nerulat; de validat în CI. Actualizarea live între doi membri nu are E2E (doar testul de integrare). Axe pe paginile noi: neadăugat în `e2e/a11y.spec.ts`.
- Revizuirea `security` pentru F10-A; CSRF pe mutațiile listelor nu are test dedicat (mecanism comun al `/api/v1`).
- Exportul GDPR include listele (`data-export.ts`), dar fără test dedicat.
- Evaluarea calității potrivirii pe bonuri reale ale operatorului (în afara repo-ului): neîncepută.
- La merge cu F10-B: conflicte probabile în `registry.ts`, `ro.ts`, `app-nav`, `data-export.ts`, jurnalul și snapshot-urile migrațiilor.

### 5. Pe producție

`docs/INFRA.md`, secțiunea **4o**. Nimic nu s-a aplicat.

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

## F10-C — Exporturi, „Întreabă FINET”, rezumatul lunii

F10-C se livrează în două părți: **partea 1** (exporturi Excel/PDF și export pentru contabil; ADR 0024; branch `phase/10-exports`, fără migrație) și **partea 2** („Întreabă FINET” și rezumatul lunii; ADR 0025; branch `phase/10-ask`, fără migrație).

### Partea 1 — exporturi Excel/PDF și export pentru contabil

#### 1. Ce s-a implementat

- **Scriitori fără dependențe noi** (`src/lib/xlsx.ts`, `src/lib/pdf.ts`, model comun `export-table.ts`): Excel (OOXML în ZIP, valid în `openpyxl`) și PDF (Helvetica standard cu codificare proprie pentru diacritice și `/ToUnicode`; verificat cu `pdf.js` și randat cu poppler).
- **Exporturi `.xlsx`/`.pdf`** pentru tranzacții, obiective, bugete, cu aceleași reguli ca CSV (RLS, filtre, audit, protecția `Sec-Fetch-Site`, limită de cereri); auditul adaugă `metadata.format`.
- **Export pentru contabil** (CSV, Excel) și **lista bonurilor** (Excel, PDF) pe o perioadă: un rând per bon confirmat vizibil, TVA pe cote calculat din linii (rotunjit o dată pe grup), coloane de control pentru diferențele de TVA și de total.
- **Interfață:** butoane Excel/PDF pe `/transactions`, `/goals`, `/budgets`; cardul „Export pentru contabil” pe `/receipts`.
- **Documentație:** ADR 0024, API.md, INFRA 4q, ROADMAP, SECURITY_CHECKLIST §27, PRIVACY_NOTES.

#### 2. Teste rulate local (2026-10-30)

Mediu: `node:24` în container (`--memory` 600–1100 MB), PostgreSQL 17 efemer.

| Comandă | Rezultat |
|---|---|
| `vitest run src/lib/xlsx.test.ts src/lib/pdf.test.ts` | PASS (11 + 9 teste) |
| `vitest run src/modules/exports` (inclusiv `accounting.test.ts`, `csv.test.ts`) | PASS |
| `vitest run src/app/api/v1/exports-tables-api.test.ts src/app/api/v1/exports-accounting-api.test.ts` (cu PG) | PASS (9 + 9 teste) |
| `vitest run src/app/api/v1/planning-api.test.ts src/openapi src/app/_lib src/app/ui-rules.test.ts src/app/a11y-rules.test.ts` | PASS |
| `node scripts/openapi.mjs --check` | PASS |
| `openpyxl` (container `python:3.13-slim`) pe un fișier .xlsx generat | PASS: foaie, tipuri, date, formulă rămasă text |
| Randare PDF cu poppler (cu font Liberation) | PASS vizual (tabel, antet, numerotare) |
| `tsc --noEmit` pe `planning-handlers.ts` + modulele de export + componente + pagini (loturi) | PASS; `registry.ts`/`testing.ts`/rute: NOT RUN local (memorie), în CI |
| E2E (`planning.spec.ts`: Excel/PDF din `/transactions`, cardul contabil din `/receipts`) | SCRIS; NOT RUN local (cere `next build`); în CI |
| `eslint`, `pnpm test` complet, `next build` | NOT RUN local (memorie); în CI |
| Consum măsurat: Excel 20.000 × 10 coloane / 50.000 / PDF 3.000 | ≈ 133 MB, 240 MB, 57 MB RSS; 1,0 s, 2,8 s, 0,5 s |

#### 3. Decizia mea

- Scriitori proprii în loc de dependențe (ADR 0024 §1); un singur font, fără grafice.
- Plafoane după consumul măsurat (`finet-web` are 512 MB): Excel 20.000, PDF 3.000, CSV 50.000.
- TVA calculat din linii, cu coloane de control; liniile fără cotă nu se estimează.
- Suma are semn la tranzacții (cheltuieli și transferuri de ieșire negative).

#### 4. Puncte deschise

- PDF/Excel nedeschise în cititoare reale desktop (Acrobat, Excel); formatul contabil nu a fost validat de un contabil: coloanele și rotunjirea sunt decizia mea.
- Pagină `/export` proprie: neimplementată (butoanele stau pe paginile datelor).
- Revizuirea `security` a F10-C: neefectuată (a existat doar revizuirea automată pe commit: dialect CSV necunoscut, corectat).
- Excel/PDF pentru bonuri se leagă de cotele citite pe linii: calitatea defalcării depinde de citirea bonului.

#### 5. Pe producție

`docs/INFRA.md`, secțiunea **4q**. Fără migrație; doar redeploy `finet-web`. Nimic nu s-a aplicat.

### Partea 2 — „Întreabă FINET” și rezumatul lunii

#### 1. Ce s-a implementat

- **„Întreabă FINET”** (`src/modules/ask`): set închis de interogări (Zod strict), parser determinist pentru română (perioade, metrică, categorie, comerciant), executor sub RLS, `POST /api/v1/ask`; răspunsul arată interogarea folosită, iar o întrebare neînțeleasă primește un motiv fix (nu se ghicește). Pagina `/ask` cu exemple.
- **Rezumatul lunii** (`src/modules/summary`): propoziții construite în cod din raportul lunar și cel al lunii precedente; `GET /api/v1/summary/monthly`; card pe `/reports`; eticheta fixă „Rezumat automat, nu sfat financiar.”.
- **Documentație:** ADR 0025, API.md, INFRA 4r, ROADMAP, SECURITY_CHECKLIST §28, PRIVACY_NOTES.

#### 2. Decizia mea — și diferența față de master prompt

Master prompt-ul cere un **LLM local** pentru ambele funcții. Nu există LLM local, iar `finet-web` nu are acces la LiteLLM (configurația AI e doar pe worker). Am livrat nucleul determinist și **am amânat pasul cu LLM** (ADR 0025 §2): interogarea are exact forma pe care ar produce-o un model, deci un traducător se adaugă fără să schimbe executorul sau interfața. Costul: întrebări doar în formulările recunoscute; rezumatul e mai sec. Avantajul: nimic nu pleacă din aplicație, întrebările nu se păstrează, fără migrație.

#### 3. Teste rulate local (2026-10-30)

| Comandă | Rezultat |
|---|---|
| `vitest run src/modules/ask src/modules/summary src/app/api/v1/ask-api.test.ts` (cu PG) | PASS (10 + 5 + 13 teste) |
| `vitest run src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/_lib src/app/smoke.test.ts` | PASS |
| `node scripts/openapi.mjs --check` | PASS |
| `tsc --noEmit` pe modulele, handlerele, pagina `/ask`, `/reports` și spec-ul E2E | PASS |
| E2E (`e2e/ask.spec.ts`: întrebare înțeleasă, neînțeleasă, exemplu, rezumat, CSP) | SCRIS; NOT RUN local; în CI |
| `eslint`, `pnpm test` complet, `next build` | NOT RUN local (memorie); în CI |

#### 4. Puncte deschise

- Pasul cu LLM (variantele din ADR 0025 §2) și migrația `0019`: decizia operatorului.
- Parserul acoperă formulări apropiate de exemple; ce nu recunoaște primește „nu am înțeles”. Calitatea pe întrebări reale: neevaluată.
- Revizuirea `security`; CSRF pe `POST /ask` fără test dedicat; performanța pe volume mari: nemăsurată.
- Fără axe pe `/ask` în `e2e/a11y.spec.ts`.

#### 5. Pe producție

`docs/INFRA.md`, secțiunea **4r**. Fără migrație; doar redeploy `finet-web`. Nimic nu s-a aplicat.

