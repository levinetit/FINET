# ADR 0025: „Întreabă FINET” și rezumatul lunii, în cod, fără LLM

- **Stare:** propus (F10-C, partea 2, branch `phase/10-ask`). Fără migrație și fără variabile noi: se aplică doar prin redeploy (`docs/INFRA.md`, „4r”).
- **Legături:** master prompt Faza 10 („Întreabă FINET”, rezumatul lunii) și 3.6 (alte folosiri ale LLM); ADR 0014 (pipeline-ul AI, consimțământ, buget), 0022 (pasul LLM opțional al listelor), 0023 (vizibilitatea conturilor personale), 0024 (exporturi).

## Context

Master prompt-ul cere pentru ambele funcții un **LLM local**: „Întreabă FINET” transformă întrebarea într-o interogare dintr-un set închis (validată cu Zod, cifre calculate în cod, interogarea arătată utilizatorului), iar rezumatul lunii e scris de model din cifre agregate, cu cifrele inserate din baza de date.

Constatări la implementare:

1. **Nu există LLM local.** Singurul model configurat e `gemini/gemini-3.8-flash` prin LiteLLM (extern); `finet-text-local` nu există în configurația LiteLLM de pe gazdă.
2. **`finet-web` nu poate apela modelul.** `AI_BASE_URL`, `AI_ALLOWED_HOSTS` și cheia (`AI_API_KEY_FILE`) sunt doar în mediul workerului (`finet.worker.env.example`); web are doar plafoanele (`AI_DAILY_DOCUMENT_LIMIT`, `AI_MONTHLY_BUDGET`). O întrebare e interactivă (răspuns în secunde), deci ar fi nevoie fie de acces al web-ului la LiteLLM (schimbare de infrastructură și un secret în plus pe web), fie de o coadă către worker cu întrebarea stocată (migrație, plus text de utilizator persistat, adică intră în export/ștergere GDPR).

## Decizii

### 1. Nucleul e determinist, fără model

- **Setul închis** (`src/modules/ask/query.ts`, Zod strict): metrică (`expense_total`, `income_total`, `top_categories`, `top_merchants`), perioadă (`from`, `to`), filtre opționale (`categoryId`, `merchant`), cu reguli (clasamentele nu au filtre; comerciantul doar la cheltuieli). Nicio altă valoare liberă; nimic din întrebare nu ajunge în SQL.
- **Parserul** (`parse.ts`, funcție pură): normalizează textul (litere mici, fără diacritice), recunoaște perioadele din română (azi, ieri, săptămâna aceasta/trecută, luna aceasta/trecută, o lună pe nume cu an opțional, ultimele N luni/zile, anul acesta/trecut, un an), metrica, o categorie vizibilă și un comerciant al gospodăriei (potrivire pe expresie întreagă, cea mai lungă câștigă). **Ce nu poate deduce nu ghicește:** fără metrică → „nu am înțeles” (`metric`), perioadă numită dar nerecunoscută → `period`; perioada lipsă devine luna curentă și e SPUSĂ în `notes`.
- **Executorul** (`ask.service.ts`): a doua validare strictă a interogării, apoi agregate sub RLS (`finet_app`), deci conturile personale ale altor membri nu intră. Răspunsul conține întotdeauna interogarea (`query`, `queryText`) și perioada. Cifrele vin din baza de date; textul răspunsului e un șablon.
- **Rezumatul lunii** (`summary.ts`, pur): propoziții din cifrele raportului lunar (totaluri, variația cheltuielilor față de luna precedentă, primele categorii, primul comerciant, starea bugetelor), formatate în cod. Eticheta fixă „Rezumat automat, nu sfat financiar.”. Variația procentuală se calculează pe `bigint` (jumătăți în sus).

### 2. Pasul cu LLM NU e implementat (decizia mea, de revăzut)

Forma interogării e exact cea pe care ar produce-o un model, deci un traducător LLM se poate adăuga fără să schimbe executorul, răspunsul sau interfața. Se amână până când operatorul alege una dintre variante: (a) un LiteLLM accesibil din `finet-web` (cheie în plus pe web, `AI_*` pe web, consimțământ `external_ai`, buget AI, `task = ask_finet` în `ai_calls_task_valid`, deci migrația `0019`); (b) coadă către worker (ca la liste). **Consecință:** funcția nu înțelege formulări libere; acoperă formulările din exemple și cele apropiate. Rezumatul e mai sec decât unul scris de model, dar cifrele sunt garantat corecte. Nu s-a trimis și nu se trimite nimic în afara aplicației.

### 3. Confidențialitate

- **Întrebarea nu se păstrează:** nu intră în baza de date (testul parcurge TOATE tabelele schemei `finet` după o întrebare cu un marcaj unic), în audit, în chei de limită, în loguri sau în mesaje de eroare. Se trimite în corpul unui `POST` (nu în adresă), ca să nu ajungă în jurnalele de acces.
- Fără audit pe întrebări (nu există conținut de păstrat); limită proprie: 30 de cereri pe minut per utilizator (`api_ask`).
- Funcția trece prin `entitlements` (`ask.finet`): în `personal` e permisă; în `saas`, până la implementarea din Faza 12 (`NotImplementedError`), rămâne permisă, iar un răspuns `false` al unei implementări reale o refuză (403).

### 4. Interfață

Pagina `/ask` (câmp, exemple cu un click, răspunsul, interogarea folosită), în navigare; cardul „Rezumatul lunii” pe `/reports`. Pagina nouă e un singur formular fără dependențe în plus (fără Zod în client).

## Consecințe și alternative respinse

- Un LLM extern direct din web: respins aici (secret și acces în plus pe web, fără decizia operatorului; master prompt-ul cere local).
- Persistarea întrebărilor pentru un istoric: respinsă (date personale în plus, cerere de export/ștergere).
- Interogări libere către SQL generate de model: respinse (securitate); setul închis rămâne chiar și cu un LLM.
