# ADR 0029: înregistrarea publică în doi pași și pagina de suport (Faza 11-C1)

- **Stare:** propus (Faza 11-C1, branch `phase/11-public`). **Fără migrație** (folosește `users.email_verified`, `auth_accounts` și `auth_rate_limits` existente). Doar modul `saas`; în `personal` rutele și paginile dau 404.
- **Legături:** master prompt Faza 11 (înregistrare cu verificarea emailului, anti-bot, `/help` public); ADR 0003 (autentificare), 0027 (site public), 0028 (administrare).
- **Ce NU intră aici (11-C2/C3):** Turnstile (cere chei Cloudflare), OAuth Google/Facebook (cere credențiale și analiza de confidențialitate), traducerea în engleză, expunerea publică efectivă.

## Decizii

### 1. Închisă implicit, deschisă doar explicit

`/register` și `POST /api/v1/register*` există doar dacă TOATE sunt adevărate: `APP_MODE=saas`, `SIGNUP_ENABLED=1` și SMTP configurat (fără email nu se poate verifica nimic). Altfel: pagina arată un mesaj onest („încă nu e deschisă”), iar API-ul răspunde 404. `/api/auth/sign-up/email` rămâne închis în Better Auth în toate cazurile; înregistrarea trece printr-un serviciu FINET (`createUserWithHousehold`), cu `firstUserBecomesAdmin: false` fixat în cod (nimeni nu devine administrator al platformei pe această cale, nici pe o bază goală; testat).

### 2. Doi pași: parola o alege proprietarul adresei

Dacă formularul ar cere și parola, cineva ar putea crea un cont pe adresa altuia cu parola lui, iar confirmarea făcută ulterior de proprietar i-ar da acces atacatorului. De aceea:

1. `POST /api/v1/register` `{ email, name, acceptTerms: true }` creează un utilizator **neverificat, fără parolă** (gospodărie personală, preferințe, audit `user.created`) și trimite linkul de confirmare. Parola nu trece prin această cerere.
2. `POST /api/v1/register/complete` `{ token, password }`: linkul semnat + parola aleasă de cel care a primit emailul. Într-o tranzacție: `email_verified = true` (UPDATE condiționat de `email_verified = false`, deci linkul e de unică folosință) și parola. Audit `user.email_verified`.

O parolă respinsă de politică (10–128 de caractere, HIBP dacă e activat) întoarce 400 `password` și NU consumă linkul. Un cont neverificat nu are credențiale, deci nu se poate autentifica; magic link-ul (dacă SMTP există) dovedește oricum proprietatea adresei.

### 3. Token fără tabel nou

Token semnat HMAC-SHA256 cu `BETTER_AUTH_SECRET` (cu un prefix de scop `finet.register.v1`), conținând utilizatorul, emailul și expirarea (48 de ore); comparația semnăturii e în timp constant. Verificarea cere în plus: utilizatorul există, e `active`, emailul din token e al lui, iar emailul NU e încă verificat. Am preferat asta mecanismului `verification` din Better Auth (care ar fi cerut deschiderea căilor `/verify-email` și `/send-verification-email`, închise intenționat în ADR 0003) și unui tabel nou (migrație). Consecință: rotirea secretului invalidează linkurile în curs (48 de ore, acceptabil).

### 4. Fără enumerarea conturilor

`POST /register` întoarce același `202 { status: "pending" }` indiferent dacă adresa e nouă, neconfirmată sau cu cont. Hash-ul parolei nu mai există în acest pas, iar emailul se trimite în fundal (timp de răspuns independent de SMTP și de existența adresei). Adresă cu cont verificat → mesaj „ai deja un cont” cu link spre autentificare; adresă neconfirmată → link nou (cel vechi rămâne bun o singură dată, primul care se folosește îl consumă).

### 5. Protecții

- **CSRF:** `Origin` identic cu `APP_URL` (sau `Sec-Fetch-Site: same-origin`), altfel 403; doar `application/json`, corp ≤ 16 KiB, schemă Zod strictă.
- **Rate limiting** (`auth_rate_limits`, două genuri noi `register`, `register_ip`): pe IP + email (aceeași regulă ca emailurile de autentificare, 3/oră) și pe IP singur (10/oră; 60/oră ca plafon COMUN când nu există IP de încredere, adică în afara Cloudflare Access) — la pasul 2, pe IP, contra ghicirii tokenurilor.
- **Anti-bot:** Turnstile NU e implementat aici. Până la 11-C2, `SIGNUP_ENABLED` trebuie să rămână `0` pe orice deploy expus public (vezi INFRA 4u).
- **Termeni:** `acceptTerms` trebuie să fie `true`; textele juridice rămân ciorne până la `SITE_LEGAL_REVIEWED=1` (decizia operatorului), deci deschiderea publică înainte de revizuire înseamnă acceptarea unor ciorne.

### 6. Pagina publică de suport

`/support` (grupul `(site)`: subsol legal, ANPC SAL/SOL, bannerul de cookie-uri, `noindex` până site-ul e gata) cu șase răspunsuri scurte și contactul din `SITE_CONTACT_EMAIL` (sau „de completat”). Numele nu e `/help`: acela e deja ghidul autentificat din Faza 9 (ADR 0020), păstrat. `/support` e în `PUBLIC_SITE_PATHS`; `/register` și `/register/complete` NU sunt (colectează parole: fără analytics și fără CSP relaxat; testat).

## Limite cunoscute

- Conturile create și neconfirmate rămân în bază (aplicația nu poate șterge utilizatori, M5): o curățare periodică (de operator, ca `finet_migrator`) e de adăugat înainte de expunerea publică; nu consumă resurse notabile (un rând + gospodărie goală).
- Fără IP de încredere (fără Access), limitele pe IP sunt comune tuturor clienților: expunerea publică trebuie să stabilească sursa IP (Cloudflare `CF-Connecting-IP` doar de la proxy-ul de încredere) înainte de deschidere.
