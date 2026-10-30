# ADR 0023: prețuri pe produs și magazin, inflație personală, rapoarte de micro-cheltuieli ca date

- **Stare:** propus (F10-B, branch `phase/10-prices`). Deploy-ul îl face operatorul, după revizuiri (`docs/INFRA.md`, „4p”).
- **Legături:** master prompt Faza 10, 3.6 (alte folosiri ale LLM: aici NU se folosește LLM), 5.1 (bani), 5.2 (date locale), 5.5 (liniile bonului), 6.1 (modelul de date), 6.2 (RLS); ADR 0013–0015 (bonuri), 0016–0017 (familie, vizibilitatea conturilor), 0007–0008 (rapoarte și grafice SVG), 0021 (retenție, export GDPR). F10-A (liste de cumpărături, ADR 0022) și F10-C (exporturi, „Întreabă FINET”) sunt separate.
- **Migrația:** `0018_report_definitions` (`when` 1795000000000; `0017` e rezervată listelor de cumpărături; jurnalul se reconciliază la merge: ordinea …0014, 0017, 0018).

## Context

Faza 10 cere trei lucruri peste liniile bonurilor confirmate (`receipt_lines`): (1) prețul unui produs în timp și pe magazin, (2) o estimare a inflației personale, (3) rapoarte despre cheltuieli mărunte (pungi, garanția SGR, cumpărături de la casă…), definite ca DATE, pe care utilizatorul le poate copia și modifica. Constrângeri din fazele anterioare care contează aici:

- `receipt_lines` nu are coloană de unitate; are `normalized_name` (litere mici, fără diacritice, cu unitățile scrise uniform: `500g`, `1l`, `6buc`), `quantity numeric(12,3)`, `line_total_minor` (mereu ≥ 0; semnul îl dă `kind`) și `kind` (`product | discount | deposit_sgr | bag | other`). Cuvintele din brief (`item`, `deposit`) sunt tipurile MODELULUI de extragere (`MODEL_LINE_TYPES`); în bază sunt cele de mai sus: `item` → `product`, `deposit` → `deposit_sgr`.
- Pipeline-ul F6 pune `kind = bag` oricărei linii cu cuvântul `punga|pungi|sacosa|sacose|bag|plasa`, deci și «PUNGI MENAJ 35L» ajunge `bag` (`ruleKind`). Un raport «pungi» nu poate fi deci «`kind = bag`». Nu schimb codul F6; regula de nume a raportului (token + excluderi) face diferența.
- `receipts` și `receipt_lines` sunt vizibile tuturor membrilor gospodăriei, chiar dacă bonul e legat de un cont personal (ADR 0016, «amânat»). Legătura cu un cont este DOAR `receipts.transaction_id → transactions.account_id`.

## Decizii

### 1. Ce intră în calcule: bonuri confirmate, vizibile

Un bon intră dacă `status = 'saved'` (setat de `confirmReceipt`, odată cu `transaction_id`), `occurred_on` e cunoscut și este **vizibil** utilizatorului. Bonurile `needs_review`, `queued`, `failed` nu intră. Un bon confirmat explicit deși părea duplicat (`allowDuplicate`) intră: utilizatorul a spus că e altă cumpărătură.

**Vizibilitatea (conturi personale).** Filtrul este, într-o singură funcție folosită de prețuri, inflație, rulare, previzualizare și export (`confirmedVisibleReceipts` din `src/modules/prices/prices.repo.ts`):

```
receipts.transaction_id IS NULL
OR EXISTS (SELECT 1 FROM finet.transactions t WHERE t.id = receipts.transaction_id)   -- sub RLS-ul membrului
```

`transactions` are RLS pe cont (un cont personal e vizibil doar proprietarului), deci `EXISTS` e fals pentru bonul legat de contul personal al altui membru. NU se folosește `LEFT JOIN … IS NULL`: o tranzacție invizibilă ar semăna cu «fără tranzacție» și linia ar scăpa în agregat. Consecințe documentate:

- un bon **fără tranzacție** (tranzacția a fost ștearsă și legătura a devenit `NULL`, `SET NULL`) este tratat ca **comun**; el era deja vizibil tuturor membrilor în `/receipts` (ADR 0016);
- bonurile personale proprii intră în agregatele proprietarului, nu în ale celorlalți (testat: A, C și B văd totaluri diferite; `report-definitions.test.ts`, `prices-service.test.ts`, `prices-api.test.ts`);
- proiecția anuală folosește bonurile VIZIBILE ca acoperire (vezi 5), deci un bon personal al altuia nu influențează nici zilele acoperite.

Ce NU rezolvă F10-B: pagina `/receipts` rămâne cum era (vizibilă tuturor); bonurile personale ale altor membri nu apar în agregate, dar apar în lista de bonuri (amânare F8, neschimbată).

### 2. Unități și prețul pe unitate (funcții pure, `bigint`)

Unitatea se citește din `normalized_name` (`src/modules/prices/units.ts`):

- mărimi recunoscute: `kg`, `g` (masă), `l`, `cl`, `ml` (volum), `buc` (numărătoare), opțional cu multiplicator (`6x0.5l`, `6 x 0,5 l`);
- conversii DOAR între unități compatibile: `g → kg`, `cl, ml → l`; masa, volumul și numărătoarea nu se amestecă (cheia produsului poartă unitatea: `kg|cafea macinata`, `l|apa plata`, `buc|oua`);
- **fără mărime** (`banane`): prețul rămâne pe «unitatea de pe bon» (cheia `unit|banane`);
- **ambiguu → exclus** (nu ghicim, e numărat în `excludedLines`): două mărimi diferite (`apa 2l 6buc`), mărime ilizibilă (`0.5g`) sau produs cântărit al cărui nume repetă greutatea vândută (`banane 1.234kg` cu cantitatea 1,234);
- cheia de produs elimină mărimea: ambalajele diferite ale aceluiași produs (`cafea 250g`, `cafea 500g`) se compară pe kg;
- **monedele nu se amestecă**: orice grupare include moneda; nu există conversie valutară.

Prețul unei serii = **media ponderată cu cantitatea**: `Σ line_total / Σ (cantitate × mărime ambalaj)`, în bani pe kg / l / bucată, rotunjit jumătate în sus. Toate calculele pe `bigint`; cantitățile în miimi (ca `thousandths` din `checks.ts`). Exemple (testate în `units.test.ts`): 2 × lapte 1 L la 7,49 → 749 bani/l; 6 × apă 2 L la 2,29 → 13,74 lei / 12 l = 1,145 → 115 bani/l; cafea 500 g la 32,99 → 6598 bani/kg.

*Decizia mea (medie ponderată, nu mediană):* media ponderată se compune din sume (se poate agrega pe orice felie: lună, săptămână, comerciant) și rămâne exactă în `bigint`; mediana ar cere liniile individuale pe fiecare punct și e instabilă pe 2–3 observații. Prețul de raft vs. prețul plătit: se folosește suma liniei (cum apare pe bon), fără reduceri (liniile `discount` nu intră în prețul produsului).

### 3. Praguri de date

Sub prag, rezultatele NU se afișează (UI: «Nu sunt suficiente date»; API: `enough: false` și prețurile `null`).

| Constantă | Valoare | Unde | Parametru API |
|---|---|---|---|
| `PRICE_MIN_OBSERVATIONS` | 3 linii | `prices.ts` | `minObservations` (1–50) |
| `PRICE_MIN_MONTHS` | 2 luni distincte | `prices.ts` | `minMonths` (1–24) |
| `PRICE_MIN_MERCHANT_OBSERVATIONS` | 2 linii pe comerciant | `prices.ts` | – |
| `INFLATION_MIN_OBS_PER_PERIOD` | 2 pe perioadă și articol | `inflation.ts` | `minObservations` (1–20) |
| `INFLATION_MIN_ITEMS` | 5 articole | `inflation.ts` | `minItems` (1–50) |
| `INFLATION_MIN_MERCHANT_ITEMS` | 3 articole pe comerciant | `inflation.ts` | – |
| `PROJECTION_MIN_DAYS` / `PROJECTION_MIN_RECEIPTS` | 60 de zile / 10 bonuri | `run.ts` | – |

Fereastra implicită a prețurilor: ultimele 12 luni calendaristice (1–60, parametrul `months`), în fusul orar al gospodăriei.

### 4. Cel mai ieftin magazin

«Comerciant» = **CUI fără `RO`** dacă există, altfel numele normalizat (`n:` + litere mici); liniile fără niciuna intră în seria generală a produsului, dar nu în comparațiile pe comerciant. Cheia e lanțul (același CUI), nu magazinul fizic (`store_address` nu se folosește). «Cel mai ieftin» se calculează doar între comercianți cu cel puțin 2 observații, minim doi; rezultatul e comerciantul cu prețul mediu pe unitate cel mai mic, față de comerciantul unde cumperi cel mai des; se afișează diferența de preț pe unitate și în puncte de bază. **Nu se inventează economii:** nu se înmulțește diferența cu cantități viitoare.

### 5. Inflația personală

Pentru fiecare **articol** (produs normalizat × comerciant × monedă) cumpărat în AMBELE perioade, cu cel puțin 2 observații în fiecare:

- `P0` = prețul mediu ponderat pe unitate în perioada de bază, `P1` = în perioada curentă;
- raportul articolului `r = P1 / P0`; ponderea `w` = cheltuiala articolului în perioada de bază (`Σ line_total`);
- **indicele gospodăriei** `I = Σ w·r / Σ w − 1`, în **puncte de bază** (1 pb = 0,01 %), rotunjit jumătate dinspre zero; rapoartele au 9 zecimale pe `bigint` (nu există float);
- afișat doar cu cel puțin 5 articole; pe comerciant doar cu cel puțin 3; **acoperirea** = ponderea cheltuielii de bază acoperite de articolele folosite din toată cheltuiala de bază a monedei;
- ferestre: curentă = ultimele `months` luni (1–12, implicit 3, inclusiv luna curentă până azi); bază = `year_ago` (aceeași fereastră cu un an în urmă, implicit) sau `previous` (cele `months` luni imediat dinainte).

**Exemplu numeric** (testat în `inflation.test.ts`): A 10,00 → 11,00 lei (+10 %), cheltuială de bază 100 lei; B 5,00 → 5,00 (0 %), 50 lei; C 20,00 → 19,00 (−5 %), 40 lei. `I = (100·1,10 + 50·1,00 + 40·0,95) / 190 − 1 = 198 / 190 − 1 = 4,2105 %` → **421 pb**. Liniile fără comerciant nu intră (nu știm dacă e același magazin). Eticheta din UI și din API: «estimare din bonurile tale»; fără mesaje alarmiste, fără comparație cu indici oficiali.

### 6. Rapoartele de micro-cheltuieli: definiții în date (`report_definitions`)

**Tabelul** (`household_id` nullable, `name`, `description`, `rules jsonb`, `advice`, `is_system`, `archived`, `created_by_user_id`): `household_id IS NULL ⇔ is_system`; numele unic (fără diferență de litere) printre cele active ale gospodăriei și printre cele de sistem; cel mult 100 de rapoarte proprii (trigger cu lacăt consultativ, SQLSTATE `54000` → 409 `report_limit`); CHECK-uri plate (lecția Fazelor 3–9), verificate prin dump→restore (`migrate.test.ts`, amprenta schemei).

**RLS** (ENABLE + FORCE, politici pe comandă): `SELECT` — rândurile de sistem pentru orice utilizator autentificat, cele proprii doar pentru membrii gospodăriei; `INSERT/UPDATE/DELETE` — doar `household_id` = gospodăria curentă, ca membru, `NOT is_system` (rândurile de sistem nu au gospodărie, deci sunt neatinse), iar `INSERT` cere `created_by_user_id` = utilizatorul curent. Drepturile de coloană: `UPDATE` doar pe `name, description, rules, advice, archived, updated_at`.

**Regulile** (JSON versionat, `src/modules/report-definitions/rules.ts`, validat strict cu Zod; baza verifică doar forma și mărimea):

```
{ "v": 1, "combine": "all" | "any",
  "include": [{ "type": "exact|prefix|contains|token", "value": "…" }],   // 0–20
  "exclude": [ … ],                                                          // 0–20, «niciunul nu se potrivește»
  "kinds": ["product","bag","other","deposit_sgr","discount"],               // ≥ 1
  "categoryIds": [uuid, …],  "tagIds": [uuid, …] }                           // ≤ 10 fiecare
```

- doar AND/OR **plat** (`combine` între termenii `include`; `exclude` = SAU); fără paranteze, fără imbricare; valorile se normalizează la salvare cu `normalizeProductName` (litere mici, fără diacritice; «Pungă» ⇒ `punga`); 2–60 de caractere (`exact`: de la 1); `token` = cuvânt întreg (fără spații);
- **evaluare în cod, nu în SQL:** interogarea aduce liniile gospodăriei după tip/categorie/etichetă (parametri legați), iar potrivirea pe nume se face în funcții pure (`matchesName`), deci nu există interpolare de SQL, `LIKE` sau expresii regulate construite din date de utilizator. Plafon: 100.000 de linii citite pe cerere, altfel 409 `too_many_lines` (cod fix);
- filtrul pe etichetă = o etichetă pe TRANZACȚIA bonului; categoria = categoria liniei. Referințele se verifică la salvare (categoria/eticheta trebuie să existe în gospodărie); un id șters ulterior nu mai potrivește nimic.

**Rapoartele de sistem** (seed în migrație, înainte de RLS; id-uri fixe; oglindite de `SYSTEM_REPORTS` din `system-definitions.ts`; un test compară rândurile din bază cu constanta; se schimbă doar printr-o migrație nouă): *Pungi și sacoșe* (token `punga|pungi|sacosa|sacose`, exclude `menaj|gunoi|congelare|…`; «PUNGA RAFIE» intră, «PUNGI MENAJ 35L» nu), *Garanția SGR: plătită și recuperată* (`deposit_sgr` + `discount` cu `sgr|garantie|…`), *Cumpărături de la casă* (dulciuri, gumă), *Nealimentare la supermarket* (igienă, menaj), *Cafea și băuturi la bucată* (fără ambalajele mari), *Economii din reduceri și carduri* (linii `discount`, fără retururile SGR). Sunt puncte de plecare: potrivirea e pe nume și poate rata sau adăuga un produs; utilizatorul le copiază («Copiază și editează») și le ajustează, cu previzualizare. Sfaturile sunt texte fixe, fără sume de economie.

**Semantica sumelor:** `charged` = linii care costă (produs, pungă, garanție, altele), `credit` = linii `discount` potrivite, `net = charged − credit`. Titlul raportului este `net`; la rapoartele doar de reduceri (`mode = savings`) este `credit`. **SGR:** «plătite» = `deposit_sgr`, «recuperate» = liniile `discount` cu SGR în nume (bonul de retur folosit); diferența = garanții încă nerecuperate. O returnare la automat care nu apare pe bon NU se vede; textul raportului o spune. Bucăți = Σ cantitate a liniilor care costă; preț mediu pe unitate = `charged / bucăți`.

**Proiecția anuală** = `total · 365 / zile acoperite`, rotunjită; **zile acoperite** = intervalul dintre primul și ultimul bon confirmat VIZIBIL din perioadă (toate bonurile, nu doar liniile potrivite: o singură linie potrivită într-o săptămână de bonuri nu se extrapolează). Sub 60 de zile sau 10 bonuri: `status: insufficient` («date insuficiente»). Mereu marcată ca estimare.

**Perioade** (`period`, în fusul orar al gospodăriei, ca rapoartele existente): `all` (implicit), `this_month`, `last_month`, `last_3_months` (luna curentă până azi și cele două dinaintea ei), `this_year`.

### 7. API

`GET /api/v1/prices/products`, `GET /api/v1/prices/series`, `GET /api/v1/inflation`, `GET|POST /api/v1/report-definitions`, `POST /api/v1/report-definitions/preview` (adăugată față de brief: «previzualizare», nu salvează), `GET|PATCH|DELETE /api/v1/report-definitions/{id}`, `GET /api/v1/report-definitions/{id}/run`, `GET /api/v1/report-definitions/{id}/export.csv`. Zod strict (parametri necunoscuți sau repetați → 400), gospodăria din sesiune, 404 uniform, `Idempotency-Key` la creare, rate limit propriu `reportRun` (30/min per utilizator) pe rulare și previzualizare, exportul pe limita exporturilor (10/min) și gardă `Sec-Fetch-Site`, ca exporturile CSV existente; CSV cu BOM, CRLF și neutralizarea formulelor (`csv.ts`). Audit: `report.created|updated|deleted` (doar id) și `export.downloaded` (`kind: report`, număr de rânduri) — fără nume de raport, reguli sau produse. Rapoartele proprii intră în exportul GDPR (`rapoarte-micro-cheltuieli.json`).

### 8. Interfața

Pagina `/insights` («Rapoarte inteligente și micro-cheltuieli»), cu starea în URL (randare pe server, funcționează fără JavaScript): (1) rapoarte predefinite și proprii, cu perioade, total, cantitate, preț mediu, proiecție, grafic lunar SVG, istoric cu legătură la bon, sfat, export CSV; (2) generatorul pe articole (client): reguli include/exclude, tipuri de linii, filtre avansate, previzualizare, salvare; (3) prețuri (tabel, evoluție SVG) și inflație. Grafice proprii, fără bibliotecă (ADR 0008), cu tabel text; fără `style=`.

### 9. Performanță

Măsurat cu `src/db/perf-prices.test.ts` (`FINET_PERF=1`) pe ~50.000 de linii de bon (4.200 de bonuri confirmate pe 3 ani, 5 comercianți, 200 de produse, o parte pe un cont personal), ca `finet_app` cu RLS, pe un PostgreSQL 17 efemer cu 256 MB de memorie, pe aceeași gazdă cu alte servicii (mediana din 5 rulări / minim): prețuri pe 12 luni 6,7 s / 4,4 s, prețuri pe 3 ani 1,9 s / 1,7 s, inflație 0,9 s / 0,8 s, rapoarte rulate pe toată arhiva 0,13–2,0 s. **Nu sunt sub o secundă** pe acest volum; pragul testului este 10 s pe 3 ani. Diferența dintre 12 luni și 3 ani arată zgomotul gazdei (prima serie rulează la cald după încărcare): cifrele se reiau în CI sau pe Supabase înainte de a trage concluzii.

Planurile (`auto_explain`, `docs/INFRA.md` 4p) folosesc indecșii existenți (`receipts_household_status_idx`, `receipts_id_household_key`); costul principal este citirea celor ~50.000 de linii ale gospodăriei (`Seq Scan` pe `receipt_lines`, filtrat pe gospodărie) și sortarea lor (~200 ms, pe disc la 256 MB). Nu s-a adăugat niciun index. Pentru o gospodărie obișnuită (câteva mii de linii pe an) costul este proporțional mai mic. Dacă o gospodărie depășește 100.000 de linii în fereastra cerută, API-ul răspunde 409 `too_many_lines` (utilizatorul îngustează perioada).

## Consecințe și puncte deschise

- Potrivirea pe nume e euristică: produsele cu nume neobișnuite pot scăpa sau intra în plus (de aceea previzualizarea, copierea și istoricul cu link la bon).
- Ambalajele multiple cu mărimi diferite în același nume sunt excluse, nu ghicite; produsele cântărite fără mărime în nume se compară pe «unitatea de pe bon», nu pe kg.
- Conturile personale: agregatele le respectă; lista `/receipts` rămâne vizibilă tuturor membrilor (amânarea F8). Un bon personal ale cărui tranzacție se șterge devine comun.
- `PUNGI MENAJ` rămâne `kind = bag` în pipeline-ul F6 (regula `ruleKind`); raportul de sistem îl exclude pe nume. Dacă F6 va separa pungile de menaj, regula se poate simplifica printr-o migrație nouă.
- Rapoartele de sistem se actualizează doar prin migrații; versiunea constantei `SYSTEM_REPORTS_VERSION` crește la fiecare schimbare.
- Statistici cross-gospodărie (medii pe piață) nu există și nu se introduc (confidențialitate).
