# ADR 0046: averea netă — tipuri noi de cont și evaluări, fără instantanee

- **Stare:** propus (modernizare 2026, pasul G din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`).
- **Legături:** migrația `0027_net_worth`, `src/db/schema/net-worth.ts`, `src/modules/net-worth/`, `src/app/api/v1/_lib/net-worth-handlers.ts`, paginile `/net-worth` și `/accounts/[id]` (panoul de evaluări); ADR 0004 (registrul), ADR 0045 (scorul și prognoza, ajustate aici).

## Context

Master prompt-ul de modernizare cere averea netă (numerar, conturi bancare, economii, investiții, proprietăți, vehicule, credite, carduri, alte pasive), cu evoluție istorică și rapoarte lunare. FINET avea doar patru tipuri de cont (`cash`, `bank`, `savings`, `credit_card`), toate cu soldul din tranzacții, iar lista era închisă printr-un CHECK în bază. O proprietate sau un credit nu au tranzacții zilnice: valoarea lor se știe din evaluări periodice.

## Decizii

1. **Șase tipuri noi de cont** (`investment`, `property`, `vehicle`, `other_asset`, `loan`, `other_liability`), în aceeași tabelă `accounts`, cu CHECK-ul rescris (DROP + ADD, lista veche inclusă). Un cont rămâne un cont: nume, monedă, sold inițial, arhivare, vizibilitate personal/comun (RLS din ADR 0016) se aplică neschimbate. Fără tabelă nouă de „active”: un singur model pentru tot ce are valoare.
2. **Evaluări în `account_valuations`** (data, valoarea semnată ca un sold: activ pozitiv, pasiv negativ, notă, autor), legate de cont prin cheia compusă `(id, household_id, currency)`: aceeași gospodărie și monedă, garantat de bază; cel mult o evaluare pe zi și cont; fără UPDATE (greșeala se șterge și se reintroduce). RLS `ENABLE` + `FORCE`, politica cere contul vizibil cititorului. Valoarea curentă = evaluarea cea mai recentă; fără evaluare, soldul (soldul inițial e valoarea de pornire). Doar tipurile evaluate acceptă evaluări (altfel 400): soldul celorlalte vine din tranzacții.
3. **Fără instantanee stocate.** Istoricul lunar se recalculează din tranzacții (netul lunar pe cont, un singur query) și evaluări (cea mai recentă ≤ sfârșitul lunii), sub RLS-ul cititorului. Motive: (a) un instantaneu scris de worker ar trebui să aleagă „al cui” e (conturile personale ale altor membri sunt invizibile), (b) nu cere job nou, funcție SECURITY DEFINER nouă sau curățare, (c) rezultatul e reproductibil și corectabil retroactiv (o evaluare adăugată pentru iunie schimbă corect istoricul). Costul: 12 recalculări pe cerere, pe zeci de conturi, trivial. Dacă volumul o cere, se adaugă un cache, nu o sursă de adevăr paralelă. Soldul inițial e „fără dată” (ca în restul aplicației): un cont deschis azi cu sold inițial apare și în lunile trecute cu acel sold.
4. **Activele = valorile pozitive, pasivele = cele negative (în modul)**, indiferent de tip; gruparea pe tip e doar prezentare (`kind` așteptat). Separat pe monedă, fără conversie (ca ADR 0007/0045).
5. **Ajustări la ADR 0045:** prognoza pornește doar de la conturile tranzacționale (o proprietate nu e bani disponibili); componenta „datorii” a scorului numără doar datoriile pe termen scurt (soldurile negative ale conturilor tranzacționale: card, descoperit); creditele intră în averea netă, nu în raportul datorie/venit lunar (care ar fi lipsit de sens pentru o ipotecă).
6. **API:** `GET /api/v1/net-worth?months=` (1–60, implicit 12), `GET/POST /api/v1/accounts/{id}/valuations` (`Idempotency-Key` opțional, 409 `valuation_exists`), `DELETE /api/v1/accounts/{id}/valuations/{valuationId}`; audit `valuation.created`/`valuation.deleted` doar cu id-ul contului. OpenAPI: `NetWorth`, `AccountValuation`.
7. **Android:** aplicația primește tipurile noi în `/api/v1/accounts` (etichetele sunt ale clientului); ecranul de avere netă și formularul de evaluare sunt în planul Android (pasul M).

## Consecințe

- Migrația `0027_net_worth` e aditivă și idempotentă la re-rulare a runner-ului; testată în CI (migrații de două ori, restaurare). Pe producție se aplică doar cu fraza explicită a operatorului, cu backup înainte.
- Formularul de cont afișează tipurile noi; exporturile și statisticile existente le tratează ca pe orice cont (soldul = sold inițial + tranzacții, dacă există).
- Rămân deschise: conversia în moneda de bază (pasul K), gruparea activelor pe clase de risc, randamentul investițiilor (ar cere fluxuri de contribuție, nu doar evaluări).
