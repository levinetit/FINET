# Expunerea publică a FINET `saas` (Faza 11-C3, ADR 0031)

Document de decizie și listă de verificare. **Starea implicită nu s-a schimbat:** `src/proxy.ts` cere JWT-ul Cloudflare Access pe orice cale (în afara `/api/health` cu token), iar `CF_ACCESS_REQUIRED=false` rămâne refuzat în producție. Rândurile 2–4 din secțiunea 2 au acum **cod, implicit oprit** (ADR 0034, branch `phase/11-public-edge`): `SAAS_PUBLIC_ACCESS` și `TRUST_CF_CONNECTING_IP`, doar în `saas`. Politicile Cloudflare, WAF, SMTP, juridicul și lansarea rămân ale operatorului. Expunerea publică reală cere modificări de cod și de infrastructură pe care le decide operatorul; ele sunt enumerate mai jos, ca să nu fie descoperite la lansare.

## 1. Situația actuală (verificată în cod)

- Orice cerere către `finet-web` trece prin `proxy.ts` și are nevoie de un JWT Access valid; fără el: 403. Asta include `/`, `/support`, `/register`, `/api/v1/register*` și `/api/auth/*`. Deci site-ul public `saas` și înregistrarea **nu pot fi folosite de un vizitator anonim** nici dacă `APP_MODE=saas` și `SIGNUP_ENABLED=1`.
- IP-ul clientului pentru limitele de rate vine din `CF-Connecting-IP` **doar** când cererea a trecut prin Access (`trustedClientIp`). Fără Access, toți clienții împart grupul „necunoscut” (plafon comun, ADR 0029).
- Producția personală de azi rămâne în spatele Access și nu e afectată de nimic din Faza 11.

## 2. Ce trebuie decis și schimbat ÎNAINTE de expunere (cod)

| # | Subiect | Ce trebuie făcut | Decide |
|---|---|---|---|
| 1 | Politica Access | Fie o politică Access „Bypass” pe căile publice (`/`, `/pricing`, `/terms`, `/privacy`, `/support`, `/register`, `/register/complete`, `/login`, `/api/v1/register`, `/api/v1/register/complete`, `/api/auth/*`, `/_next/static/*`, `/icons/*`, `/manifest.webmanifest`, `/sw.js`), fie renunțarea la Access pentru tot hostul `saas`. Aplicația autentificată (`/dashboard`, `/api/v1/*`) trebuie să fie accesibilă utilizatorilor înregistrați, deci în practică Access nu mai poate fi bariera pentru tot hostul. | operator |
| 2 | Cod: Access opțional în `saas` — **IMPLEMENTAT, oprit implicit (ADR 0034)** | `CF_ACCESS_REQUIRED=false` e refuzat în producție (`src/lib/config.ts`). Pentru un host public e nevoie de o excepție explicită, doar pentru `APP_MODE=saas`, cu verificarea de sesiune rămasă singura barieră (la fel pentru `/api/v1`) și cu teste noi în `proxy.test.ts` care demonstrează că nicio cale privată nu devine publică. NU o face agentul fără o decizie explicită. | operator + dezvoltare |
| 3 | Sursa IP de încredere — **IMPLEMENTAT (`TRUST_CF_CONNECTING_IP`, ADR 0034)**; rămâne la operator: originea accesibilă DOAR prin tunel | Fără Access, `CF-Connecting-IP` poate fi falsificat dacă originea e accesibilă direct. Condiție: originea e accesibilă DOAR prin tunelul Cloudflare (fără port publicat spre internet, regula de firewall pe host), apoi `trustedClientIp` primește o politică „tunel de încredere”. Închide și problema „grupului comun” din ADR 0029. | operator + dezvoltare |
| 4 | Căile administrative — **cod: Access rămâne pe `/admin`, `/api/v1/admin/*` și `/api/health*` (ADR 0034)** | `/admin` și `/api/v1/admin/*` rămân protejate de verificarea de administrator (404 pentru ceilalți); recomandat în plus o politică Access (sau o regulă WAF) doar pe aceste căi, cu autentificare suplimentară. | operator |
| 5 | Health | `/api/health` detaliat rămâne cu `HEALTH_TOKEN`; nu intră în bypass. | operator |

## 3. Infrastructură și operare

- **Cloudflare:** reguli WAF și de rate limiting pe `/api/auth/*` și `/api/v1/register*` (în plus față de limitele aplicației); Bot Fight Mode / reguli de țară dacă se dorește; cache DOAR pentru active statice (`/_next/static/*`), niciodată pentru HTML sau API.
- **Turnstile:** chei configurate și verificate manual (INFRA 4v) înainte de `SIGNUP_ENABLED=1`.
- **Email:** SPF, DKIM și DMARC pe domeniul expeditorului SMTP; linkurile de confirmare trebuie să ajungă (test cu Gmail/Outlook); limită de trimitere la furnizor.
- **Conturi neconfirmate:** curățare periodică (rulată ca `finet_migrator`: aplicația nu poate șterge utilizatori, M5) pentru conturile cu `email_verified = false` mai vechi de 7 zile.
- **Backup și restaurare:** `run-backup.sh` zilnic verificat, ultima restaurare de test recentă (`docs/BACKUP.md`); procedura de rollback a imaginii (INFRA).
- **Monitorizare:** alertă pe `/api/health`, pe rata de 5xx, pe creșterea bruscă a înregistrărilor și pe coada de email; panoul `/admin` (erori interne) verificat zilnic în primele zile.
- **Capacitate:** `finet-web` are 512 MiB și un singur proces; stabilește o țintă de utilizatori simultani și testează (k6) înainte de lansare.
- **Incident:** cine primește alertele, cum se oprește înregistrarea rapid (`SIGNUP_ENABLED=0` + redeploy), cum se dezactivează un cont din `/admin`.

## 4. Juridic și produs (decizii ale operatorului, nu ale agentului)

- Date firmă complete (`SITE_COMPANY_*`, `SITE_CONTACT_EMAIL`) și textele `terms`/`privacy` **revizuite de un jurist** (`SITE_LEGAL_REVIEWED=1`). Traducerea în engleză cere aceeași revizuire; româna e textul de referință.
- Înregistrarea ANSPDCP / evaluarea DPIA dacă e cazul, registrul prelucrărilor, DPA cu furnizorii (găzduire, SMTP, Cloudflare, LiteLLM/AI).
- **Verificarea mărcii „FINET” (listă de verificare, nu consultanță juridică):** căutare în TMview/EUIPO și în baza OSIM pe clasele 9, 36 și 42; verificarea numelui de domeniu și a conturilor sociale; verificarea numelui în Google Play / App Store; numele aplicației în ecranul de consimțământ Google (OAuth) trebuie să fie cel real. Rezultatul îl evaluează un specialist.
- Termenii planurilor plătite (Faza 12) și politica de rambursare înainte de orice plată.

## 5. Listă de lansare (în ordine)

1. Revizuirea `security` a Fazelor 11-A…C, rezolvate sau acceptate explicit.
2. Texte juridice revizuite + date firmă (`SITE_LEGAL_REVIEWED=1`).
3. Turnstile activ și verificat; SMTP cu SPF/DKIM/DMARC.
4. Hotărârile 1–3 din secțiunea 2 implementate, testate și revizuite.
5. Backup + restaurare de test recentă; monitorizare și alerte active.
6. Lansare „soft”: `SIGNUP_ENABLED=1` cu număr limitat de conturi (urmărit în `/admin`), apoi extindere.
7. După o săptămână: curățarea conturilor neconfirmate programată, verificarea logurilor și a costurilor AI.
