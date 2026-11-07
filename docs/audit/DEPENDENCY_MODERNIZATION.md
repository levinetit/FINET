# FINET — modernizarea dependențelor (2026-11-07)

Pasul B din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`. Metoda: `pnpm outdated` și `pnpm audit --prod` în containerul Node 24 (`pnpm install --frozen-lockfile` pe `d78d601`), notele de lansare ale fiecărui pachet major, apoi `pnpm lint`, `pnpm typecheck`, `pnpm test` (1.925 de teste, PostgreSQL 17 efemer) după fiecare lot. Build-ul de producție, E2E și imaginile se verifică în CI pe PR #81.

Stare la început: `pnpm audit --prod` → **0 vulnerabilități**; nimic blocant.

## 1. Actualizate în acest branch (patch/minor, fără schimbări de API)

| Pachet | De la → la | Motiv / verificare |
|---|---|---|
| `better-auth` | 1.7.13 → **1.7.18** | 1.7.16 conține corecții de securitate relevante pentru FINET: sesiunile revocate rămâneau utilizabile cu cache de cookie (FINET nu folosește cookie cache, dar revocarea „toate sesiunile” e expusă în `/profile`); linkurile de verificare/schimbare email legate de contul corect; `email_verified` din OAuth ca șir. 1.7.17–18: corecții la revocare și `getTestInstance`. API-ul folosit de FINET (adaptorul Drizzle, `bearer`, magic link, `storeToken: "hashed"` pentru verificări, Google) e neschimbat. **L6** (tokenul de resetare în clar): opțiunea `storeToken: "hashed"` rămâne doar pe verificările de email; resetarea parolei încă n-are opțiune în 1.7.x — rămâne deschis. |
| `jose` | 6.2.13 → 6.2.15 | patch; verificarea JWT Access (`src/lib/access.ts`). |
| `nodemailer` | 10.2.1 → 10.3.1 | minor; un singur loc (`src/modules/auth/mailer.ts`, `createTransport` + `sendMail`). |
| `next`, `eslint-config-next` | 16.4.3 → 16.4.5 | patch. |
| `pg-boss` | 12.38.0 → 12.38.1 | patch; schema `pgboss` e creată de operator (ADR 0011) și nu se schimbă la patch. |
| `tailwindcss`, `@tailwindcss/postcss` | 4.3.3 → 4.3.4 | patch. |
| `vite` | 8.3.5 → 8.3.6 | patch (dev). |
| `vitest`, `@vitest/coverage-v8` | 5.0.5 → 5.1.0 | minor (dev). |
| `@playwright/test` | 1.64.1 → 1.65.0 | minor (dev); CI reinstalează Chromium la fiecare rulare. |
| Acțiuni GitHub | `upload-artifact` 5 → 7.0.2, `setup-buildx-action` 3 → 4.4.1, `build-push-action` 6 → 7.4.0, `fetch-metadata` 2.5.0 → 3.1.0, `checkout` 7.0.1, `setup-node` 7.1.0, `setup-java` 6.2.0, `claude-code-action` 1.0.269 | majorele sunt treceri pe runtime-ul Node 24 al runner-ului; toate pinuite pe SHA (pasul A). Închid PR-urile Dependabot #65, #67, #68, #79. |
| `node` (imagine) | `24.22.1-bookworm-slim` | neschimbat ca versiune; fixat pe digest `sha256:be8204d4…` (pasul A). |
| `pnpm` | 12.15.0 | neschimbat; `packageManager` are acum hash-ul `sha512` generat de `corepack use`. |

Rezultat: lint, typecheck și suita Vitest verzi local (vezi raportul final pentru cifre); CI pe PR #81.

## 2. Evaluate, NEaplicate (major, cu plan)

### `postgres` 3.4.9 → 4.1.0 (PR Dependabot #73)
Driverul bazei (14 importuri; clientul comun în `src/lib/db-client.ts`, Drizzle peste el, testele cu `postgres()` direct, `pg-boss` cu propriul driver `pg`).

Schimbări relevante (note de lansare v4.0.0, 2026-10-29):
- **`infer: false` implicit**: serverul decide tipul fiecărui parametru. Un `Date` scris într-o coloană `timestamp` (fără fus) e luat ca UTC. FINET folosește `timestamptz` (`withTimezone: true`) și `date` ca text (`mode: "string"`): neafectat în principiu, dar interogările brute cu `${date}` fără cast (ex. `processingStartedAt < ${staleBefore}::timestamptz` are cast; altele trebuie inventariate) pot schimba semantica. `infer: true` păstrează comportamentul v3.
- `sql.array()` eliminat: **nefolosit** în FINET (verificat).
- Doar ESM: FINET e `"type": "module"`; uneltele din `dist/tools/*.mjs` sunt împachetate cu esbuild (de verificat că bundling-ul nu cere CommonJS).
- Două corecții de securitate (NUL în parametrii de conectare; coloană `__proto__`) marcate „also in v3”, dar **nu există 3.4.10 pe npm** (ultima 3.x = 3.4.9). FINET nu construiește URL-uri de conectare sau aliasuri de coloane din intrări ale utilizatorului, deci nu e expus.
- v4.1.0 adaugă `query_timeout` (util pentru `/api/health` și worker) și `sql.batch`.

Plan: ramură separată `deps/postgres-4` după ce branch-ul de modernizare e merge-uit: `infer: true` la început (echivalent v3), suita completă + `perf.test.ts`, apoi inventarul parametrilor `Date` din SQL brut și trecerea la `infer: false`. Nu se face în același PR cu funcțiile noi (izolarea cauzei unei regresii).

### `unpdf` 1.9.1 → 2.1.0 (PR Dependabot #69)
Folosit în procesele copil ale workerului (`pdf-child.mjs`: `getDocumentProxy`, `extractText`, `extractImages`; `pdf-items-child.mjs`: `getDocumentProxy`) și în teste/exporturi (citirea PDF-urilor generate).

Schimbări (v2.0.0, 2026-10-28): doar ESM, Node ≥ 24 (FINET: da); `extractImages` întoarce acum **toate** imaginile (inclusiv inline și măști) ca RGBA cu 4 octeți/pixel, fără `channels`, cu `bounds`; `configureUnPDF` → `definePDFJSModule` (nefolosit); `renderPageAsImage` întoarce `Uint8Array`. 2.0.1/2.1.0: decodoare de imagini (CCITT, JBIG2, JPEG 2000) în orice runtime și `registerImageDecoders`.

Impact: `pdf-child.mjs` consumă `extractImages` (canalele, dimensiunile) pentru bonurile PDF din poze: codul trebuie adaptat la RGBA și la imaginile inline (care pot fi multe și mici → filtrare după `bounds`). Plan: ramură `deps/unpdf-2` cu `pnpm eval:receipts` pe fixture-urile sintetice și testele `pdf-sandbox`/`pdf-items-sandbox`; limitele `prlimit` se re-măsoară (decodoarele noi pot crește memoria procesului copil).

### `eslint` 9 → 10, `typescript` 6 → 7, `@types/node` 24 → 26
- ESLint 10: `eslint-config-next` 16.4 declară ESLint 9; se așteaptă suportul în `eslint-config-next`.
- TypeScript 7 (compilatorul nativ): `next build` 16.4 nu îl acceptă încă pentru typecheck-ul integrat.
- `@types/node` 26: runtime-ul e Node 24 (`.nvmrc`, `engines`, decizia operatorului din 2026-10-31). PR #71 rămâne închis până la trecerea la Node 26.

### Docker / devcontainer (PR #64, #66)
- `axllent/mailpit` v1.32 → v1.33 (doar devcontainer): sigur, se poate merge-ui prin auto-merge-ul de patch (nu e patch; manual).
- `postgres:17-alpine` → `18-alpine` în devcontainer: **nu** înaintea schimbării `ops/postgres/VERSION` (Supabase rulează 17; `pg-next` validează deja 18).

## 3. Reguli de întreținere (din acest pas)
- Patch-urile intră prin auto-merge (ADR 0043); `better-auth`, `postgres`, `drizzle-*` rămân manuale, cu citirea notelor de lansare pentru fiecare versiune (nu doar ultima).
- `pnpm audit --prod --audit-level high` e blocant în CI; o vulnerabilitate tranzitivă fără remediere se tratează prin `pnpm.overrides` + notă aici, nu prin `continue-on-error`.
- Acțiunile GitHub se actualizează pe SHA (Dependabot păstrează comentariul de versiune).
- Imaginea de bază: la fiecare schimbare de tag se actualizează și digestul (`docker buildx imagetools inspect`).
