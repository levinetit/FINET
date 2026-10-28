# Comparație finpulse.day ↔ FINET: ce are finpulse și nu are FINET

Data: 2026-10-28. Surse: `raport.md` și `raport-detaliat.md` (analiză statică REA, resurse publice), `docs/FINET_MASTER_PROMPT.md` (secțiunile 2, 7) și starea FINET la această dată.

**Starea FINET la 2026-10-28:** Fazele 0–2 sunt pe producție (autentificare cu email și parolă și magic link, înregistrare publică oprită, gospodării, conturi, categorii, tranzacții, transferuri, idempotență, statistici de utilizare cu consimțământ). Faza 3 (dashboard, bugete, obiective, etichete, rapoarte, export CSV, backup) este în lucru.

**Legendă, coloana „FINET”:**
- **Live:** pe producție.
- **În lucru:** Faza 3.
- **Planificat F#:** în master prompt, în faza indicată.
- **Neacoperit:** nu apare în master prompt; candidat pentru decizie.
- **Decis să nu:** respins deliberat în master prompt.

**Legendă, coloana „Sursă”:** *observat* = văzut în cod public sau în anteturi; *dedus* = interpretare; *(C)* = din contul gratuit propriu, din master prompt, secțiunea 2.

## A. Funcții din finpulse care lipsesc azi din FINET, dar sunt planificate

| Funcție finpulse | Sursă | FINET |
|---|---|---|
| Dashboard cu carduri, selector de lună, grafice, comparație cu luna anterioară, onboarding în 3 pași | (C) | În lucru (F3) |
| Bugete cu semafor, obiective, etichete, filtre avansate, export CSV | (C), observat | În lucru (F3) |
| Bonuri: foto, PDF, mai multe fișiere, coadă, linii pe produs, SGR, arhivă cu căutare OCR | observat, (C) | Planificat F6 |
| Import unificat (poze, PDF, CSV, Excel, ZIP), „mod bon lung” | (C) | Planificat F6 (bonuri) și F7 (extrase) |
| Extrase de la ING, BT, BCR, BRD, Raiffeisen, Revolut, Wise; deduplicare; acoperire pe luni | observat, (C) | Planificat F7 |
| Potrivire bon ↔ tranzacție din extras | observat | Planificat F7, cu scor și motive vizibile |
| Recurențe și detectarea abonamentelor | (C) | Planificat F5 (reguli) și F7 (detectare) |
| Familie: membri, bugete comune, împărțire, solduri reciproce, decontări | observat, (C) | Planificat F8 |
| Liste de cumpărături, comparație listă ↔ bon | observat | Planificat F10 |
| Rapoarte de micro-cheltuieli (pungi, SGR, impuls, nealimentare, cafea, cupoane) și prețuri pe magazin | (C) | Planificat F10 |
| Export Excel și PDF | observat | Planificat F10 |
| Login cu Google | observat | Planificat F11 (`saas`) |
| Pagini publice `/pricing`, `/help`, `/terms`, `/privacy`; mențiuni legale | observat, (C) | Planificat F11 (`saas`) |
| Feedback și raportare de bug-uri din aplicație | observat | Planificat F11 (`saas`) |
| Panou de administrare și anunțuri | observat | Planificat F11 (`saas`) |
| Planuri, Stripe Checkout, perioadă de probă | observat | Planificat F12 (`saas`) |
| Recomandări cu cod unic și recompensă | observat, (C) | Planificat F12 (`saas`) |
| Limbi multiple (8 în cod) | observat | Planificat: ro, apoi en în `saas`; restul la cerere |
| PWA cu `start_url` la dashboard | observat | Planificat F9 (cu offline, pe care finpulse nu îl are) |

## B. Funcții din finpulse neacoperite în master prompt (candidate pentru decizie)

| # | Funcție finpulse | Sursă | De ce contează | Propunere |
|---|---|---|---|---|
| 1 | Al patrulea plan, „Ultra” (49,99 RON sau 11,99 EUR pe lună; 500 documente pe zi, 25 MB, 10 membri). Master prompt 2.2 listează doar Starter, Pro, Family | observat | Doar pentru `saas`; limitele FINET se decid din costul măsurat (F12) | Informativ: se trece în 2.2; fără acțiune până în F12 |
| 2 | Prețuri anuale: Pro 189 RON (49 EUR), Family 329 RON (89 EUR), Ultra 479 RON (119 EUR). Master prompt 2.2: „valorile nu sunt cunoscute” | observat | Reper de piață pentru F12 | Actualizare documentație (2.2) |
| 3 | Limite Starter: 1 document pe zi, 5 MB, istoric de bonuri 3 luni. Rezolvă contradicția din 2.2 | observat | Reper pentru plan gratuit în `saas` | Actualizare documentație (2.2) |
| 4 | Tipuri de fișier pe plan (gratuit: JPEG, PNG, CSV; Pro: plus PDF, XLSX, ZIP) | observat | Poarta de plată pe tipul fișierului. FINET limitează prin `entitlements`, nu pe tip | Decizie în F12; în `personal` nu se aplică |
| 5 | Coadă prioritară după plan | observat | FINET are coadă pg-boss, fără prioritate pe plan | Prioritate pg-boss în F12, dacă se păstrează |
| 6 | „Export contabil” (plan Family) | observat | Conținutul nu e vizibil în cod; poate fi un format pentru contabil | Nu se implementează fără exemplu real; întrebare către operator |
| 7 | „Raport AI la cerere în limbaj natural” (Ultra) | observat | FINET are doar rezumatul lunii generat local din cifre agregate (F10, opțional). Întrebările libere nu sunt acoperite. Regula 3.6: LLM-ul nu calculează sume | După v1.0, doar ca interogare peste cifre calculate în cod |
| 8 | Analiză de inflație per comerciant (Ultra) | observat | F10 acoperă prețuri per produs și magazin și evoluția în timp; „inflația” agregată per comerciant nu e menționată | Poate intra în rapoartele F10 ca definiție în date |
| 9 | Recompensă pentru feedback (14 zile Pro) | (C) | F11 are feedback, F12 are recomandări; recompensa pentru feedback nu e planificată | Decizie în F12, doar `saas` |
| 10 | Actualizări live (Supabase Realtime) | observat | FINET nu are canal live; util între membri ai familiei (F8) | Interogare periodică sau SSE în F8, dacă e nevoie |
| 11 | Login cu Facebook | observat | Master prompt prevede doar Google în `saas` | Rămâne nepreluat, cu motiv documentat |
| 12 | Recuperare automată la eroare de încărcare a unui chunk JS (reîncărcare, cel mult o dată la 8 s) | observat | După fiecare deploy, tab-urile deschise cer chunk-uri vechi și dau erori | Candidat pentru F4 (stabilizare); modificare mică |
| 13 | Mesaj de instalare PWA cu „închide” memorat | observat | F9 are manifest și ghid de instalare, dar nu invitația în aplicație | Detaliu pentru F9 |
| 14 | Pagină `/help` în aplicație | observat | F11 are `/help` doar în `saas`; varianta `personal` nu are ghid în aplicație | Ghid scurt în F4 sau F9 |
| 15 | Consimțământ cookie cu Consent Mode v2 și Google Analytics 4 | observat | FINET nu pune analytics în zona autentificată; în `saas` doar pe paginile publice (F11) | Rămâne cum e decis |
| 16 | Suport prioritar și „24/7” în planuri | observat | Angajament operațional, nu funcție software | Nu se aplică; relevant doar pentru oferta `saas` |

## C. Diferențe deliberate: finpulse are, FINET nu copiază

| finpulse | De ce nu |
|---|---|
| Procesare cu furnizori AI externi ca traseu principal (Groq, Gemini, GPT-4o-mini) | FINET: întâi local, extern doar ca rezervă și cu consimțământ (3.6) |
| Duplicatele ca funcție plătită (Pro) | FINET: deduplicarea e mereu activă, pe orice plan |
| Clasificare cu categorii care se suprapun | FINET: categorii distincte plus etichete |
| Sume fără format românesc („0.00 RON”) | FINET: `0,00 lei` peste tot |
| „Cheltuieli pe categorii” probabil doar din bonuri | FINET: toate cheltuielile, nu doar bonurile |
| Pagină publică randată în browser (SEO slab) | FINET: pagini publice randate pe server |
| CSP fără `script-src` | FINET: CSP completă cu nonce, verificată în E2E |
| Cod de server (Stripe SDK, configurația planurilor) livrat în bundle-ul de browser | FINET: `server-only` și `scan:client-secrets` în CI |
| Dashboard supraîncărcat | FINET: rezumat pe dashboard, restul pe pagini proprii |
| Fără mod offline (service worker fără precache, `/offline` dă 404) | FINET: scanare offline în F9 |

## D. Ce are FINET și nu are finpulse (după datele disponibile)

- Acces protejat de Cloudflare Access în varianta `personal`, cu verificarea JWT pe fiecare cerere și răspuns 403 fără el.
- Securitate la nivel de bază de date: RLS `FORCE`, rol de aplicație fără BYPASSRLS, drepturi pe coloane.
- Idempotență pe cererile care creează, paginare cu cursor, OpenAPI generat și verificat în CI.
- Sume în unități minore (`bigint`), fără float; plafon și validare pe server.
- Înregistrare publică oprită; autentificare cu Argon2id și limitare proprie a încercărilor.
- Backup propriu criptat cu restic și restaurare testată (F3).

## E. Limite ale acestei comparații

- finpulse este analizat static, din resurse publice. Ce face serverul (validări, limite aplicate, politici RLS) nu se știe.
- Rutele private (`/dashboard`, `/receipts`, `/reports` etc.) apar în cod, dar conținutul lor nu a fost analizat.
- Planurile și limitele sunt cele din codul clientului; aplicarea lor pe server nu a fost testată.
- Coloana FINET reflectă master prompt-ul și starea la data de mai sus; se schimbă la fiecare fază.
