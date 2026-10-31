# ADR 0034: expunerea publică `saas` fără Access pe tot hostul (Faza 11, documentul de expunere, rândurile 2–4)

- **Stare:** propus (branch `phase/11-public-edge`). **Fără migrație.** Implicit OPRIT; nimic nu se schimbă pentru `personal` sau pentru un `saas` fără cele două variabile noi. Nu s-a făcut deploy și nu s-a schimbat nicio politică Cloudflare.
- **Legături:** `docs/EXPOSURE.md` (rândurile 1–5 din secțiunea 2), ADR 0029, 0031, SECURITY_CHECKLIST §37.

## Decizii

### 1. Două variabile explicite, ambele implicit oprite

- `SAAS_PUBLIC_ACCESS=true`: doar cu `APP_MODE=saas` și doar cu Access configurat (`CF_ACCESS_REQUIRED=true`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` rămân obligatorii). În `personal` configurația e INVALIDĂ: serverul nu pornește (și un `proxy` cu mediu invalid răspunde 403 pe tot, fail-closed).
- `TRUST_CF_CONNECTING_IP=true`: doar împreună cu `SAAS_PUBLIC_ACCESS=true`. Declarația operatorului că originea e accesibilă EXCLUSIV prin tunelul Cloudflare (fără port publicat spre internet), deci `cf-connecting-ip` nu poate fi pus de client.

### 2. Ce cere în continuare Access (cu `SAAS_PUBLIC_ACCESS=true`)

`/admin`, `/api/v1/admin/*` și `/api/health*` (rândurile 4 și 5). Potrivirea e conservatoare, `isAccessProtectedPath` în `src/lib/access.ts`: decodare o dată, litere mici, `//` și `\` strânse, orice `..` sau codificare invalidă înseamnă „protejat”; prefixele fără `/` final prind și variantele. Tokenul de sănătate rămâne singura excepție pe `/api/health`, ca înainte. Orice altceva (site-ul public, `/login`, `/register*`, `/api/auth/*`, aplicația, `/api/v1/*`) trece de Access; BARIERA devine sesiunea (rutele respectă deja `requireSession`/`404 pentru non-admin`, testate în suitele existente).

### 3. Sursa IP de încredere (rândul 3)

Până acum, `trustedClientIp` primea `config.access.required` ca „cererea a trecut prin Access”. Cu `SAAS_PUBLIC_ACCESS` nu mai trece orice cerere prin Access, deci acea presupunere ar fi făcut `cf-connecting-ip` falsificabil. Se introduce `config.access.clientIpTrusted` (și toate cele 8 apeluri îl folosesc): `required` fără `publicSaas`, altfel exact `TRUST_CF_CONNECTING_IP`. Fără declarația de tunel, IP-ul clientului e `null` (grupul „necunoscut”, ca în ADR 0029); cu ea, plafoanele pe IP funcționează pe adresa reală.

### 4. Rute excluse din proxy (documente, extrase)

`/api/v1/documents` și `/api/v1/statements/uploads` rulează `guardAccess` cu o cale fixă; cu `publicSaas` același bypass se aplică, iar ele continuă să verifice sesiunea înainte de a citi corpul (ADR 0015/0018), deci un anonim nu poate încărca nimic.

### 5. Ce NU face această schimbare

Nu modifică politicile Cloudflare (Bypass/Access), WAF, rate limiting, SMTP, DNS, Turnstile, textele juridice sau tunelul; nu activează `SIGNUP_ENABLED`; nu face deploy. Acestea rămân ale operatorului (`docs/EXPOSURE.md` secțiunile 3–5). Ordinea sigură la lansare: întâi originea accesibilă doar prin tunel și politica Access „Bypass” pe căile publice (inclusiv excepția pentru `/admin`), apoi variabilele, apoi `SIGNUP_ENABLED=1` „soft”.

### 6. Rollback

Se scot cele două variabile și se redeployează `finet-web`: revine la „Access pe tot”. Fără date de reparat.
