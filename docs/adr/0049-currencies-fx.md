# ADR 0049: HUF și GBP, cursurile BCE și conversia doar pentru afișare

- **Stare:** propus (modernizare 2026, pasul K din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`).
- **Legături:** migrația `0029_currencies`, `src/db/schema/fx.ts`, `src/lib/money.ts`, `src/lib/fx.ts`, `src/modules/fx/` (parserul BCE, serviciul), `src/worker/fx/fx-jobs.ts`, `GET /api/v1/fx/rates`, `approxForPage` (dashboard, conturi, avere netă); ADR 0004 (banii în bigint), ADR 0007 (totaluri separate pe monedă).

## Context

Master prompt-ul cere RON, EUR, USD, HUF, GBP, o monedă de bază configurabilă, cursuri istorice, conversie corectă fără erori de virgulă mobilă și rapoarte istorice. FINET avea trei monede, totaluri strict separate pe monedă și nicio sursă de cursuri; lista de monede era repetată literal în 18 CHECK-uri din bază.

## Decizii

1. **Două monede noi, aceeași regulă:** `CURRENCIES` și `DB_CURRENCIES` primesc HUF și GBP (ambele cu 2 zecimale ISO 4217; forintul ca exponent oficial, nu ca practică a monedelor), iar cele 18 CHECK-uri de monedă sunt rescrise în `0029_currencies` cu lista veche inclusă (DROP + ADD, rândurile existente rămân valide). Sumele rămân `bigint` în moneda lor; nicio sumă nu se convertește la stocare.
2. **Moneda de bază = `households.default_currency`** (există din Faza 1); nu se adaugă o coloană nouă. Conversia e **doar pentru afișare**: linia „≈ X în total, la cursul BCE din <zi>” sub totalurile pe monedă (dashboard, conturi, averea netă), doar când există cel puțin două monede și cursuri disponibile; monedele fără curs sunt listate ca lipsă, nu ghicite. Rapoartele, bugetele, scorul, prognoza rămân pe monedă (ADR 0007/0045): un buget în EUR nu se compară cu cheltuieli în RON.
3. **Sursa cursurilor: Banca Centrală Europeană** (baza EUR, XML public, fără cheie, fără date personale în cerere), descărcată de worker o dată pe zi (17:30 Europe/Bucharest, după publicarea BCE) și la pornire; prima rulare ia istoricul pe 90 de zile. Pornită doar cu `FX_RATES=1` (implicit oprit: nicio cerere externă). Gazda e fixă (`www.ecb.europa.eu`, HTTPS, fără redirecționări, corp plafonat la 2 MiB, termen 15 s). De ce nu BNR: BNR publică și ea XML, dar BCE acoperă toate cele patru monede străine într-un singur fișier, cu aceeași bază; o sursă secundară (BNR pentru RON) rămâne o extensie posibilă (`fx_rates.source`).
4. **Stocarea:** `fx_rates (rate_date, currency, rate_micro, source, fetched_at)`, `rate_micro` = curs × 1.000.000 ca întreg (BCE publică ≤ 5 zecimale), fără EUR (1.000.000 implicit), date de referință globale cu FORCE RLS (citire pentru orice utilizator autentificat, scriere doar prin upsert, fără DELETE). Istoricul rămâne: `GET /api/v1/fx/rates?date=` dă cursurile cele mai recente ≤ ziua cerută (rapoarte istorice).
5. **Aritmetica conversiei** (`src/lib/fx.ts`): `valoare_to = sumă × rate_to × 10^d_to / (rate_from × 10^d_from)`, în `bigint`, rotunjire la unitatea minoră cu jumătățile departe de zero; orice pereche trece prin EUR; același mecanism pentru cursul direct afișat cu 4 zecimale. Fără float nicăieri.
6. **Limbile** rămân pe decizia din 2026-11-01 (aplicația în română; paginile publice multilingve); formatarea sumelor folosește `Intl.NumberFormat("ro-RO")` cu codul monedei (HUF → „Ft”, GBP → „£”).

## Consecințe

- Migrația `0029_currencies` rescrie 18 CHECK-uri (lock scurt pe fiecare tabel); testată în CI (migrații de două ori, restaurare). Pe producție doar cu fraza operatorului; `FX_RATES=1` în `finet.worker.env` e opțional și separat.
- Extracția AI a bonurilor acceptă acum și HUF/GBP în schema răspunsului; parserele de extrase nu se schimbă (băncile RO nu emit în HUF/GBP; CSV-ul mapat acceptă orice monedă din listă).
- Android primește monedele noi în `/api/v1/accounts` și poate afișa `≈` folosind `GET /api/v1/fx/rates` (fără calcule proprii peste bigint; sumele mari rămân sub 2^53 în JSON).
- Rămân deschise: moneda de bază per utilizator (azi per gospodărie), conversia în rapoartele lunare (opțional, cu cursul lunii), sursa secundară BNR, alertă când cursurile sunt mai vechi de 7 zile (worker oprit).
