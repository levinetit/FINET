# ADR 0035: planuri, abonamente și `entitlements` în `saas` (Faza 12-A)

- **Stare:** 12-A livrat și aplicat (migrația `0023_plans_subscriptions`, PR #51); 12-A.2 propus (branch `phase/12a2-plan-limits`, **cere migrația `0024_queue_priority`**, doar o redefinire de funcție). **Plățile:** operatorul NU folosește Stripe (decizie 2026-10-31); furnizorul de plată, dacă există, e de decis. Tabelul `subscriptions` acceptă deja `provider` = `manual`, `stripe` sau `founder`; un alt furnizor cere o migrație mică la `subscriptions_provider_valid`.
- **Legături:** master prompt Faza 12, ADR 0029 (înregistrare), ADR 0034 (expunere), SECURITY_CHECKLIST §38.

## Problema pe care o rezolvă

Până acum, în `APP_MODE=saas` fiecare apel `can`/`limit` din `entitlements` arunca `NotImplementedError`. Încărcarea de documente (`documents.service`), reprocesarea bonurilor și limitele zilnice treceau prin `limit`, deci un `saas` desfășurat nu putea procesa niciun document. Faza 12-A pune acolo planuri reale, citite din bază.

## Decizii

### 1. Planurile sunt DATE; nimic nu e completat de migrație

`finet.plans` (cod stabil, nume, `is_default`, `active`, `limits` jsonb, `features` text[]) și `finet.subscriptions` (un abonament curent pe gospodărie: plan, stare `trialing|active|past_due|canceled|expired`, furnizor `manual|stripe|founder`, `provider_subscription_id` unic pe furnizor, sfârșit de perioadă, sfârșit de probă). Numele treptelor din master prompt (Starter, Pro, Family, Ultra, „fondator”) sunt coduri pe care le alege operatorul; **prețurile și limitele nu sunt în cod și nu sunt inventate** (tabelul din master prompt e doar referința, cu mențiunea „limitele noastre vor fi decise separat, pe baza costului măsurat”).

### 2. Aplicația citește, operatorul scrie

`finet_app` are doar `SELECT` (RLS: planurile pentru orice utilizator autentificat, abonamentul pentru membrii gospodăriei). Scrierea o face operatorul ca `finet_migrator`, direct în bază (INFRA 4y), prin politici explicite pe acel rol. Alegere deliberată față de un CLI de administrare: CLI-ul rulează ca `finet_app`, deci ar fi cerut o funcție `SECURITY DEFINER` de scriere apelabilă de un server web compromis, adică posibilitatea de a-și acorda un plan. Orice integrare de plată viitoare (12-B, furnizor de decis) va avea o funcție de scriere dedicată, cu semnătura verificată în aplicație și cu tabel de evenimente văzute (idempotență).

### 3. Planul efectiv: `finet.household_plan(p_household)`

Funcție `SECURITY DEFINER`, `search_path = pg_catalog`, `stable`, executabilă doar de `finet_app` (workerul folosește același rol). Întoarce MEREU un rând:

- abonament viu (`trialing`/`active`/`past_due`, iar sfârșitul perioadei, `trial_end` la probă, nu a trecut; fără sfârșit, de exemplu manual sau fondator, nu expiră singur) → planul lui, stare `ok`;
- altfel, fără niciun abonament, planul implicit activ → `ok`;
- altfel, abonament expirat sau anulat → `read_only`;
- altfel (niciun plan implicit) → `none`.

### 4. Entitlements în `saas`: FAIL CLOSED

`personal` nu citește niciodată tabelele (test cu un client care aruncă). În `saas`, `can` e `true` doar dacă starea e `ok` și funcția e în plan; `limit` citește cheia din plan și întoarce `0` pentru stare ≠ `ok`, cheie lipsă, negativă, ne-întreagă sau de alt tip. Bugetul AI lunar rămâne global (din config). Lipsa clientului de bază de date în `saas` aruncă `TypeError` (eroare de programare, nu acces deschis). Limitele: `ai.dailyDocuments`, `storage.quotaMb`, `household.maxMembers`; funcțiile: `ask.finet`, `reports.custom`.

### 5. Abonament expirat: citire și export, nu scriere

Un singur punct de control, în `handle` (`src/app/api/v1/_lib/http.ts`): în `saas`, orice `POST/PUT/PATCH/DELETE` cu starea `read_only` primește `402 subscription_required`, iar cu `none` primește `503 plans_not_configured`. `GET` (inclusiv exporturile) trece. Excepțiile sunt EXPLICITE prin `handleAlways`: GDPR (export, previzualizare, ștergere), contul propriu (`/me/*`, parolă, sesiuni, consimțăminte, evenimente), administrarea platformei și feedback-ul, ieșirea din gospodărie, acceptarea unei invitații, previzualizarea unui raport și „Întreabă FINET” (acesta din urmă oprit oricum prin funcția din plan). O rută nouă este deci blocată implicit, nu deschisă.

### 6. Ce este legat de plan acum, și ce nu

Legate și testate pe server: zilnic documente și cota de stocare (apelurile existente), plafonul de membri (`createInvite`: membri + invitații active; `acceptInvite`: depășirea anulează intrarea), `ask.finet`, `reports.custom` (crearea unei definiții), blocarea scrierilor. **12-A.2** (migrația `0024_queue_priority`, aceeași ADR):

- `documents.maxFileMb`: dimensiunea maximă a fișierului pe plan. Gospodăria e cunoscută înainte de citirea corpului, deci limita se aplică la primire: `min(limita tehnică din config, plan)`; plan fără cheie sau fără plan → 0 (nimic nu se primește).
- `documents.jpeg|png|webp|pdf` (funcții de plan): tipurile acceptate, verificate după conținut, înainte de înregistrare; un tip lipsă din plan → `403 plan_restricted`, iar fișierele scrise se șterg. **Un plan `saas` trebuie să listeze tipurile pe care le permite.**
- `receipts.historyMonths` și `receipts.archive`: bonurile mai vechi decât N luni (după `created_at`) nu se listează și detaliul lor răspunde 404, în afară de planurile cu `receipts.archive` (arhivă permanentă) sau fără cheie. Cu abonament expirat (`read_only`) sau fără plan configurat datele rămân vizibile (citire și export). Se aplică lista și detaliul bonurilor; exporturile și agregatele (prețuri, rapoarte) nu sunt filtrate.
- `queue.priority`: `finet.queued_documents` păstrează echitatea din 0010 (cel mult 5 pe gospodărie, „pe rând”) și, în cadrul aceluiași rând, ia întâi planul cu prioritatea mai mare. Fără cheie, fără plan viu sau în `personal` prioritatea e 0, deci ordinea rămâne cea veche.

Nu sunt legate de plan: dimensiunea extraselor bancare (`/statements/uploads`, 20 MB fix) și cota zilnică de extrase.

### 7. Ce NU face această schimbare

Nu aplică migrația pe Supabase, nu inserează planuri, nu activează Stripe, nu schimbă `personal`. Fără planuri configurate, un `saas` refuză scrierile (503) în loc să le permită: operatorul trebuie să creeze cel puțin planul implicit înainte de lansare (INFRA 4y).

### 8. Rollback

Funcția și cele două tabele se elimină cu comenzile din antetul migrației (pierde planurile și abonamentele); codul revine la comportamentul anterior prin imaginea precedentă.
