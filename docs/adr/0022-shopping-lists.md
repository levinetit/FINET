# ADR 0022: liste de cumpărături și comparația listă ↔ bon

- **Stare:** propus (F10-A, branch `phase/10-lists`). Deploy-ul îl face operatorul, după revizuiri (`docs/INFRA.md`, „4o”).
- **Legături:** master prompt „Faza 10”, 3.6 (alte folosiri ale LLM); ADR 0014 (pipeline-ul AI, bugetul, consimțământul), 0015 (bonuri), 0016–0017 (personal/comun, actualizări live), 0021 (export/ștergere GDPR).
- **Migrația:** `0017_shopping_lists` (`when` 1794900000000; 0018 e rezervată F10-B; jurnalul se reconciliază la merge, în ordinea 0017, 0018).

## Context

Faza 10 cere liste de cumpărături folosite „la raft” și, după ce un bon e confirmat, o comparație a listei cu bonul: ce s-a cumpărat din plan, ce s-a cumpărat pe lângă plan, ce s-a uitat. Potrivirea numelor de produse e o problemă de cod (nume normalizate, similaritate), nu de LLM; LLM-ul poate ajuta doar la perechile ambigue și doar dacă utilizatorul a dat consimțământul pentru AI extern.

## Decizii

### 1. Date (RLS ENABLE + FORCE pe toate cele trei tabele)

- **`shopping_lists`**: `household_id`, `name` (1–100, netăiat), `owner_user_id` (NULL = listă COMUNĂ gospodăriei; setat = listă PERSONALĂ, vizibilă doar proprietarului), `status` (`active`/`archived`), `created_by_user_id`, marcaje de timp.
- **`shopping_list_items`**: `list_id` + `household_id` (cheie străină compusă), `name` (≤ 120), `normalized_name`, `quantity` `numeric(9,3)` (niciodată float) cu `unit` (≤ 20) opțional, `note` (≤ 200), `checked` + `checked_by_user_id` + `checked_at`, `position`, `matched_receipt_line_id` (cheie străină compusă cu gospodăria către `receipt_lines`; `ON DELETE SET NULL` doar pe coloana liniei), `match_status` (`none`/`suggested`/`confirmed`/`rejected`) și `match_source` (`code`/`learned`/`ai`/`manual`).
- **`shopping_list_ai_requests`**: coada pasului opțional cu LLM, o cerere pe pereche (listă, bon), cu `status`, `attempts` (0–3), cod de eroare fix.
- **Vizibilitatea** urmează regula conturilor din Faza 8: implicit lista e **comună** (decizia mea: cumpărăturile sunt un proces de familie); una **personală** (`personal: true`) o vede doar proprietarul, iar alt membru nu primește nici măcar un id (404 uniform). Proprietarul poate face lista comună; alt membru nu o poate prelua, iar o listă comună nu devine personală. Rolurile gospodăriei sunt doar `member` și `owner` (nu există `viewer`): orice membru activ citește și scrie listele comune; accesul în afara gospodăriei e refuzat de RLS.
- **Plafoane** (CHECK, triggere și Zod): 100 de liste vizibile și 300 de articole pe listă; lungimile de mai sus.
- **Normalizarea numelui** reutilizează `normalizeProductName` din modulul de bonuri (aceeași ca pentru `receipt_lines.normalized_name` și `product_aliases`): nicio a doua implementare.
- Pe `receipt_lines` se adaugă doar cheia unică `(id, household_id)`, ținta cheii compuse; nu schimbă date sau politici.

### 2. Servicii și API (`/api/v1/shopping-lists`)

CRUD pe liste și articole, bifare idempotentă (stare explicită `checked: true|false`, primul autor se păstrează), reordonare (permutare exactă), arhivare, „copiază lista” (articole nebifate, fără potriviri, personală rămâne personală), `Idempotency-Key` la creare, sugestii din produsele frecvente ale gospodăriei (nume normalizate, calculate în cod), bonurile confirmate recente. Detalii în `docs/API.md` și `docs/openapi.json`. Ștergerea unei liste comune se auditează fără conținut (`shopping_list.deleted`).

**Actualizări live:** magistrala SSE din Faza 8 are entitatea `shopping_list` (eveniment cu tip și id, fără conținut): bifarea apare la ceilalți membri fără reîncărcare.

### 3. Comparația listă ↔ bon (în cod)

- **Intrare:** o listă vizibilă și un bon **confirmat** (alt bon → 409), doar liniile `item`.
- **Scorul** (0–100, `src/modules/shopping/match.ts`): pe cuvinte de conținut (fără cifre, unități, cuvinte de legătură), `0,75·c + 0,25·p`, cu bonus/penalizare pentru substantivul-cap și pentru mărimi (`1l` față de `2l` scade, nu respinge). Alocare 1–la–1 greedy după scor.
- **Praguri:** `MATCH_HIGH = 80` (propunere sigură), `MATCH_LOW = 50` (între ele: AMBIGUĂ, marcată „nesigur” în UI); sub 50 nu există propunere. Rezultat: *potrivite*, *neplanificate* (pe bon, nu pe listă), *uitate* (pe listă, nu pe bon).
- **Învățare:** o confirmare învață perechea (sursa `learned`); o respingere o oprește pentru alte liste și alte bonuri.
- **Decizii ale utilizatorului:** poate confirma, respinge, șterge sau corecta o potrivire. Reluarea comparației NU rescrie deciziile. Comparația nu modifică niciodată automat tranzacții sau bonuri. Un bon șters lasă potrivirea fără linie („fără potrivire”).

### 4. Pasul opțional cu LLM (perechile ambigue)

- **Dezactivat implicit:** `AI_LIST_MATCH=0` (doar în worker; documentat în `.env.example` și `finet.worker.env.example`). Fără el totul funcționează din cod.
- **Condiții** (toate): `AI_LIST_MATCH=1`, AI configurat, consimțământul `external_ai` al celui care a cerut (verificat la punerea în coadă, la revendicare și înainte de fiecare încercare), bugetul AI lunar (rezervat înainte de fiecare încercare, aceleași funcții ca bonurile).
- **Ce pleacă:** DOAR nume normalizate; modelul (`gemini/gemini-3.8-flash` prin clientul LiteLLM din Faza 6, `task = list_match`) alege un candidat al articolului sau „niciunul”, ieșire validată cu Zod și constrânsă la id-urile candidate. Un cod inventat sau un răspuns invalid → cererea devine `failed` cu cod fix, iar propunerea din cod rămâne.
- **Worker:** `list-match.sweep` (la minut) citește coada prin `finet.queued_list_matches` și `finet.queued_list_match` (SECURITY DEFINER, `search_path = pg_catalog`, doar identificatori), apoi `list-match.process` pe cerere, în numele membrului care a cerut. Nimic din conținut nu intră în `pgboss.job`, loguri sau mesaje de eroare; `ai_calls` păstrează doar metadate.
- **Alegerile** se aplică doar articolelor încă nedecise de utilizator.
- **Coada și mai mulți membri:** `upsertAiRequest` repune în coadă doar o cerere TERMINATĂ (`done`/`failed`/`skipped`), cu încercările la 0 și noul solicitant. O cerere ACTIVĂ (`queued`/`processing`) a oricărui membru rămâne neatinsă și e întoarsă ca atare, fără scriere (altfel politica de UPDATE, care cere `requested_by_user_id` = utilizatorul curent, ar respinge reîncercarea unui al doilea membru). Test de integrare cu doi membri: `shopping-rls.test.ts`.

### 5. Interfață

`/shopping-lists`, `/shopping-lists/[id]` (mod „la raft”, mobil-first, ținte mari de atingere, bifare cu un tap, adăugare rapidă, sugestii), `/shopping-lists/[id]/compare` („Comparație cu bonul”, accesibilă și din bon). Română, `0,00 lei`, axe. **Fără coadă offline nouă** (ADR 0020): fără conexiune se afișează clar „fără conexiune”, service worker-ul nu cache-uiește date.

### 6. GDPR

Exportul (`/me/export`) include listele și articolele vizibile utilizatorului. La ștergerea contului, `finet.erase_user_shopping_lists()` (SECURITY DEFINER) șterge listele PERSONALE ale utilizatorului din toate gospodăriile; cele comune rămân gospodăriei. Listele nu conțin sume, dar numele de produse sunt date personale: aceleași reguli de acces ca bonurile.

## Consecințe și alternative respinse

- Potrivirea doar prin LLM: respinsă (cost, latență, date trimise extern pentru fiecare listă). Codul decide; LLM-ul ajută marginal și opțional.
- O singură listă pe gospodărie: respinsă (liste pe magazine/ocazii).
- Coadă offline pentru bifare: amânată; nu e în Faza 10.
- Rollback: antetul `0017_shopping_lists.sql` (doar manual, cu backup; distruge listele).
