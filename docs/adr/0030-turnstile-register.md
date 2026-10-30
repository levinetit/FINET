# ADR 0030: Cloudflare Turnstile pe înregistrarea publică (Faza 11-C2)

- **Stare:** propus (Faza 11-C2, branch `phase/11-turnstile-oauth`). **Fără migrație.** Doar modul `saas` (în `personal` nu există înregistrare). Fără chei, comportamentul din ADR 0029 rămâne neschimbat.
- **Legături:** ADR 0029 (înregistrare în doi pași), 0003 (autentificare), master prompt Faza 11 (anti-bot). Documentația Cloudflare consultată: siteverify (câmpurile `secret`, `response`, `remoteip`; răspuns `success`, `hostname`, `error-codes`; token ≤ 2048 de caractere, valabil 300 s, de unică folosință) și redarea explicită cu `turnstile.render`/`reset`.
- **OAuth Google/Facebook nu intră aici** (PR separat; vezi „Ce rămâne”).

## Decizii

### 1. Configurare

`TURNSTILE_SITE_KEY` (publică) și `TURNSTILE_SECRET_KEY` (DOAR din `TURNSTILE_SECRET_KEY_FILE`, DOAR rolul web) se dau împreună sau deloc; una singură e o eroare de configurare la pornire. Secretul în clar în mediu e refuzat, iar mesajele de eroare nu îl repetă. Fișierul compose opțional `ops/docker/docker-compose.turnstile.yml` montează secretul ca secret Docker. Fără chei, `POST /api/v1/register` nu cere token și CSP-ul rămâne neschimbat.

### 2. Verificarea pe server: fail-closed

`createTurnstileVerifier` (`src/modules/auth/turnstile.ts`) acceptă DOAR un răspuns 200 cu JSON valid, `success === true` și `hostname` egal cu gazda din `APP_URL`. Orice altceva respinge: eroare de rețea, timeout (5 s), status non-200, JSON invalid sau câmpuri lipsă, token gol sau peste 2048 de caractere (fără apel de rețea). Opusul HIBP-ului (fail-open): aici verificarea ESTE controlul. `remoteip` se trimite doar când IP-ul vine dintr-o sursă de încredere (`trustedClientIp`).

### 3. Ordinea în `POST /api/v1/register`

Origin (CSRF) → schema → limita pe IP → limita pe email → **Turnstile** → crearea contului. Verificarea vine după limitele de rate, ca serverul nostru să nu poată fi folosit ca amplificator către Cloudflare, și înainte de orice scriere: un token lipsă sau respins întoarce același `400 turnstile`, fără cont creat și fără email. Câmpul `turnstileToken` e opțional în schemă (obligatoriu efectiv doar cu chei configurate); fără chei e ignorat.

### 4. CSP: doar pe `/register`

Cu chei configurate, `script-src`, `connect-src` și un `frame-src` nou primesc `https://challenges.cloudflare.com` DOAR pe `/register` (cu sau fără slash final). `/register/complete`, `/login` și restul paginilor rămân neschimbate (testat: `consent.test.ts`). Fără `unsafe-inline`.

### 5. Client

Randare explicită (`turnstile.render`), script încărcat doar în `TurnstileWidget`, pe `/register`. Butonul de trimitere rămâne dezactivat până există un token. Tokenul e de unică folosință: după orice răspuns fără succes (400, 429, rețea), tokenul local se șterge, iar widgetul se resetează.

## Limite și riscuri

- **Rularea CI nu folosește chei Turnstile:** testul E2E `regressions (a)` cere ca paginile publice să încarce resurse doar de pe propriul domeniu, iar `/register` face parte din ele; cheile de test Cloudflare ar încălca regula. Fluxul cu widgetul e acoperit la nivel de API (verificator injectat) și de testele de CSP/configurație, NU de un test în browser cu widget real.
- Un utilizator cu JavaScript dezactivat sau cu widgetul blocat nu se poate înregistra când Turnstile e activ (comportament intenționat).
- Turnstile reduce abuzul automat, nu îl elimină; rămân limitele de rate, verificarea emailului în doi pași și curățarea conturilor neconfirmate (ADR 0029).

## Ce rămâne din 11-C2

OAuth Google/Facebook: în codul curent creează utilizatori doar prin CLI/serviciul FINET, `user.create.before` blochează orice creare Better Auth, `finet_app` nu poate scrie `status`/`is_platform_admin`, iar căile `/sign-in/social` și callback sunt în afara listei permise. Decizia (doar autentificare pentru conturi existente, sau și creare de cont, sau amânare până există credențiale) cere răspunsul operatorului; vezi raportul fazei 11.
