# ADR 0027: site-ul public al modului `saas` (Faza 11, partea A)

- **Stare:** propus (Faza 11-A, branch `phase/11-public`). Fără migrație. Nu schimbă nimic în modul `personal` (rutele noi răspund 404; `/` redirecționează ca înainte). Producția personală nu are `saas`: nu se aplică nimic acolo.
- **Legături:** master prompt, Faza 11 (pagini publice, mențiuni legale pentru consumatori, analytics cu Consent Mode v2, acceptare: rutele publice 404 în `personal`); ADR 0006 (moduri), 0020 (PWA).
- **Restul Fazei 11** (panou de administrare, feedback și anunțuri, monitorizarea erorilor, Turnstile, OAuth, traducerea în engleză, expunerea publică) are PR-uri separate (11-B, 11-C).

## Context

Fază 11 cere ca modul `saas` să aibă o față publică: prezentare, prețuri, ghid, termeni, confidențialitate, cu datele firmei și legăturile ANPC SAL / SOL în subsol, iar analytics-ul doar cu consimțământ. Datele firmei și textele juridice nu există în repo și nu le inventez.

## Decizii

### 1. Datele firmei vin din configurație, fără valori implicite

`SITE_COMPANY_NAME`, `SITE_COMPANY_TAX_ID` (CUI), `SITE_COMPANY_REGISTRATION` (nr. Reg. Comerțului, forma `J40/1234/2020`), `SITE_COMPANY_ADDRESS`, `SITE_CONTACT_EMAIL`, `SITE_LEGAL_REVIEWED` (0/1) și `SITE_ANALYTICS_ID` (opțional). Validate la pornire (format), niciuna obligatorie la pornire. `config.site.ready` = datele complete ȘI textele revizuite. Un câmp lipsă apare în subsol ca „[de completat]”, niciodată inventat.

### 2. Textele juridice sunt CIORNE, marcate vizibil

`src/content/legal.ts` conține termenii și politica de confidențialitate scrise din ce face aplicația (date prelucrate, AI extern doar cu acord separat, retenția pozelor, drepturile din Profil, cookie-urile). Nu sunt consultanță juridică. Cât `SITE_LEGAL_REVIEWED` nu e `1`, fiecare pagină juridică arată un banner „text în curs de revizuire” (și, dacă lipsesc datele firmei, spune și asta), iar pagina e `noindex`. **Lansarea publică rămâne blocată de un om** (revizuirea textelor, completarea datelor): codul nu poate declara textele valabile.

### 3. Rutele: doar în `saas`

`/` (prezentare, fără sesiune), `/pricing`, `/terms`, `/privacy`, în grupul `(site)` cu antet, subsol legal și banner de cookie-uri. În `personal` (sau la o configurație ilizibilă) rutele noi dau 404, iar `/` duce la `/login`, ca până acum. Cu sesiune, `/` duce la `/dashboard` în ambele moduri. `/pricing` nu afișează sume (planurile vin în Faza 12). Subsolul conține legăturile ANPC SAL și platforma SOL pe fiecare pagină publică.

### 4. Analytics: doar pe paginile publice, doar după consimțământ

Google Consent Mode v2: la încărcarea paginii, toate semnalele (`analytics_storage`, `ad_storage`, `ad_user_data`, `ad_personalization`) sunt declarate `denied`; „Accept” trece doar `analytics_storage` pe `granted` (reclamele rămân mereu `denied`) și ABIA ATUNCI se încarcă `gtag.js`; „Refuz” nu încarcă nimic. Alegerea stă într-un cookie propriu (`finet_consent`, 180 de zile, Lax, Secure pe https). Fără `SITE_ANALYTICS_ID` nu există banner și nu pleacă nicio cerere către Google. CSP-ul permite domeniile Google DOAR pe cele patru pagini publice și DOAR cu ID setat (`buildCsp(..., { analytics })`); aplicația autentificată rămâne cu CSP-ul strict (`'self'`).

### 5. Ce NU face această parte

Nu deschide înregistrarea (rămâne mesajul „indisponibil”, Turnstile și OAuth sunt 11-C), nu adaugă `/help` public, panoul de administrare, feedback, monitorizarea erorilor, traducerea în engleză sau expunerea publică (WAF, politica Access). Nu verifică numele FINET la OSIM/EUIPO (pas manual al operatorului).

## Consecințe

- Fără pași de deploy pe producția `personal`; `saas` nu rulează nicăieri încă.
- Pentru lansare: completarea celor cinci variabile de firmă, revizuirea de către un om a textelor din `src/content/legal.ts`, apoi `SITE_LEGAL_REVIEWED=1`.
