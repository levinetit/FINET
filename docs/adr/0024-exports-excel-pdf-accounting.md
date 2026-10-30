# ADR 0024: exporturi Excel și PDF, export pentru contabil

- **Stare:** propus (F10-C, partea 1, branch `phase/10-exports`). Fără migrație și fără variabile noi: se aplică doar prin redeploy (`docs/INFRA.md`, „4q”).
- **Legături:** master prompt Faza 10 („Export Excel și PDF”, „Export pentru contabil”), 5.1 (bani), 5.3 (CSV); ADR 0007 (exporturile CSV din Faza 3), 0016–0017 (vizibilitatea conturilor personale), 0023 (regula bonurilor confirmate vizibile), 0021 (audit fără conținut).
- **Partea 2 a F10-C** („Întreabă FINET”, rezumatul lunii) are ADR propriu.

## Context

Faza 3 are exporturi CSV pentru tranzacții, obiective și bugete. Faza 10 cere Excel și PDF pentru aceleași date și un export pentru contabil pe bonuri. Nu există în repo o bibliotecă pentru Excel sau PDF, iar fiecare dependență nouă adaugă suprafață de atac (parsare, lanț de aprovizionare) pentru ceva ce se scrie în câteva sute de rânduri.

## Decizii

### 1. Fără dependențe noi: scriitori proprii, mici, verificați cu cititoare independente

- **Modelul comun** (`src/lib/export-table.ts`): un `ExportTable` (titlu, rânduri de context, coloane tipate `text|int|money|date|percent`, rânduri, totaluri opționale). Sumele sunt șiruri zecimale EXACTE calculate din unități minore `bigint`; nicio sumă nu trece prin float. `assertTable` refuză tabelele malformate.
- **Excel** (`src/lib/xlsx.ts`): Office Open XML într-un ZIP cu `node:zlib` (deflate, CRC-32 propriu). O foaie, texte inline (o celulă de text nu e niciodată formulă, deci nu e nevoie de apostroful CSV), sume numerice cu format `#,##0.00`, date ca serii Excel, antet înghețat, filtru automat. Caracterele interzise în XML 1.0 se elimină (altfel Excel refuză fișierul); numele foii e curățat (≤ 31 de caractere, fără `[]:*?/\`). Determinist (data din arhiv e fixă). **Verificat** cu `openpyxl` (încărcare, tipuri, formula rămasă text) și, în test, cu `zipfile` + `ElementTree` din Python când există.
- **PDF** (`src/lib/pdf.ts`): A4, antet repetat, numerotarea paginilor, text care se rupe pe maximum 3 rânduri cu „…”. Font Helvetica din cele 14 standard (fără font încorporat). Diacriticele românești lipsesc din WinAnsi, deci fontul are o codificare proprie (`/Differences`: `abreve`, `scommaaccent`, `tcommaaccent` pe coduri libere) și o hartă `/ToUnicode` (altfel cititoarele extrag `ţ` cu sedilă în loc de `ț`). Lățimile sunt cele Adobe Helvetica (AFM) pentru ASCII, litera de bază pentru cele accentuate. **Verificat** cu `pdf.js` (`unpdf`: textul extras păstrează diacriticele și sumele) și vizual (randare cu poppler). Limite cunoscute: fără bold, fără grafice, un caracter fără glifă devine `?`.
- Ambele module sunt `server-only`: nu intră în pachetul clientului (bugetul First Load JS rămâne neatins).

### 2. Aceleași reguli ca CSV-ul: RLS, filtre, audit, protecția la cerere

Exporturile `.xlsx` și `.pdf` pentru **tranzacții, obiective, bugete** folosesc aceeași citire sub RLS și aceleași filtre ca CSV-ul (`transactionBatches` e acum comună), aceeași gardă `Sec-Fetch-Site` pentru cookie, aceeași limită de cereri (`api_export`) și același audit `export.downloaded`, la care se adaugă `metadata.format` (`xlsx`/`pdf`); CSV-ul își păstrează forma `{kind, rows}`. Auditul nu conține conținut. Numele fișierelor sunt fixe.

- **Plafoane (măsurate, `finet-web` are 512 MB):** CSV 50.000 de rânduri; Excel 20.000 (10 coloane: ~133 MB RSS și ~1 s; la 50.000 ar fi ~240 MB și 2,8 s); PDF 3.000 (~57 MB, 0,5 s). Peste plafon: 409 `export_too_large`, fără conținut parțial.
- **Semnul sumelor:** la tranzacții, suma are semn (cheltuielile și transferurile de ieșire sunt negative); fiecare rând își păstrează moneda, nu se convertesc și nu se însumează monede.

### 3. Exportul pentru contabil (CSV și Excel) și lista bonurilor (Excel și PDF)

Formatul e FIX și documentat; un rând per bon CONFIRMAT, pe o perioadă obligatorie (`from`, `to`, cel mult 1.100 de zile; cel mult 50.000 de bonuri la CSV, 20.000 la Excel, 3.000 la PDF).

- **Vizibilitate:** `confirmedVisibleReceipts` (F10-B): bonul unui cont personal al altui membru nu apare; bonurile neconfirmate nu apar.
- **Ce stochează baza:** bonul are TVA-ul TOTAL; fiecare linie are cota ei și valoarea BRUTĂ. Defalcarea pe cote nu e stocată, deci se **calculează**: liniile se grupează pe cotă (reducerile sunt linii negative), TVA = `brut × cotă / (100% + cotă)` rotunjit o singură dată pe grup (jumătățile în sus în valoare absolută), baza = brut − TVA.
- **Coloane:** data, numărul bonului, comerciant, CUI, moneda, bază și TVA pentru cotele 0/5/9/11/19/21 %, „altă cotă” (bază, TVA), „brut fără cotă”, TVA calculat, TVA pe bon, **diferența de TVA**, total linii, total bon, **diferența de total**, cont, categorie, id FINET. Codurile coloanelor din CSV sunt stabile (ASCII).
- **Liniile fără cotă citită nu se estimează:** valoarea lor brută merge în „brut fără cotă”, iar diferența de TVA rămâne goală pentru acel bon. Diferențele sunt coloane de CONTROL, nu corecții: nicio valoare nu se ajustează ca să iasă zero (accentuează erorile de citire a bonului, ca să le vadă contabilul și utilizatorul).
- **Totaluri:** rând de totaluri doar dacă toate bonurile au aceeași monedă.
- **Lista bonurilor** (Excel/PDF) = aceleași rânduri fără defalcarea pe cote.
- **CSV:** aceleași reguli ca în Faza 3 (BOM, CRLF, protecție contra formulelor pe textul liber, dialect `rfc4180`/`ro`); dialectul necunoscut → 400 (revizuirea de securitate a F10-C).

### 4. Interfață

Butoane „Export Excel” și „Export PDF” lângă „Export CSV” pe `/transactions`, `/goals`, `/budgets` (cu aceleași filtre); pe `/receipts`, cardul „Export pentru contabil” cu perioada (implicit luna anterioară) și patru descărcări (contabil CSV/Excel, lista bonurilor Excel/PDF). Perioada nevalidă ascunde butoanele.

## Consecințe și alternative respinse

- O bibliotecă pentru Excel/PDF: respinsă (dependență nouă, suprafață mare, cod mult mai mare decât nevoia). Costul: un singur font (Helvetica), fără stiluri avansate; PDF-ul e pentru citire.
- Defalcare pe cote în baza de date: respinsă (ar cere migrație și date pe care bonul nu le conține); calculul din linii e verificabil prin coloanele de control.
- Excel cu mai multe foi: amânat (o foaie e suficientă pentru formatul fix).
