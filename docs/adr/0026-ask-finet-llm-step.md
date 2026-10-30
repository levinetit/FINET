# ADR 0026: „Întreabă FINET” — pasul cu LLM, apelat din serverul web

- **Stare:** propus (F10-C, pasul LLM, branch `phase/10-ask-llm`). Oprit implicit (`AI_ASK=0`). Aplicarea cere migrația `0019`, un secret nou și variabile pe `finet-web` (`docs/INFRA.md`, „4s”).
- **Legături:** ADR 0025 (nucleul determinist; §2 amâna acest pas), 0014 (pipeline-ul AI: consimțământ, buget, `ai_calls`), 0022 (pasul LLM opțional al listelor, același tipar). Decizia operatorului: varianta „acces al `finet-web` la LiteLLM” (nu coada către worker).

## Context

ADR 0025 a livrat „Întreabă FINET” fără model: parser în cod, set închis de interogări, cifre din baza de date. A rămas pasul „un LLM transformă întrebarea într-o interogare”. Master prompt-ul cere LLM local; nu există, deci se folosește furnizorul extern existent (`gemini` prin LiteLLM), sub aceleași garanții ca la liste. Operatorul a ales ca serverul web să-l apeleze direct (interactiv, răspuns în secunde), în loc de o coadă către worker (care ar fi cerut stocarea întrebării).

## Decizii

### 1. Modelul doar traduce; codul decide

- **Când se apelează:** DOAR dacă parserul din cod nu înțelege întrebarea (`metric`/`period`), `AI_ASK=1`, furnizorul e configurat și utilizatorul a dat consimțământul. Dacă parserul înțelege, modelul nu se apelează niciodată (test: zero cereri).
- **Ce pleacă:** textul întrebării, data de azi și NUMELE categoriilor vizibile (cel mult 80). Nu pleacă sume, tranzacții, comercianți, conturi, id-uri sau emailuri (test: nimic din acestea nu apare în corpul cererii).
- **Ce întoarce modelul:** o interogare din SETUL ÎNCHIS al ADR 0025 (metrică, perioadă ca specificație, numele unei categorii, numele unui comerciant), în JSON validat strict cu Zod. Perioada e o specificație (`last_month`, `last_n_months`, `month`, …), NU două date: aritmetica de date o face `period.ts` (aceeași implementare ca parserul). Un model nu primește id-uri.
- **Cum se verifică:** numele categoriei se potrivește cu categoriile vizibile, iar comerciantul cu comercianții gospodăriei, prin egalitate după normalizare. Un nume care nu se potrivește cu nimic → întrebarea e REFUZATĂ (`reason: "name"`), nu se răspunde nefiltrat. Interogarea trece apoi prin aceeași schemă strictă ca cea din parser și prin aceeași executare sub RLS.
- **Transparență:** răspunsul are `source: "ai"`, o notă „interpretată de un model AI extern” și, ca întotdeauna, interogarea folosită (`query`, `queryText`).

### 2. Consimțământ separat: `external_ai_ask`

Acordul existent `external_ai` acoperă pozele de bonuri și nu poate fi extins în tăcere la textul întrebărilor. Se adaugă un acord NOU, `external_ai_ask` (API: `externalAiAsk`, în `GET/PUT /me/consents`; cartea „Întreabă FINET cu AI” în Profil), la fel cum `external_ai_statements` e separat pentru extrase. Verificat înainte de FIECARE încercare (revocarea în timpul unei reîncercări oprește apelul).

### 3. Cheie dedicată, doar pe web, doar la cerere

Până acum cheia LiteLLM exista doar în worker (`config.ts` o refuza pe web). Varianta aleasă dă web-ului acces la furnizor, deci:

- **Cheie DEDICATĂ** (`AI_ASK_API_KEY_FILE`, secretul `finet_ask_litellm_key`), NU cea a workerului: o cheie virtuală LiteLLM creată doar pentru acest scop (doar modelul text, cu plafon de cheltuieli propriu în LiteLLM). O scurgere din web nu dă acces la ce poate face workerul.
- **Doar cu `AI_ASK=1`**; `AI_ASK=1` fără `AI_BASE_URL` și fără cheie → eroare la pornire (nu un pas tăcut nefuncțional). `AI_API_KEY_FILE` rămâne interzisă pe web, iar `AI_ASK_API_KEY_FILE` interzisă pe celelalte roluri (teste în `config.test.ts`).
- **Secretul se montează doar printr-un fișier compose suplimentar** (`ops/docker/docker-compose.ask.yml`): deploy-urile fără pas LLM nu au nevoie de fișierul secretului și nu se schimbă.
- Anti-SSRF: același `AI_ALLOWED_HOSTS` și aceleași limite de corp/timp ca pentru worker (`lib/ai/client.ts`).

### 4. Buget, urme, limite

- **Buget:** rezervat înaintea fiecărei încercări din `AI_MONTHLY_BUDGET` (aceleași funcții SECURITY DEFINER ca bonurile și listele); buget epuizat → nimic nu pleacă (`aiHint: "budget"`).
- **`ai_calls`:** un rând `ask_finet` (model, tokeni, cost estimat, durată, rezultat), fără conținut. Sarcina nouă cere **migrația `0019`** (`ai_calls_task_valid` + `consents_kind_valid`, două constrângeri CHECK înlocuite; nicio coloană, politică sau date).
- **Interactiv:** termen total 25 s, cel mult o reîncercare; erorile (timeout, 5xx, ieșire invalidă) → „nu am înțeles” cu `aiHint: "error"`, fără detalii despre furnizor sau cheie.
- **Întrebarea nu se păstrează** (nici în baza de date, nici în audit, nici în loguri): testul caută un marcaj unic în TOATE tabelele schemei `finet` după o întrebare trimisă la model.
- Limita de cereri a rutei (`api_ask`, 30/min) rămâne.

### 5. Ce NU face

Nu trimite rezumatul lunii la model (rămâne în cod, ADR 0025). Nu adaugă istoric de întrebări. Nu permite modelului interogări în afara setului închis.

## Consecințe și alternative respinse

- Coada către worker: respinsă de operator (latență, plus text de utilizator stocat → export/ștergere GDPR).
- Reutilizarea cheii workerului pe web: respinsă (cheie dedicată, rază mică de impact).
- Extinderea consimțământului `external_ai`: respinsă (acord separat, explicit).
- Cost: un apel scurt (~300 tokeni ieșire, plafon `ASK_LLM_MAX_TOKENS`) doar pentru întrebările pe care parserul nu le înțelege.
