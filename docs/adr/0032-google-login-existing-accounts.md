# ADR 0032: autentificarea cu Google pentru conturi existente (Faza 11-C2, partea OAuth)

- **Stare:** propus (branch `phase/11-oauth`). **Fără migrație.** Doar `APP_MODE=saas`, doar cu `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET_FILE`. Fără credențiale nimic nu se schimbă (căile rămân 404).
- **Decizia operatorului (2026-10-31):** „doar login pentru conturi existente”, Google înaintea Facebook.
- **Legături:** ADR 0003 (autentificare, lista permisă a căilor), 0029 (înregistrare), master prompt Faza 11 (OAuth, cu analiza de confidențialitate).

## Decizii

### 1. Doar autentificare, fără creare de cont

`socialProviders.google.disableSignUp = true`: pentru un email necunoscut, Better Auth se oprește cu `signup_disabled` ÎNAINTE de orice scriere (verificat în `handleOAuthUserInfo`, anterior hook-ului `user.create.before`, care rămâne `false` ca a doua barieră). Un cont nou se creează doar prin înregistrarea în doi pași (ADR 0029) sau de operator.

### 2. Legarea unui cont Google de un cont FINET existent

Better Auth leagă contul Google de utilizatorul cu același email doar dacă TOATE sunt adevărate: furnizorul declară `email_verified`, emailul local e verificat (`requireLocalEmailVerified`), `allowDifferentEmails=false`. **Google NU e în `trustedProviders`**: pentru un furnizor „de încredere” Better Auth nu mai verifică declarația `email_verified` a furnizorului, iar un cont Google poate avea un email neverificat. Consecințe testate: cont local neverificat (înregistrare neterminată) → `account_not_linked`; Google cu `email_verified=false` → nu se leagă; același cont Google (`sub`) cu alt email → se autentifică ca proprietarul legat, nu ca alt utilizator.

### 3. Datele păstrate: minime

`databaseHooks.account.create.before` șterge jetoanele (acces, reîmprospătare, id) și `scope` înainte de scriere: după autentificare nu apelăm API-urile Google, deci în `auth_accounts` rămân doar `provider_id`, `account_id` (`sub`) și `user_id`. `updateAccountOnSignIn=false` (altfel Better Auth ar scrie jetoane la fiecare autentificare, iar `finet_app` are UPDATE doar pe `password`/`updated_at`) și `updateUserInfoOnLink=false` (nu rescrie numele sau poza). Scope-uri: doar `openid email profile`, `prompt=select_account`.

### 4. Cod și protecții

- Config: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (doar din `_FILE`, doar rolul web, împreună sau deloc, doar `saas`; în `personal` setarea e eroare).
- Lista permisă a căilor: `/sign-in/social` și `/callback/google` se permit doar cu furnizorul configurat (`isOAuthAuthPath`); `/link-social`, `/unlink-account`, `/list-accounts` rămân închise. `disabledPaths` scoate `/sign-in/social` doar în acest caz.
- Pornirea fluxului (`POST /sign-in/social`) trece prin `handler.ts`: doar JSON, rate limiting (găleata de login, pe IP).
- Sesiunea: aceleași hook-uri ca la parolă (utilizator `active`, audit `auth.login_succeeded` cu `method: "google"`).
- Erorile (`?error=` de la Better Auth) duc la `/login`, unde se afișează un mesaj fix; valoarea din URL nu se afișează.
- UI: butonul „Continuă cu Google” pe `/login` doar când furnizorul e activ; navighează doar către `https://accounts.google.com/`.

### 5. Facebook: nu

Facebook nu garantează un email verificat, deci legarea automată ar fi nesigură (și nu se poate adăuga în `trustedProviders`). În plus, fără o interfață de legare a conturilor din setări (`/link-social` e închis intenționat), un cont existent nu s-ar putea lega niciodată de Facebook, deci „login doar pentru conturi existente” nu ar avea cum să funcționeze. Reluarea cere o decizie separată (interfața de legare din Profil sau creare de cont).

## Limite și riscuri

- Testat cu un furnizor simulat (schimbul de cod stubuit), pe Better Auth 1.7.13 și PostgreSQL 17 reale; **nu** cu Google real (nu există credențiale în CI). Verificarea manuală cu credențiale reale e în INFRA 4w.
- În callback, Better Auth citește `id_token`-ul primit direct de la endpointul de jetoane Google prin TLS (fără verificarea semnăturii, permisă de OIDC pentru acest canal); o actualizare Better Auth care schimbă asta trebuie verificată la upgrade (testele rămân barieră).
- Ecranul de consimțământ Google (nume aplicație, domeniu, politică de confidențialitate publicată, verificarea brandului) e pregătit de operator în Google Cloud Console; vezi `docs/EXPOSURE.md` (marcă).
