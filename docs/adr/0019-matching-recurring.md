# ADR 0019 — Potrivirea bon ↔ tranzacție din extras și propunerile de plăți recurente

- **Stare:** propus (F7-B, branch `phase/07-statements`). Migrația `0014_statement_uploads` și redeploy-ul le face operatorul, după revizuiri (`docs/INFRA.md`, 4l).
- **Legături:** master prompt Faza 7 (potrivire, abonamente), 5.1 (bani), 5.5 (bonuri), 6.1, 6.2; ADR 0011 (recurențe), 0014–0015 (bonuri), 0016 (conturi personale), 0018 (extrase).

## Context

După import, aceeași cheltuială poate apărea de două ori: din bon (Faza 6) și din extras (Faza 7). Master promptul cere potrivirea bon ↔ tranzacție (sumă exactă, ±3 zile, comerciant, scor și motive vizibile, decizia utilizatorului, niciodată două tranzacții pentru aceeași cheltuială) și detectarea plăților recurente din istoric, propuse ca reguli (Faza 5), fără creare automată. LLM-ul nu calculează sume.

## Decizii

### 1. Potrivirea: deterministă, în cod, în întregi (`src/modules/matching/score.ts`)

- **Candidat** = cheltuială din extras (`source = 'statement'`), aceeași monedă, **suma exactă** (unități minore), cel mult **3 zile** distanță, VIZIBILĂ membrului (RLS: tranzacțiile din conturile personale ale altor membri nu apar), nelegată deja de un alt bon, nerespinsă pentru acest bon.
- **Scorul** (0–100): suma exactă 30; data: aceeași zi 30, ±1 zi 22, ±2 zile 15, ±3 zile 7; comerciantul: CUI-ul bonului găsit ca număr întreg în descrierea/comerciantul tranzacției 40, numele normalizat (fără diacritice, forme juridice, termeni bancari) cuprins 30, cel puțin un cuvânt semnificativ (≥ 4 litere) comun 20, altfel 0. „Probabil” ≥ 60. **Ambiguu** = cel puțin doi candidați cu diferența dintre primii doi < 15 puncte (decizia mea). Motivele sunt coduri fixe (`amount_exact`, `date_diff_1`, `merchant_tax_id`, …), traduse în interfață.
- **Bonuri eligibile:** `needs_review` fără tranzacție, sau `saved` cu tranzacția creată din bon (`source = 'receipt'`), cu total și dată.
- **Confirmarea** nu creează o tranzacție nouă: bonul nesalvat se leagă de tranzacția din extras și devine `saved`; un bon deja salvat își mută legătura pe tranzacția din extras, iar tranzacția bonului (duplicatul) se ȘTERGE — doar dacă e vizibilă și nemodificată (fără etichete, fără împărțire; altfel 409 `receipt_transaction_edited`, legarea rămâne manuală). Categoria și comerciantul tranzacției din extras se completează din bon doar dacă lipsesc. Decizia e idempotentă; tranzacția trebuie să fie un candidat valid ACUM (un id ghicit = 404).
- **Respingerea** se memorează în `receipt_match_rejections` (doar identificatori), vizibilă doar cu tranzacția (politica verifică tranzacția sub RLS-ul apelantului).
- **Apărarea în bază (0014):** indexul unic `receipts_transaction_key` (o tranzacție are cel mult un bon) și triggerul SECURITY INVOKER `receipts_check_transaction` (bonul se leagă doar de o cheltuială din aceeași gospodărie și monedă, vizibilă apelantului: cheia compusă din 0008 nu vede RLS-ul).
- **Limită documentată:** anularea ulterioară a importului extrasului cere decizia explicită (tranzacția legată de un bon e „modificată”); dacă utilizatorul o șterge, bonul rămâne `saved` fără tranzacție.

### 2. Plățile recurente detectate (`src/modules/recurring/suggestions.ts`)

- Calculate la cerere din istoricul VIZIBIL (400 de zile, venituri și cheltuieli, fără transferuri); nimic nu se creează fără acceptul utilizatorului.
- **Grupare:** (cont, tip, monedă, comerciantul normalizat = primele 3 cuvinte semnificative din `merchant`, altfel din descriere); o apariție pe zi.
- **Periodicitate** (toate intervalele din ultimele cel mult 6 apariții): săptămânal 6–8 zile, lunar 27–34 zile, anual 358–372 zile; minimum 3 apariții (2 la anual). Activă: ultima apariție cel mult 12 / 45 / 400 de zile în urmă.
- **Suma:** fiecare apariție la ±10% (1000 de puncte de bază, întregi) de mediana ferestrei; suma propusă = ultima apariție.
- **Exclusă** dacă există o regulă (activă sau pe pauză) pe același cont, tip, monedă și periodicitate cu același comerciant normalizat sau suma în toleranță, ori dacă a fost respinsă.
- **Amprenta** = SHA-256 (versiune, cont, tip, monedă, comerciant normalizat, periodicitate); respingerea memorează DOAR amprenta (`recurring_suggestion_dismissals`, pe cont, fără textul comerciantului).
- **Acceptarea** recalculează propunerea pe server (clientul trimite doar amprenta), apoi creează regula prin serviciul Fazei 5 (aceleași validări; `Idempotency-Key`); prima scadență = următoarea dată așteptată (sau `startOn` ales).

## Consecințe

- Fără AI, fără float pe sume; rezultatele se pot explica utilizatorului.
- Toleranțele sunt constante în cod (de ajustat cu date reale; azi testate pe date sintetice).
- Potrivirea vede doar tranzacțiile din extras (nu și pe cele manuale) — decizia mea, ca să nu propună legarea de cheltuieli introduse de mână.
