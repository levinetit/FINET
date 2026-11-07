# ADR 0045: inteligență financiară — scor de sănătate, prognoză de cash-flow, consilier

- **Stare:** propus (modernizare 2026, pașii D–F din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`).
- **Legături:** `src/modules/health/`, `src/modules/forecast/`, `src/modules/advisor/`, `src/app/api/v1/_lib/intelligence-handlers.ts`, paginile `/health`, `/forecast`, `/advisor`; ADR 0007 (agregatele lunare), ADR 0011 (recurențele), ADR 0025/0026 („Întreabă FINET”, pasul LLM), `docs/audit/FINET_COMPLETE_AUDIT.md` §2.

## Context

Master prompt-ul de modernizare cere un „consilier financiar” care analizează venituri și cheltuieli, găsește tranzacții neobișnuite și tipare, sugerează economii, explică rapoartele și dă un rezumat lunar; o prognoză de cash-flow la 30/60/90 de zile cu indicator de încredere; un scor de sănătate financiară transparent, care **nu** e scor de credit. FINET are deja agregatele lunare (`dashboard.repo.ts`), stările bugetelor, soldurile conturilor, regulile recurente cu scadențe (`calendar.ts`) și rezumatul lunar determinist (ADR 0025), plus un pas LLM opțional în spatele consimțământului `external_ai_ask` și al bugetului global (ADR 0026).

## Decizii

1. **Totul se calculează în cod, determinist, în întregi.** Funcțiile de scor, prognoză și analiză sunt pure (`health.ts`, `forecast.ts`, `advisor.ts`), primesc agregate deja citite sub RLS și întorc valori întregi (`bigint` pe sume, puncte de bază pe rapoarte, sutimi de lună pe acoperiri). Niciun model AI nu produce cifre. Pasul LLM (pasul F) poate doar **reformula** o analiză deja calculată, în spatele aceluiași consimțământ și buget ca ADR 0026, și e etichetat ca atare.
2. **Nicio migrație.** Toate cele trei funcții citesc tabelele existente; nu stochează scoruri istorice (se recalculează la cerere pentru orice lună din fereastra de 60 de luni). Un istoric persistat (snapshot lunar) vine odată cu averea netă (pasul G), dacă se dovedește util.
3. **Scorul de sănătate** (`/api/v1/health-score`, `/health`): media ponderată a șase componente, fiecare cu valoare, pondere, explicație și praguri publice (în `ro.health.thresholds` și în codul din `health.ts`):
   - rata de economisire (25): `(venit − cheltuieli) / venit` în lună; ≥ 20 % → 100, 0 → 40, ≤ −20 % → 0;
   - fluxul de numerar (15): lunile cu venit ≥ cheltuieli din ultimele 6 cu activitate;
   - fondul de urgență (20): soldul lichid (cash, bancă, economii; doar soldurile pozitive) / cheltuiala medie a ultimelor 3 luni cu cheltuieli; 6 luni → 100, liniar;
   - stabilitatea cheltuielilor (15): abaterea absolută medie față de media ultimelor 6 luni (minimum 3), în puncte de bază; ≤ 10 % → 100, 50 % → 20, ≥ 60 % → 0;
   - aderența la bugete (10): verde = 1, galben = ½, roșu = 0;
   - datoriile (15): soldurile negative (carduri de credit, descoperiri) / venitul lunii (sau media veniturilor din fereastră); 0 → 100, ≥ 50 % → 0.
   O componentă fără date e `null` și nu intră în medie (ponderile celorlalte se redistribuie), ca scorul să nu fie penalizat de lipsa bugetelor. Benzile: ≥ 80 bun, ≥ 60 rezonabil, ≥ 40 de urmărit, altfel fragil. Pragurile sunt **decizia mea** (valori uzuale în educația financiară: 20 % economisire, 3–6 luni fond de urgență) și pot fi ajustate într-un ADR ulterior; nu sunt un standard extern.
4. **Separat pe monedă, fără conversie**, ca dashboard-ul (ADR 0007). Conversia în moneda de bază vine în pasul K și va fi doar pentru afișare.
5. **Eticheta obligatorie** „Scor orientativ … Nu este un scor de credit și nu este sfat financiar” însoțește fiecare răspuns (`label`) și fiecare pagină.
6. **Vizibilitatea** urmează RLS-ul existent (ADR 0016): conturile personale ale altor membri și bugetele lor personale nu intră în scorul cititorului; un membru vede scorul „său” din perspectiva datelor pe care le poate vedea.
7. **API:** `GET /api/v1/health-score?month=` (fereastra de 60 de luni ca restul planificării), în registrul OpenAPI (`HealthScore`), cu testul de contract. Fără rate limit propriu (o singură interogare agregată + soldurile; cost similar dashboard-ului).

## Prognoza de cash-flow (pasul E)

8. **Model aditiv, în întregi:** soldul proiectat pe zile = soldul de azi al conturilor active vizibile (toate tipurile, inclusiv cardurile de credit, ca poziție netă în monedă) + scadențele regulilor recurente active (aceeași grilă `calendar.ts` ca workerul: `occurrenceOnOrAfter` de la `max(next_run_on, mâine)`, cu `end_on` și scadențele rămase) + media zilnică a veniturilor și cheltuielilor **nerecurente** din ultimele 3 luni complete cu activitate (`source <> 'recurring'`, ca să nu se numere de două ori ce generează regulile). Azi nu intră în prognoză (ziua curentă e în sold sau o generează workerul); scadențele restante le generează workerul ca tranzacții trecute.
9. **Orizonturi fixe** 30/60/90 (`?days=`, implicit 90), cu rezumat pe fiecare: sold proiectat, venituri și plăți programate, estimările liniei de bază, cel mai mic sold și ziua lui (semnal de descoperire). Punctele pe zile (cel mult 91) sunt în răspuns pentru grafic.
10. **Încrederea** e un punctaj 0–100 explicat prin motive cu coduri stabile: istoricul (3 luni complete 40, 2 luni 25, 1 lună 10), stabilitatea cheltuielilor lunare (abaterea absolută medie ≤ 10 % 30, ≤ 30 % 20, altfel 5), acoperirea cheltuielilor de reguli recurente (≥ 50 % 30, > 0 15), minus orizontul (60 de zile −10, 90 −20). ≥ 70 ridicată, ≥ 40 medie, altfel scăzută. Pragurile sunt decizia mea.
11. **Eticheta** „Estimare … Nu este sfat financiar” însoțește răspunsul și pagina; cifrele programate (din reguli) și cele estimate (din medie) sunt separate în răspuns, ca Android și web să le poată distinge vizual.

## Consecințe

- Fără date noi: scorul e reproductibil din tranzacții și poate fi recalculat pentru orice lună; nu există „istoric al scorului” decât prin recalculare.
- Pragurile sunt vizibile utilizatorului; schimbarea lor e o schimbare de produs documentată, nu o corecție silențioasă.
- Pentru `saas`, funcția nu e încă o `Feature` din entitlements (toate planurile o au); se poate restrânge ulterior fără migrație (`features` e `jsonb`).
- Prognoza (pasul E) și consilierul (pasul F) se adaugă la acest ADR, în secțiuni proprii, când sunt livrate.
