# ADR 0012 — API-ul și interfața plăților recurente

- **Stare:** propus (F5-B, branch `phase/05-recurring`).
- **Legături:** master prompt Faza 5 (7), 5.1, 5.2, 5.3, 6.4; ADR 0005 (API v1), 0006/0008 (UI), 0011 (recurențe și worker).

## Context

F5-A a livrat datele, serviciile și workerul. F5-B expune regulile prin `/api/v1/recurring` și le aduce în interfață, cu butonul „Generează scadentele”, fără a lega serverul web de pg-boss.

## Decizii

- **Generarea la cerere rulează în serverul web** (decizia coordonatorului): `POST /api/v1/recurring/generate` apelează `generateDueForHousehold` ca utilizatorul curent (RLS), în tranzacția cheii `Idempotency-Key` (savepoint pe regulă: o regulă eșuată nu le anulează pe celelalte). Jobul `recurring.generate-now` din worker rămâne pentru alți clienți, dar nu e folosit de web. Butonul merge și cu workerul oprit.
- **`Idempotency-Key` obligatoriu** pe `generate` (ca la contribuții): aceeași cheie → același răspuns; o cheie nouă → 0 tranzacții noi (unicitatea `(rule_id, occurrence_date)`). În UI, o cheie nouă per apăsare, păstrată doar la reîncercarea după rețea/5xx (`use-submit`).
- **Limită proprie** (decizia mea): 6 generări/min per utilizator (`recurringGenerate`), peste limita mutațiilor; verificată înaintea oricărei citiri a datelor.
- **„Azi”** = data din București la momentul cererii (ceasul injectat), niciodată din cerere; fusul gospodăriei rămâne deschis (ADR 0011).
- **Contorul „Y”** = reguli scadente (active cu o scadență negenerată ≤ azi), nu ocurențe în așteptare. Textul din UI: „X active · Y reguli scadente · Z total”, cu explicația sub el; OpenAPI și `docs/API.md` o spun la fel. `counts` se calculează pe toate regulile, indiferent de filtru.
- **Contul arhivat:** regula pusă automat pe pauză (`paused` + `lastErrorCode = account_archived`) apare „Pusă pe pauză (cont arhivat)”, cu explicația; reluarea răspunde 409 `account_archived`, iar UI-ul arată ce trebuie făcut. O pauză manuală nu primește motivul.
- **Răspunsul `generate`:** `{ today, rules, generated, failed, skipped }`, fără harta codurilor de eroare (decizia mea: suficient pentru UI; detaliile rămân pe reguli, în `lastErrorCode`).
- **Audit** `recurring.generated` cu `rules`, `generated`, `failed`, `skipped` (decizia mea), fără sume, reguli sau descrieri; ștergerea e auditată din F5-A.
- **Tranzacțiile** primesc câmpul `recurringRuleId` în API (null la cele manuale); CSV-ul de export rămâne neschimbat (decizia mea: compatibilitate cu fișierele existente).
- **Evenimente de utilizare:** doar numele `recurring_created`, `recurring_generated` și ecranul `recurring` adăugate în listă (clientul web nu trimite încă evenimente, ca în Faza 3).
- **UI:** filtrele pe stare sunt linkuri (`?status=`, merg fără JavaScript, `aria-current`); formularul are aceleași limite ca serviciul (descriere obligatorie, interval ≤ 100, rate ≤ 1200, ziua doar lunar/anual), copiate în `src/app/_lib/recurring-ui.ts` și verificate în test față de schema bazei (fără schema Drizzle în browser). Tipul și data de început nu se editează. Datele `zz.ll.aaaa`, sumele `0,00 lei`. Intrarea „Recurențe” e în meniul lateral și în „Mai mult” pe telefon.
- **Cartea de pe dashboard** (următoarele 5 scadențe): amânată (decizia mea; opțională în brief), ca să nu crească bugetul JS al dashboard-ului fără măsurare.

## Consecințe

- Fără variabile, secrete sau servicii noi pentru web. `docs/openapi.json` crește (schema regulii e inline în fiecare operație).
- Rămân: fusul gospodăriei, cartea de pe dashboard, transferurile recurente, notificările.
