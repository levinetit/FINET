# ADR 0035: planuri, abonamente și `entitlements` în `saas` (Faza 12-A)

- **Stare:** propus (branch `phase/12a-plans`). **Cere migrația `0023_plans_subscriptions`** (două tabele noi și o funcție de citire; fără modificări ale tabelelor existente). Neaplicată pe Supabase. Fără Stripe în această sub-fază (12-B).
- **Legături:** master prompt Faza 12, ADR 0029 (înregistrare), ADR 0034 (expunere), SECURITY_CHECKLIST §38.

## Problema pe care o rezolvă

Până acum, în `APP_MODE=saas` fiecare apel `can`/`limit` din `entitlements` arunca `NotImplementedError`. Încărcarea de documente (`documents.service`), reprocesarea bonurilor și limitele zilnice treceau prin `limit`, deci un `saas` desfășurat nu putea procesa niciun document. Faza 12-A pune acolo planuri reale, citite din bază.

## Decizii

### 1. Planurile sunt DATE; nimic nu e completat de migrație

`finet.plans` (cod stabil, nume, `is_default`, `active`, `limits` jsonb, `features` text[]) și `finet.subscriptions` (un abonament curent pe gospodărie: plan, stare `trialing|active|past_due|canceled|expired`, furnizor `manual|stripe|founder`, `provider_subscription_id` unic pe furnizor, sfârșit de perioadă, sfârșit de probă). Numele treptelor din master prompt (Starter, Pro, Family, Ultra, „fondator”) sunt coduri pe care le alege operatorul; **prețurile și limitele nu sunt în cod și nu sunt inventate** (tabelul din master prompt e doar referința, cu mențiunea „limitele noastre vor fi decise separat, pe baza costului măsurat”).

### 2. Aplicația citește, operatorul scrie

`finet_app` are doar `SELECT` (RLS: planurile pentru orice utilizator autentificat, abonamentul pentru membrii gospodăriei). Scrierea o face operatorul ca `finet_migrator`, direct în bază (INFRA 4y), prin politici explicite pe acel rol. Alegere deliberată față de un CLI de administrare: CLI-ul rulează ca `finet_app`, deci ar fi cerut o funcție `SECURITY DEFINER` de scriere apelabilă de un server web compromis, adică posibilitatea de a-și acorda un plan. Webhook-urile Stripe (12-B) vor avea o funcție dedicată, cu semnătura verificată în aplicație și cu tabel de evenimente văzute (idempotență).

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

Legate și testate pe server: zilnic documente și cota de stocare (apelurile existente), plafonul de membri (`createInvite`: membri + invitații active; `acceptInvite`: depășirea anulează intrarea), `ask.finet`, `reports.custom` (crearea unei definiții), blocarea scrierilor. **Rămân pentru 12-A.2**, pentru că cer schimbări mai adânci: dimensiunea maximă a fișierului pe plan (citirea fișierului se face înainte de a ști planul), tipurile de fișier acceptate, prioritatea cozii în worker, istoricul de bonuri pe plan.

### 7. Ce NU face această schimbare

Nu aplică migrația pe Supabase, nu inserează planuri, nu activează Stripe, nu schimbă `personal`. Fără planuri configurate, un `saas` refuză scrierile (503) în loc să le permită: operatorul trebuie să creeze cel puțin planul implicit înainte de lansare (INFRA 4y).

### 8. Rollback

Funcția și cele două tabele se elimină cu comenzile din antetul migrației (pierde planurile și abonamentele); codul revine la comportamentul anterior prin imaginea precedentă.
