# Cloudflare pentru FINET (pașii operatorului)

Doar operatorul are acces la Cloudflare (domeniu, tunel, Access, WARP). Agentul nu are chei API Cloudflare și nu a rulat nimic de aici. Hostname-ul real nu e ales în repo: peste tot apare `finet.<domeniu>`.

Contextul VPS-ului (rețeaua `apps`, `cloudflare-tunnel`, `traefik-main`, firewall-ul allowlist) e în `docs/INFRA.md`. Numele meniurilor Cloudflare se pot schimba; caută opțiunea după nume dacă nu e la calea indicată.

## 1. Alege varianta de intrare

| | **A. cloudflare-tunnel (recomandată, decizia mea)** | B. traefik-main |
|---|---|---|
| Cum ajunge cererea | Cloudflare → tunelul existent (`cloudflare-tunnel`, `172.88.88.89`) → `http://finet-web:3000` pe rețeaua `apps` | Cloudflare (DNS proxied) → IP-ul public al VPS-ului, port 443 → Traefik → `finet-web:3000` |
| Port deschis pe host | niciunul nou | 443, deja deschis pentru alte servicii |
| Cerere directă la IP-ul serverului | nu ajunge la FINET (nu există rută) | ajunge la Traefik; FINET răspunde 403 fără JWT Access |
| Ce trebuie în compose | nimic (`FINET_TRAEFIK_ENABLE=false`) | `FINET_TRAEFIK_ENABLE=true`, `FINET_HOST`, resolverul confirmat |

Acceptarea Fazei 0 cere ca o cerere directă, care ocolește tunelul, să **nu primească răspuns**: doar varianta A îndeplinește asta exact. Cu B, cererea primește 403 (aplicația e fail-closed), ceea ce trebuie notat ca abatere.

## 2. Domeniul și DNS-ul
1. Domeniul e deja în Cloudflare (zona folosită de celelalte servicii). Alege subdomeniul, de exemplu `finet.<domeniu>`.
2. Varianta A: înregistrarea DNS o creează tunelul la pasul 3 (CNAME către `<id-tunel>.cfargotunnel.com`, proxied).
3. Varianta B: înregistrare A/AAAA către IP-ul VPS-ului, **proxied** (portocaliu), altfel Access nu se aplică.

## 3. Varianta A: ruta în tunelul existent
Containerul `cloudflare-tunnel` (stack Portainer 244) e gestionat din panou (token). Pași:
1. Cloudflare One (Zero Trust) → Networks → Tunnels → tunelul existent → **Public Hostname → Add**.
2. Subdomeniu `finet`, domeniul tău, **Service: `HTTP` → `finet-web:3000`** (numele containerului, nu un alias generic: pe `apps` există coliziuni de alias).
3. La „Additional application settings → HTTP Settings”: **nu** seta „HTTP Host Header” la `127.0.0.1` sau `localhost`. Antetul `Host` trebuie să rămână hostname-ul public; altfel liveness-ul local ar putea fi atins prin tunel (vezi `docs/INFRA.md`, „Liveness”).
4. Opțional, apărare în plus: o regulă de hostname cu path `^/api/health/live$` pentru același subdomeniu, pusă **înaintea** regulii principale, cu serviciul `http_status:404`, dacă panoul permite acest tip de serviciu. Aplicația refuză oricum cererea (are antete Cloudflare), deci regula e opțională.

Echivalentul pentru un tunel gestionat local (`config.yml`), doar ca referință; tunelul de pe docker-apps nu folosește un astfel de fișier:

```yaml
ingress:
  - hostname: finet.<domeniu>
    path: ^/api/health/live$
    service: http_status:404
  - hostname: finet.<domeniu>
    service: http://finet-web:3000
  - service: http_status:404
```

## 4. Access (doar familia)
1. Access → Applications → **Add an application → Self-hosted**, domeniul `finet.<domeniu>` (toate căile).
2. Politica: vezi `ops/cloudflare/access-policy.md`.
3. Metode de login: One-time PIN (cod pe email), plus Google dacă vrei.
4. Notează:
   - **Application Audience (AUD) Tag** (în pagina aplicației, Overview sau Basic information) → `CF_ACCESS_AUD`;
   - **team domain**-ul (`<echipa>.cloudflareaccess.com`, în Settings → Custom Pages sau în URL-ul de login) → `CF_ACCESS_TEAM_DOMAIN`, fără `https://` și fără cale.
5. Le scrii în `/home/docker-apps/finet/finet.env` (nu sunt secrete propriu-zise, dar nu se pun în repo). FINET verifică cu ele JWT-ul `Cf-Access-Jwt-Assertion` (cheile publice de la `https://<team-domain>/cdn-cgi/access/certs`, audiența, emitentul).

**Nu** se creează un service token pentru FINET și nici o politică „Bypass”: liveness-ul nu se publică, iar monitorizarea internă folosește `HEALTH_TOKEN` din rețeaua `apps`.

## 5. Telefoanele (WARP / Cloudflare One Agent)
1. Settings → WARP Client → **Device enrollment permissions**: aceleași emailuri ale familiei.
2. Pe fiecare telefon: aplicația **Cloudflare One** din Google Play → Zero Trust → numele echipei → login cu emailul.
3. Politica Access trebuie să accepte identitatea venită prin WARP (vezi `access-policy.md`, regula pentru dispozitive).

## 6. Verificări de acceptare (toate NOT RUN – așteaptă operatorul)
| # | Verificare | Așteptat |
|---|---|---|
| 1 | Browser, email permis, `https://finet.<domeniu>` | pagina FINET, pe HTTPS |
| 2 | Browser, alt email | Access refuză; FINET nu e atins |
| 3 | `curl -sI https://finet.<domeniu>` fără login | redirect 302 către `<echipa>.cloudflareaccess.com` |
| 4 | Cerere directă la IP-ul VPS-ului cu `Host: finet.<domeniu>` (din afara rețelei de acasă; IP-ul de acasă e permis de firewall, deci testul de acasă nu dovedește nimic) | A: niciun răspuns de la FINET; B: 403 de la FINET |
| 5 | `https://finet.<domeniu>/api/health/live` după login | 403 (nu e liveness public) |
| 6 | Telefon cu WARP, `https://finet.<domeniu>/api/health` | JSON cu `status` |
| 7 | `docker logs finet-web` după testele de mai sus | fără JWT-uri sau antete de identitate în log |
