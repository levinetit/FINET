# Politica Cloudflare Access pentru FINET (modul `personal`)

Model de politică, fără valori reale. Emailurile familiei nu se scriu în repo; stau doar în panoul Cloudflare.

## Aplicația
| Câmp | Valoare |
|---|---|
| Tip | Self-hosted |
| Domeniu | `finet.<domeniu>`, toate căile (fără path) |
| Durata sesiunii | 24 h (decizia mea; se poate scurta) |
| Metode de login | One-time PIN; opțional Google |
| Cookie | `SameSite=Lax`, `HttpOnly` (implicite), „Binding Cookie” pornit dacă e disponibil |

## Politici (în ordinea evaluării)
1. **`finet-familie` — Action: Allow**
   - Include → *Emails*: adresele familiei (listă explicită; nu *Emails ending in* pe un domeniu public).
   - Opțional, Require → *Country*: `Romania` (plus țările unde călătorește familia). Doar dacă nu blochează folosirea în concedii.
2. **`finet-familie-warp` — Action: Allow** (telefoanele, aplicația Android)
   - Include → *Emails*: aceleași adrese.
   - Require → *Gateway* (cererea vine printr-un dispozitiv WARP înrolat în organizație), dacă opțiunea e disponibilă în planul tău.
   - Scop: aplicația Android nu poate afișa ecranul de login Access și nu conține un service token (master prompt 3.1); identitatea vine din sesiunea WARP.

Nu există politică **Bypass** sau **Service Auth** pentru FINET:
- `/api/health/live` e doar pentru healthcheck-ul Docker, în container; nu se publică.
- Monitorizarea internă folosește `/api/health` cu antetul `X-Finet-Health-Token` (`HEALTH_TOKEN`), direct pe rețeaua `apps` (`http://finet-web:3000/api/health`), nu prin Cloudflare.

## Ce verifică FINET după Access
`src/proxy.ts` + `src/lib/access.ts`: semnătura RS256 a `Cf-Access-Jwt-Assertion` cu cheile echipei, `aud` = `CF_ACCESS_AUD`, `iss` = `https://CF_ACCESS_TEAM_DOMAIN`, `exp` (toleranță 10 s). Orice eroare → 403 (fail closed). Login-ul FINET (Better Auth, Faza 1) rămâne obligatoriu peste Access.

## Modul `saas` (viitor, Faza 11)
Hostname-ul public nu mai are această politică; protecția vine din WAF/rate limiting Cloudflare și rate limiting-ul FINET. Nu se aplică în Faza 0.
