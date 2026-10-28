# ADR 0010 — Stabilizare: recuperarea după deploy, măsurători, accesibilitate de bază (Faza 4)

- **Stare:** propus (F4, branch `phase/04-stabilization`). Aplicarea `0005` pe Supabase și redeploy-ul: operatorul (`docs/INFRA.md` 4f).
- **Legături:** master prompt Faza 4 (7), 5.2, 5.3, 6.3, 6.4, 8; ADR 0005 (API), 0006 (UI registru), 0007/0008 (planificare); `docs/PERFORMANCE.md`; `docs/research/rea-finpulse-day-20261028/comparatie-finpulse-finet.md` (rândul 12).

## Context

Fazele 1–3 sunt în producție. Rămăseseră amânate: pagina `global-error` proprie, formatul datelor diferit între paginile Fazei 2 („28 oct. 2026”) și ale Fazei 3 („28.10.2026”), filtrul de etichete doar „oricare”, programarea curățării cheilor de idempotență. Lipseau măsurători (mărimea JavaScript-ului, interogările pe volum) și testele de regresie din analiza finpulse (cereri către terți, prefetch RSC fără sesiune). Hostul are sub 1 GB RAM liber: build-ul și E2E nu rulează local.

## Decizii

### Recuperarea după un deploy (chunk-uri vechi)

- Logica de decizie e pură (`src/app/_lib/chunk-recovery.ts`), testată în mediul `node` al Vitest: **fără jsdom** (nicio dependență nouă).
- Detectare: `ChunkLoadError`, mesajele de import dinamic eșuat (webpack, Turbopack, Chrome, Firefox, Safari), eroarea de încărcare a unui `<script>`/`<link rel=stylesheet>` din `/_next/static/` de pe propriul domeniu (ascultător `error` în faza de captură), `unhandledrejection`. O eroare de chunk la navigarea în aplicație ajunge la boundary (`error.tsx`), nu la `window`: `error.tsx` și `global-error.tsx` apelează aceeași funcție.
- Reîncărcare **cel mult o dată la 8 secunde**: momentul ultimei reîncărcări în `sessionStorage` (scris și recitit ÎNAINTE de `location.reload()`). Dacă stocarea aruncă sau lipsește → **banner, nu reîncărcare** (fără marcaj, o buclă n-ar putea fi oprită). Un ceas dat înapoi = „prea curând”.
- Formulare necomise: la primul `input`/`change` dintr-un formular (în afară de cele `method="get"`: filtre, selectorul de lună), formularul primește `data-dirty`; atributul rămâne până la `reset` sau până formularul dispare din pagină (**decizia mea**: nu se scoate la `submit`, ca un formular de editare rămas pe pagină după o eroare de salvare să fie protejat; costul: uneori banner în loc de reîncărcare). Cu un formular murdar: bannerul „Versiune nouă disponibilă. Salvează și reîncarcă.” (`role=status`, `aria-live`), cu butoanele „Reîncarcă pagina” și „Închide”.
- `global-error.tsx` propriu: `<html lang="ro">`, fără `style=` (CSP), în română, fără detalii tehnice, cu buton de reîncărcare; importă `globals.css`.

### Formatul datelor (5.3)

`formatCalendarDate` (registru) deleagă la `formatDate` (planificare): `zz.ll.aaaa` din cifre, fără `Intl` dependent de locale. Sesiunile din profil: `zz.ll.aaaa, HH:mm` (`Intl.DateTimeFormat('ro-RO')` cu `2-digit`, `h23`). Testul care fixa „5 ian. 2026” a fost actualizat la noul format cerut (nu slăbit). Sumele (`1.234,56 lei`, prin `money.ts`) și procentele întregi (`12%`) erau deja conforme.

### Filtrul de etichete `tagMatch=any|all`

- `GET /api/v1/transactions` și `GET /api/v1/exports/transactions.csv` (aceleași filtre): `tagMatch=any` (implicit, `EXISTS`) sau `all` (`id IN (SELECT transaction_id … GROUP BY … HAVING count(*) = N)`; corect fiindcă `tagIds` sunt distincte și `(transaction_id, tag_id)` e cheie primară).
- `tagMatch` fără `tagIds` → 400 `validation_failed` (**decizia mea**: o eroare explicită, nu ignorare tăcută). UI-ul trimite `tagMatch=all` doar cu etichete bifate; `any` nu se trimite (implicitul).
- UI: radio „Oricare / Toate” în filtrele `/transactions`, afișat de la două etichete în sus.

### Bugetul JavaScript

- `scripts/check-bundle-size.mjs`: First Load JS gzip per rută = runtime-ul (`build-manifest.json` → `rootMainFilesTree[<rută>]` sau `rootMainFiles`) + `entryJSFiles` din `.next/server/app/**/page_client-reference-manifest.js`, deduplicate; fără polyfill-uri `nomodule`, fără CSS. Varianta aleasă pentru Next 16: Turbopack (implicit) nu mai scrie `app-build-manifest.json`, iar formatul `page_client-reference-manifest.js` a fost verificat pe `.next` real (Next 16.4.3). Manifestul se citește ca JSON (fără evaluarea codului).
- Pragurile stau în `docs/PERFORMANCE.md` (blocul `json bundle-budget`): 190 KiB implicit, 180 KiB pentru `/login` și `/register`. Calibrate din prima rulare CI (pasul „Buget de mărime JavaScript”, după `pnpm build`, artefactul `bundle-size`): măsurat 152,9–165,4 KiB, prag = măsurat + ~15 % rotunjit la 10 KiB. Valorile inițiale din brief (250/150) erau provizorii; `/login` măsoară 155,7 KiB, deci 150 nu era realist.

### Performanța bazei și migrația `0005_perf_indexes`

- Test lent `src/db/perf.test.ts` (doar cu `FINET_PERF=1`): 50.000 de tranzacții pe 12 luni (+ 5.000 în altă gospodărie), măsurat ca `finet_app` cu RLS; planurile din `auto_explain` (doar pe baza de test) pe interogările reale, nu pe copii.
- Constatare: indexul `transactions_household_occurred_idx` (`DESC NULLS LAST`) nu poate da ordinea listei (`DESC` = NULLS FIRST implicit) → `Seq Scan` + sortare la fiecare pagină. `0005` adaugă `transactions_household_date_idx (household_id, occurred_on DESC, id DESC)` (generat de drizzle-kit din schemă, deci un `db:generate` viitor nu îl șterge). Prima pagină: 84 ms → ~2 ms în plan, 116 → 16 ms în serviciu. Cifrele complete: `docs/PERFORMANCE.md` 2.
- Jurnalul: `when = 1793300000000` (> `0004`, altfel runner-ul refuză ordinea; drizzle-kit a generat un `when` mai mic, din ceasul real, și a fost corectat de mână).
- Indexul vechi rămâne (**decizia mea**, conservatoare: e folosit de agregările pe interval; o ștergere ar fi o migrație separată, aprobată).

### Accesibilitate de bază

- „Sari la conținut” (primul element focalizabil, vizibil la focus) → `<main id="continut" tabIndex={-1}>` în layout-ul autentificat; `nav` cu `aria-label` (exista).
- „Mai mult” (telefon): la deschidere focusul trece pe primul link; Escape închide și întoarce focusul pe buton.
- `prefers-reduced-motion`: animațiile și tranzițiile reduse global (`globals.css`).
- Contrastul tokenilor, ambele teme, calculat din `globals.css` (`src/app/contrast.test.ts`): text ≥ 4,5:1, grafice ≥ 3:1. Singura pereche sub 4,5 (`warn` pe fundal, 4,48/4,08 în tema luminoasă) e folosită doar ca element grafic (`fill-warn`, `border-warn`), unde pragul e 3:1. Tokenii nu s-au schimbat.
- Titluri unice și `lang="ro"`: test static (`src/app/a11y-rules.test.ts`) + E2E (`e2e/regressions.spec.ts`).
- **Fără `@axe-core/playwright`** (**decizia mea**): E2E nu rulează local, iar verificările de mai sus acoperă criteriile cerute fără o dependență nouă; de reevaluat în Faza 9.

### Testele de regresie (finpulse)

Proiectul E2E nou `regressions` (server `next dev`, utilizatorul `e2e-regresii-<mod>`): (a) paginile publice cer doar resurse de pe propriul host; (b) prefetch RSC fără sesiune pe toate rutele din `src/app/(app)/**/page.tsx` (citite din fișiere, `[id]` = uuid aleator): un marcaj unic creat de utilizator lipsește, răspunsul e redirecționare la `/login` (antet sau, la 200, în fluxul RSC); cu sesiune marcajul apare (testul poate eșua); (c) titluri unice, `lang="ro"`, `main#continut`, „Sari la conținut” cu tastatura. Testul (b) NU rulează pe proiectul `access` (acolo totul e 403 de la Access și ar trece trivial).

## Consecințe

- O migrație nouă (`0005`), doar un index; RLS, politici și drepturi neschimbate.
- Un pas CI nou (blocant) după build; pragurile se ajustează după prima rulare.
- Un utilizator E2E nou (`regresii`) per mod în job-ul `e2e`.
- Nicio dependență nouă.
