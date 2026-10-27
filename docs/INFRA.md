# FINET — infrastructură (Docker pe VPS-ul docker-apps)

Decizia de infrastructură: [ADR 0002](adr/0002-deploy-docker-pe-vps.md) (Docker pe `docker-apps`, nu nativ pe LXC 1999). Acest document înlocuiește, pentru deploy, secțiunile 4.2–4.6, 5.2, 6 și 10.1 din `docs/GHID_CONSTRUIRE.md` (ghidul descrie încă varianta nativă și nu a fost modificat).

**Starea la 2026-10-27:** nimic nu e deployat. Agentul n-a atins serverul: n-a creat directoare, n-a pornit containere FINET, n-a modificat Traefik, firewall-ul, Portainer sau Cloudflare. Toți pașii de mai jos îi face operatorul.

## 1. Faptele despre VPS (sursa: documentația hostului și comenzi doar de citire, 2026-10-27)

| Ce | Valoare |
|---|---|
| Host | `docker-apps`, Linux, LXC pe un Proxmox VE separat; ~50 de containere |
| Acces | utilizatorul de lucru `claude` nu e în grupul `docker`; operatorul rulează `docker` cu `sudo` |
| Disc | `/dev/sda3` 194 GB, **~56 GB liberi (72% ocupat)** → pragul de 8 GB din Faza 0 e îndeplinit |
| RAM | ~12 GB total, **~1,1–2,4 GB disponibili** la măsurători (host încărcat) |
| Rețea | bridge extern `apps`, `172.88.88.0/24`, gateway `.1`; serviciile de lungă durată au IP static; coliziuni de alias DNS (`db`, `mariadb`) → nume de container unice |
| Traefik | `traefik-main` (stack Portainer 297, `172.88.88.2`), config în `/home/docker-apps/traefik/` (`traefik.yml` + dinamic în `conf/`), TLS Let's Encrypt prin DNS-01 Cloudflare. Celelalte servicii folosesc entrypoint-ul `websecure` și certresolver-ul `letsencrypt` (label-uri observate); `traefik.yml` nu a putut fi citit (root) |
| Tunel | `cloudflare-tunnel` (stack 244, `172.88.88.89`), gestionat din panoul Cloudflare |
| Firewall | ALLOWLIST (`levinetit-firewall.service`): orice port publicat nou e închis implicit. FINET **nu publică porturi** |
| Administrare | stack-uri Portainer (`portainer/config/compose/<id>/`) sau compose local `cd /home/docker-apps/<serviciu> && docker compose up -d` |
| AI pe host | `ollama` și `litellm-apps` pe `apps` (de evaluat în Faza 6) |
| Acces Cloudflare și Supabase | **doar operatorul**; agentul nu are chei API |

## 2. Harta de rețea

```
Internet ──HTTPS──> Cloudflare (Access: emailurile familiei; WARP pentru telefoane)
                      │
   Varianta A (recomandată)                      Varianta B
   tunel (conexiune de ieșire)                   DNS proxied → IP public:443
                      │                                   │
              cloudflare-tunnel 172.88.88.89      traefik-main 172.88.88.2
                      │        rețeaua `apps` (172.88.88.0/24)     │
                      └──────────────> finet-web:3000 <────────────┘
                                       172.88.88.130 (de confirmat)
                                           │  verifică JWT Cf-Access-Jwt-Assertion
                                           │  (src/proxy.ts, fail closed)
                       finet-worker 172.88.88.131 (stub, profilul `worker`)
                                           │
                                  TLS (verify-full) ──> Supabase (UE): Postgres prin pooler
```

Fără porturi pe host: singurele căi către FINET sunt tunelul și (opțional) Traefik, ambele pe `apps`.

## 3. Deploy-ul Docker

Fișiere din repo:
- `Dockerfile`: multi-stage (deps → build → runner), Next.js `standalone`, user `node` (uid 1000), healthcheck pe `/api/health/live`.
- `ops/docker/docker-compose.yml`: serviciile `finet-web` și `finet-worker`.
- `ops/docker/compose.env.example`: variabilele de interpolare (`FINET_HOST`, `FINET_IMAGE`, `FINET_ENV_FILE`, `FINET_DATA_DIR`, `FINET_WEB_IP`, `FINET_WORKER_IP`, `FINET_TRAEFIK_ENABLE`, `FINET_CERTRESOLVER`).
- `ops/docker/finet.env.example`: modelul mediului aplicației.

Ce fixează compose-ul (au prioritate față de `env_file`): `NODE_ENV=production`, `APP_MODE=personal`, `CF_ACCESS_REQUIRED=true`, `STORAGE_DRIVER=local`, `STORAGE_DIR=/data/storage`, `HOSTNAME=0.0.0.0`, `PORT=3000`, `NODE_OPTIONS`.

Întărire: `read_only: true` (tmpfs pentru `/tmp` și `/app/.next/cache`), `cap_drop: [ALL]`, `no-new-privileges`, `init: true`, `pids_limit`, limite de memorie (web 512 MB, worker 256 MB; `memswap_limit` egal, fără swap) și CPU (1,0 / 0,5), loguri `json-file` 3×10 MB.

**Riscul de memorie:** cu ~1,1 GB disponibili pe host, `finet-web` (până la 512 MB) poate pune presiune pe celelalte servicii; sub OOM, kernelul omoară procese din containere. Valoarea reală a consumului **nu a fost măsurată** pe host (NOT RUN). Build-ul imaginii pe host (`--build`) cere temporar ~1,5 GB (`NODE_OPTIONS=--max-old-space-size=1536` în etapa de build): fă-l când hostul are memorie liberă sau construiește imaginea în altă parte.

**Workerul (decizia mea):** în Faza 0 nu există cod de worker (pg-boss vine în Faza 5/6). Serviciul există, ca structura să fie gata, dar e în profilul `worker`, deci **nu pornește implicit**; dacă e pornit, e un proces Node minimal care scrie „finet-worker: inactiv, vine în Faza 6” și răspunde la SIGTERM. Healthcheck-ul moștenit din imagine (server web) e dezactivat pentru el.

**Storage:** `STORAGE_DRIVER=local`, `STORAGE_DIR=/data/storage`, bind mount din `${FINET_DATA_DIR}/storage`, cu `create_host_path: false` (directorul trebuie creat de operator, deținut de uid 1000, mod 700). În Faza 0, `STORAGE_DRIVER=s3` dă `storage: unknown` și `/api/health` = `degraded` (driverul S3 e un schelet; vine în Faza 6).

### Supabase din container
`DATABASE_URL` cu `sslmode=verify-full` are nevoie de certificatul CA Supabase în container. Driverul `postgres` folosește CA-urile de sistem ale Node; dacă certificatul Supabase nu e acceptat de acestea, operatorul montează CA-ul (de exemplu `/home/docker-apps/finet/supabase-ca.crt:/run/finet/supabase-ca.crt:ro`) și setează `NODE_EXTRA_CA_CERTS=/run/finet/supabase-ca.crt` în `finet.env`. **NOT RUN**: conexiunea la Supabase n-a fost încercată (nu există proiect).

### Liveness și monitorizare
- Healthcheck-ul Docker cere `http://127.0.0.1:3000/api/health/live` din interiorul containerului. `src/proxy.ts` îl lasă fără JWT doar dacă `Host` e loopback și lipsesc antetele de proxy (`cf-connecting-ip`, `cf-ray`, `cf-ipcountry`, `x-real-ip`, `cf-access-jwt-assertion`), iar `X-Forwarded-*` indică tot loopback.
- **`/api/health/live` nu se publică** prin Traefik sau tunel: routerul Traefik îl exclude (`!Path(...)`), iar prin tunel cererea are antete Cloudflare și cere Access. În tunel nu se setează „HTTP Host Header” la o adresă loopback.
- **Limitare cunoscută:** un alt container de pe `apps` care cere `http://finet-web:3000/api/health/live` cu antetul `Host: 127.0.0.1` primește „ok”. Răspunsul nu expune nimic în afară de „procesul răspunde”.
- Monitorizarea internă (agent-queue, n8n etc.) folosește `GET http://finet-web:3000/api/health` cu antetul `X-Finet-Health-Token: <HEALTH_TOKEN>` (minimum 32 de caractere, `openssl rand -hex 32`). Fără `HEALTH_TOKEN` setat, `/api/health` cere JWT Access.
- `/api/health` întoarce `ok`/`degraded` (200) sau `down` (503), cu `db`, `storage`, `queue`, `ai` (ultimele două `unknown` până în fazele lor) și `diskFreePercent`.

## 4. Pașii operatorului, în ordine

1. **Decide** varianta de intrare (A tunel, recomandat; B Traefik) și locul fișierelor (propunere `/home/docker-apps/finet/`).
2. **Supabase:** `ops/supabase/README.md` (proiect UE, Data API oprit, SSL, Network Restrictions pe IP-ul de ieșire al VPS-ului, `roles.sql` cu psql, bucket privat). Actualizează `ops/postgres/VERSION` cu versiunea reală.
3. **Cloudflare:** `ops/cloudflare/README.md` (hostname, ruta în tunel sau DNS pentru Traefik, aplicația Access după `access-policy.md`, WARP). Notează `CF_ACCESS_TEAM_DOMAIN` și `CF_ACCESS_AUD`.
4. **Directoare și fișiere pe server:**
   ```bash
   sudo install -d -o root -g root -m 755 /home/docker-apps/finet
   sudo install -d -o 1000 -g 1000 -m 700 /home/docker-apps/finet/storage
   sudo install -o root -g root -m 600 ops/docker/finet.env.example /home/docker-apps/finet/finet.env
   sudo install -o root -g root -m 600 ops/docker/compose.env.example /home/docker-apps/finet/compose.env
   sudoedit /home/docker-apps/finet/finet.env /home/docker-apps/finet/compose.env
   ```
5. **IP-uri:** confirmă că `172.88.88.130`/`.131` sunt libere (inclusiv pentru containerele oprite care au IP static în compose-urile lor):
   ```bash
   sudo docker network inspect apps --format '{{range .Containers}}{{.IPv4Address}} {{.Name}}{{"\n"}}{{end}}'
   sudo grep -rn "172.88.88.13[01]" /home/docker-apps/portainer/config/compose/ /home/docker-apps/*/docker-compose.yml
   ```
6. **Traefik (doar varianta B):** confirmă numele resolverului în `/home/docker-apps/traefik/traefik.yml` și entrypoint-ul `websecure`; `FINET_TRAEFIK_ENABLE=true` în `compose.env`.
7. **Validare și pornire**, din checkout-ul repo-ului:
   ```bash
   sudo docker compose -f ops/docker/docker-compose.yml --env-file /home/docker-apps/finet/compose.env config
   sudo docker compose -f ops/docker/docker-compose.yml --env-file /home/docker-apps/finet/compose.env up -d --build finet-web
   sudo docker ps --filter name=finet-web    # trebuie să ajungă (healthy)
   sudo docker logs --tail 50 finet-web       # fără erori de configurație
   ```
8. **Notificări:** completează Telegram sau SMTP + `NOTIFY_EMAIL_TO` în `finet.env`, apoi:
   ```bash
   sudo sh ops/notify/notify.sh --env-file /home/docker-apps/finet/finet.env --dry-run --test
   sudo sh ops/notify/notify.sh --env-file /home/docker-apps/finet/finet.env --test
   ```
9. **Acceptarea** (secțiunea 6).

Rollback: `sudo docker compose -f ops/docker/docker-compose.yml --env-file /home/docker-apps/finet/compose.env down` (nu șterge `/home/docker-apps/finet/`; nu există volume Docker numite).

## 5. Supabase: conexiuni și limite
| Ce | Valoare |
|---|---|
| Regiune | UE, propunere Frankfurt `eu-central-1` (de confirmat la creare) |
| Versiune PostgreSQL | provizoriu `17` (`ops/postgres/VERSION`), de înlocuit cu cea reală |
| Limita de conexiuni a planului (pooler, directe) | **TODO operator** (din panou, după alegerea planului) |
| Pool-uri FINET | `/api/health`: 1 conexiune (`max: 1`); restul se dimensionează în Faza 1, sub limita planului |
| Plan | **TODO operator** (ADR separat; planul gratuit suspendă proiectul și nu are backup-uri descărcabile) |

## 6. Acceptarea Fazei 0 (master prompt, Faza 0)

| # | Criteriu | Stare |
|---|---|---|
| 1 | Aplicația răspunde pe hostname-ul Cloudflare, pe HTTPS, doar după login Access cu un email permis | NOT RUN – așteaptă operatorul |
| 2 | Un email nepermis e refuzat | NOT RUN – așteaptă operatorul |
| 3 | O cerere directă către server, ocolind tunelul, nu primește răspuns | NOT RUN – așteaptă operatorul (cu varianta B primește 403, abatere de notat) |
| 4 | Un telefon cu WARP înrolat ajunge la `/api/health` | NOT RUN – așteaptă operatorul |
| 5 | `/api/health` e verde (`ok`) | NOT RUN – așteaptă operatorul (cere Supabase; fără `DATABASE_URL` e `degraded`) |
| 6 | CI e verde | NOT RUN – așteaptă PR-ul pe GitHub (verificările echivalente au trecut local, vezi `docs/reports/faza-0.md`) |
| 7 | Testele pentru bani trec | trecut local (Vitest), vezi raportul |
| 8 | Conectare la Supabase prin pooler cu `sslmode=verify-full` | NOT RUN – așteaptă operatorul |
| 9 | Tabelele din `finet` nu sunt accesibile prin Data API cu cheia `anon` | NOT RUN – așteaptă operatorul (nu există încă tabele; testul automat vine cu primul tabel) |
| 10 | Conexiune la bază de pe alt IP decât al serverului refuzată | NOT RUN – așteaptă operatorul |
| 11 | Notificarea de test a ajuns | NOT RUN – așteaptă operatorul (`--dry-run` testat local) |
| 12 | Containerul `finet-web` pornește pe host și ajunge `healthy` | NOT RUN – așteaptă operatorul |

## 7. Upgrade PostgreSQL (master prompt 3.5)
1. Jobul săptămânal anunță versiunea nouă (`ops/postgres/version-check.md`, **neimplementat**), sau operatorul o vede în panou.
2. PR care rulează testele pe `postgres:<versiunea nouă>-alpine` (local sau în CI, schimbând temporar `ops/postgres/VERSION` pe branch).
3. Backup propriu verificat (`pg_dump` + fișiere, restic; Faza 3 — până atunci, upgrade-ul se amână).
4. Notează valorile de control: numărul și suma tranzacțiilor pe gospodărie (interogare din Faza 3).
5. Anunț către familie; fereastră de noapte.
6. Supabase → Settings → Infrastructure → Upgrade project.
7. După: `/api/health` = `ok`; valorile de control identice; `docker logs finet-web` fără erori.
8. PR: `ops/postgres/VERSION` și imaginea din `.devcontainer/docker-compose.yml` actualizate.
9. Dacă verificarea eșuează: restaurare din backup într-un proiect nou și comutarea `DATABASE_URL`.

## 8. Notificări operaționale
`ops/notify/notify.sh`: Telegram (`NOTIFY_TELEGRAM_BOT_TOKEN` + `NOTIFY_TELEGRAM_CHAT_ID`) sau email (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `NOTIFY_EMAIL_TO`), `--test`, `--dry-run`, `--env-file`. Folosește `curl` (pe host); secretele nu apar în argumentele proceselor. Scripturile care îl vor folosi (backup, versiune PostgreSQL, `/api/health` roșu, disc) **nu există încă**.
