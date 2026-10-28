# ADR 0008 — Interfața planificării (Faza 3, F3-C)

- **Stare:** propus (F3-C: dashboard-ul, filtrele avansate, etichetele, bugetele, obiectivele, raportul lunar, exportul CSV din UI, navigarea, E2E `planning`).
- **Legături:** master prompt 3.4, 5.3, 5.4, 6.4, Faza 3; ADR 0006 (interfața registrului: citiri pe server, mutații prin API, CSP fără `style=`), ADR 0007 (serviciile și API-ul planificării).

## Context
Serviciile (F3-A) și API-ul (F3-B) există. Interfața trebuie să le facă folosibile zilnic (reperul v0.1 personal), cu aceleași reguli ca în Faza 2: citiri pe server prin servicii (`withMember` + RLS), mutații doar prin `/api/v1/*`, bani doar prin `src/lib/money.ts`, CSP cu nonce (fără `style=`), texte în `src/messages/ro.ts`, fără dependențe noi.

## Decizii

### Grafice fără bibliotecă (decizia mea)
- Graficele (`src/components/planning/charts.tsx`) sunt SVG scris de mână, randat pe server: bare orizontale pentru „Cheltuieli pe categorii”, bare verticale pereche (venit/cheltuială) pentru „Evoluție lunară” (12 luni) și „Trend zilnic”. Fără Recharts/Chart.js: nicio dependență nouă, niciun JavaScript în plus, nicio problemă cu CSP-ul (bibliotecile scriu des `style=`).
- Dimensiunile sunt **atribute** SVG (`width`, `height`, `x`, `y` pe `<rect>`), nu `style=`; scara e 0–100 în `viewBox` cu `preserveAspectRatio="none"`. Lungimea unei bare = `floor(|valoare| × 100 / max)` calculat cu `percentOf` (bigint) în `barLength` (`src/app/_lib/planning-ui.ts`), limitat la 100, cel puțin 1 pentru o valoare nenulă; maximul 0 → 0. Fără float pe sume.
- Culorile vin din tokeni (`fill-ok`, `fill-bad`, `fill-warn`, `fill-primary`, `fill-surface-2`), deci urmează tema luminoasă/întunecată cu contrastul din 3.4. Semaforul are mereu și text („În limită”, „Aproape de limită”, „Depășit”), nu doar culoare.
- Accesibilitate: fiecare grafic are titlu (`h3`), `role="img"` cu `aria-label`, legendă și un tabel cu aceleași date într-un `<details>` („Vezi datele ca tabel”, cu `caption`, `th scope`). Soldul net apare în tabelul evoluției, nu ca bară (ar cere o axă cu valori negative).
- Barele de progres (buget, obiectiv) sunt același SVG, cu `role="img"` și eticheta „<nume>: 85% folosit, Aproape de limită”; bugetul are și o linie la pragul de avertizare.

### Luna (`?month=YYYY-MM`)
- Paginile citesc serviciile direct, deci fereastra API-ului (60 de luni în urmă … luna curentă, `monthOf` din `planning-handlers.ts`) se aplică în pagină: `pageMonth` (`src/app/_lib/planning-page.ts`) calculează luna curentă în fusul gospodăriei (`resolveMonth`, ca API-ul), iar `pickMonth` (pur, testat) acceptă doar o lună validă în fereastră. **O lună invalidă, viitoare sau prea veche afișează luna curentă și un mesaj** („Luna cerută nu e disponibilă…”), nu o eroare (decizia mea: un link vechi salvat nu trebuie să dea 400 în UI). `MONTH_WINDOW_BACK` din UI e verificat în test egal cu cel din API.
- Selectorul (`MonthSelector`) e un formular GET cu ultimele 12 luni (o lună mai veche din URL apare și ea, ca selecția să rămână corectă) și un buton „Arată luna”: funcționează fără JavaScript, iar vederea se poate salva. Numele lunilor vin din `ro.planning.months`, nu din `Intl` (independent de locale-ul serverului).
- Datele noi se afișează `zz.ll.aaaa` (5.3) prin `formatDate` (din cifre). `formatCalendarDate` din Faza 2 („28 oct. 2026”) rămâne neschimbată pe paginile Fazei 2 (are un test care îi fixează forma); alinierea e o întrebare deschisă.

### Filtrele tranzacțiilor în URL
- Noi: `merchant` (doar comerciantul) și `tagIds` (oricare dintre etichetele bifate). Formularul GET trimite `tagIds` repetat; `parseFilters` acceptă și forma API-ului (virgule), păstrează doar uuid-uri distincte, cel mult 10. Spre API (lista, „Încarcă mai mult”, exportul) pleacă **un singur** `tagIds=a,b` (`readQuery` refuză parametrii repetați). Etichetele ascunse nu se propun, dar una deja bifată rămâne în listă.
- **Textul liber (`q`, `merchant`) rămâne în URL** (decizia mea): vederile filtrate se pot salva și partaja (cerința Fazei 3), iar alternativa (`POST /transactions/search`) ar cere o rută nouă și ar pierde URL-ul salvabil. Riscul (LOW-3 din Faza 2, extins la `merchant`): aplicația nu loghează URL-uri, dar proxy-ul/Traefik/Cloudflare le pot înregistra; câmpurile au indiciul „Textul apare în adresa paginii.”. Restul filtrelor sunt id-uri, date, sume și tipul.
- Sumele de filtru se parsează ca până acum (`parseAmountInput`, RON, ADR 0006) în `amountMinMinor`/`amountMaxMinor`.

### Exportul CSV din UI
- Butoanele („Export CSV” pe `/transactions` cu filtrele aplicate, pe `/budgets` pentru luna aleasă, pe `/goals`, plus cele trei din `/reports`) cer mereu `?dialect=ro` (`exportPath`). Exportul tranzacțiilor primește aceleași filtre ca lista, **fără `sort`** (`exportSearch`; ruta de export îl refuză; exportul e cronologic).
- Descărcarea e un `fetch` pe aceeași origine cu cookie-ul sesiunii (`src/app/_lib/download.ts`), nu un link cu token: răspunsul reușit devine `blob` + `<a download>` temporar (URL revocat după 10 s), numele fișierului din `Content-Disposition` doar dacă e un nume simplu. Erorile sunt JSON: 409 `export_too_large` și 429 (cu `Retry-After`) au mesaje clare; 401 → login. O singură descărcare în zbor per buton.

### Etichete pe pagină separată (decizia mea)
- `/tags`, intrare proprie în meniu: etichetele sunt a doua dimensiune, independentă de categorii (5.4), iar o secțiune în `/categories` ar amesteca două liste cu reguli diferite (categoriile au tip și reasignare la ștergere, etichetele culoare și număr de utilizări). Cele de sistem: doar ascundere/afișare; cele proprii: creare, redenumire, culoare (`<input type="color">` + „Fără culoare”), ascundere, ștergere cu confirmare (întrebarea spune pe câte tranzacții apare).
- Culoarea etichetei se desenează ca atribut SVG `fill` (validat `#rrggbb` și în client), nu ca `style=`.
- În formularul tranzacției: bife, cel mult 10 (celelalte se dezactivează la 10). La editare pagina încarcă etichetele curente (`getTransactionTagIds`), inclusiv cele ascunse, pentru că `tagIds` din `PATCH` **înlocuiește** lista; altfel salvarea le-ar scoate tacit.

### Bugete, obiective, confirmări
- Pagini separate, ca în Faza 2 (URL-uri directe, 404 uniform pentru id-uri străine): `/budgets`, `/budgets/new`, `/budgets/[id]`, `/goals`, `/goals/new`, `/goals/[id]`.
- Bugetul: la creare categoria (doar de cheltuieli; „General” = toate), limita, moneda, pragul (1–100, implicit 80), domeniul (`household|personal`); la editare doar limita și pragul (categoria, moneda și domeniul sunt blocate în UI și refuzate de schema strictă), plus arhivare/reactivare și ștergere.
- Obiectivul: nume, țintă, monedă (doar la creare), termen, cont opțional în aceeași monedă. Pe pagina obiectivului: contribuția („Adaugă” / „Scade”, direcția din butonul apăsat) cu `Idempotency-Key` **mereu** (obligatoriu pe server; o cheie nouă per acțiune, păstrată doar la reîncercarea aceluiași corp după rețea/5xx), abandonarea (cu confirmare) și reluarea (`PATCH status: "active"`). Acțiunile de pe loc nu folosesc `lockOnSuccess` (pagina rămâne deschisă), cele care pleacă din pagină da.
- „Dialogul” de confirmare la ștergere/abandonare e `ConfirmButton` din Faza 2 (al doilea clic, „Da, șterge”), nu un modal: fără componente noi și accesibil (`role="group"` cu întrebarea ca etichetă).

### Avertizarea bugetelor (decizia mea)
- Banner „Atenție la bugete” (câte bugete galbene/roșii în luna afișată, roșu dacă există unul depășit) pe **dashboard** și pe **`/budgets`**, din stările deja citite pentru lună. Nu în layout: layout-ul nu citește sesiunea (ADR 0006, fiecare pagină o verifică), iar o insignă în meniu ar cere o interogare la fiecare pagină.

### Dashboard și onboarding
- `/dashboard` (titlul „Acasă” rămâne): luna aleasă; pe fiecare monedă un card cu Venituri, Cheltuieli, Sold net, Tranzacții, fiecare cu săgeata și procentul față de luna anterioară („—” când luna anterioară are 0; procentul numărului de tranzacții tot prin `percentOf`); graficele; bugetele lunii cu semafor; obiectivele active; soldurile și ultimele tranzacții (Faza 2); gospodăria și rolul.
- **Onboarding în 3 pași**, afișat cât timp `onboarding.completed` e fals: (1) tranzacții — importul extraselor e în Faza 7, deci pasul spune „Import: în curând” și trimite la „Adaugă manual” (`/transactions/new?type=expense`); dacă nu există niciun cont, pasul devine „Adaugă un cont” (`/accounts/new`); (2) „Setează un buget” → `/budgets/new`; (3) „Creează un obiectiv” → `/goals/new`. Pașii făcuți rămân vizibili, marcați „Făcut”, până la completarea tuturor (decizia mea). Datele demo (6.4) nu sunt în această fază.

### Navigarea
- Desktop: meniul lateral cu toate paginile (Acasă, Tranzacții, Conturi, Categorii, Etichete, Bugete, Obiective, Rapoarte, Profil) și deconectarea. Telefon: bara de jos cu Acasă, Tranzacții, Bugete, Rapoarte și „Mai mult” (3.4 cere „Scanează” pe poziția a treia; scanarea vine în Faza 6, deci „Bugete” ține locul), iar „Mai mult” (`aria-expanded`, `aria-controls`, Escape închide) deschide celelalte pagini și deconectarea. Listele de desktop și de telefon nu sunt vizibile simultan, deci fiecare link apare o singură dată în arborele de accesibilitate.
- Eticheta meniului pentru dashboard rămâne „Acasă” (ca titlul paginii și 3.4).

### E2E și accesibilitate
- Proiectul Playwright `planning` (`e2e/planning.spec.ts`), utilizatorii `planning` și `planning2`, rulat în ambele moduri în CI. Scenarii: (a) dashboard cu date (totaluri comparate cu API-ul, comparația, selectorul, luna invalidă), (b) buget → verde/galben/roșu după cheltuieli, (c) obiectiv → contribuții până la „Atins”, chei distincte, retragerea peste sold refuzată, (d) etichetă din formular + filtrele pe etichetă și comerciant, (e) export CSV (BOM, antet, un rând, `dialect=ro`, doar filtrele paginii), (f) izolare (404 pe id-uri străine, nimic în liste, export gol), (g) CSP + fără `style=` pe paginile noi, (h) accesibilitate de bază: fiecare câmp are etichetă, focus vizibil la tastatură, meniul pe telefon.
- **Fără `@axe-core/playwright`** (decizia mea): ar adăuga o dependență și ar schimba lockfile-ul pe un host care abia instalează; verificările de bază sunt scrise de mână (titluri unice, etichete, focus), iar axe poate veni în Faza 4 (accesibilitate).

## Consecințe
- Fără migrații, fără rute API noi, fără dependențe noi. Fără variabile de mediu noi.
- Module noi: `src/app/_lib/{planning-ui,planning-page,download}.ts` (+ teste), `src/components/planning/{charts,summary,month-selector,export-button,tag-chip}.tsx`; `transaction-filters.ts` are `merchant`, `tagIds`, `exportSearch`; `ledger-options.ts` întoarce și etichetele.
- Rămân: alinierea datelor din paginile Fazei 2 la `zz.ll.aaaa`, axe în E2E, datele demo din onboarding, insigna de avertizare în meniu, filtrul pe etichete cu „toate” (azi „oricare”).
