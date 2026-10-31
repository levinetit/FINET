# FINET — infrastructură (Docker pe VPS-ul docker-apps)

Decizia de infrastructură: [ADR 0002](adr/0002-deploy-docker-pe-vps.md) (Docker pe `docker-apps`, nu nativ pe LXC 1999). `docs/GHID_CONSTRUIRE.md` a fost aliniat la această variantă (Docker pe VPS); acest document rămâne sursa detaliată pentru deploy.

**Starea la 2026-10-27:** Supabase e configurat (roluri, schema `finet`, SSL, restricții de rețea, bucket privat `finet-docs`), `finet-web` rulează pe VPS la `172.88.88.130`, iar `finet.levinetit.com` e publicat prin tunelul `vpsde` în spatele Cloudflare Access (doar proprietarul). Pașii de mai jos descriu procedura pentru oricine o reface; ce a rămas neverificat (login Access cu email permis și nepermis, WARP, notificarea reală, conexiune refuzată de pe alt IP) e marcat `NOT RUN` în `docs/reports/faza-0.md`, secțiunea 8.

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
- `ops/docker/docker-compose.yml`: serviciile `finet-web`, `finet-worker` (profilul `worker`), `finet-migrate` (one-shot, profilul `migrate`) și `finet-admin` (CLI-ul de administrare, one-shot, profilul `admin`, F1-B).
- `ops/docker/compose.env.example`: variabilele de interpolare (`FINET_HOST`, `FINET_IMAGE`, `FINET_ENV_DIR`, `FINET_SECRETS_DIR`, `FINET_CA_DIR`, `FINET_DATABASE_CA_NAME`, `FINET_DATA_DIR`, `FINET_WEB_IP`, `FINET_WORKER_IP`, `FINET_TRAEFIK_ENABLE`, `FINET_CERTRESOLVER`). Nu conține secrete.
- `ops/docker/finet.env.example`, `finet.worker.env.example`, `finet.migrate.env.example`: modelele mediului **nesecret**, câte unul pe serviciu. Secretele nu stau în ele (vezi „Secretele ca fișiere”).
- `ops/notify/notify.env.example`: configurația notificărilor, doar pentru `ops/notify/notify.sh` pe host (nu ajunge în niciun container).

### Secrete separate pe rol (`FINET_ROLE`)
Fiecare proces primește doar URL-ul bazei de date al rolului său (`src/lib/config.ts`), ca fișier secret:

| Serviciu | `FINET_ROLE` (fixat în compose) | Secrete (fișiere în `/srv/finet/secrets/`) | Variabila din container | `env_file` (doar nesecret) | Rolul Postgres |
|---|---|---|---|---|---|
| `finet-web` | `web` | `finet_database_url`, `finet_health_token`, `finet_better_auth_secret` | `DATABASE_URL_FILE`, `HEALTH_TOKEN_FILE`, `BETTER_AUTH_SECRET_FILE` | `/srv/finet/env/finet.env` | `finet_app` (pooler, tranzacție 6543) |
| `finet-worker` | `worker` | `finet_worker_database_url` | `WORKER_DATABASE_URL_FILE` | `/srv/finet/env/finet.worker.env` | `finet_app` (pooler, sesiune 5432) |
| `finet-migrate` | `migrate` | `finet_migrate_database_url` | `MIGRATOR_DATABASE_URL_FILE` | `/srv/finet/env/finet.migrate.env` | `finet_migrator` (proprietarul schemei, sesiune 5432) |
| `finet-admin` | `admin` | `finet_database_url` | `DATABASE_URL_FILE` | `/srv/finet/env/finet.admin.env` | `finet_app` (același URL ca web) |

URL-ul altui rol prezent în mediul unui proces, direct sau ca `_FILE`, **oprește pornirea**, cu un mesaj care numește variabila, nu valoarea (mai sigur decât ignorarea tăcută: o greșeală de configurare se vede imediat). Fișierul altui rol nici nu se deschide. Serverul Next.js pornește doar cu `FINET_ROLE=web`. `pnpm test:ops` verifică trei lucruri: fișierele exemplu nu conțin secrete active, compose-ul nu pune secrete în `environment`, iar fiecare serviciu montează doar secretul rolului său (tokenul de sănătate și secretul Better Auth doar `finet-web`).

### Secretele ca fișiere (constatarea N1)
**Problema:** Docker copiază valorile din `environment` și `env_file` în `/home/docker/containers/<id>/config.v2.json`, iar `backup_home_gdrive_clar.sh` urcă duminica o arhivă **necriptată** a `/home/docker` pe Google Drive. Orice secret dat ca variabilă de mediu ajunge acolo.

**Soluția (T7):** secretele FINET sunt fișiere în `/srv/finet/secrets/`, montate de compose prin `secrets:` în `/run/secrets/<nume>`. Aplicația le citește prin `<NUME>_FILE` (`src/lib/secret-files.ts`), o singură dată per instanță a modulului de configurație. Serverul Next le citește la pornire (validarea din `instrumentation`). Proxy-ul (`src/proxy.ts`) are în build propria copie a modulului și le citește la prima cerere (verificat: fișierul tokenului făcut necitibil după pornire → `/api/health` cu tokenul dă 403, fail closed). Fișierul montat rămâne același până la recrearea containerului, deci cele două citiri văd aceeași valoare. În `config.v2.json` apare doar calea montării, nu valoarea.
- Am verificat local, pe Compose 2.26.1, cu un container de probă și o valoare fictivă: valoarea apare de 0 ori în `config.v2.json`, iar fișierul e montat read-only cu proprietarul și modul de pe host (`1000:1000 0400`). Conform documentației Compose (neverificat aici, am testat doar sintaxa scurtă), modul fără swarm nu aplică `uid`/`gid`/`mode` din sintaxa lungă, deci fișierele de pe host trebuie să fie `1000:1000 0400` (uid 1000 = `node`).
- **Regulile fișierelor** (`src/lib/secret-files.ts`):
  - `X` și `X_FILE` setate împreună dau eroare;
  - fișierul trebuie să fie un fișier obișnuit (un symlink spre un fișier e acceptat, un director e refuzat), citibil și de cel mult 4096 octeți, pe o singură linie;
  - se taie un singur sfârșit de linie final; un fișier gol dă eroare;
  - mesajele de eroare nu conțin nici conținutul, nici calea.
- **Variabilele care acceptă `_FILE`:** `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATOR_DATABASE_URL`, `HEALTH_TOKEN`, `NOTIFY_TELEGRAM_BOT_TOKEN`, `SMTP_PASSWORD`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`. `BETTER_AUTH_SECRET` primește varianta `_FILE` în Faza 1, odată cu validarea lui.
- **Ce montează compose-ul:** doar secretele folosite acum, adică URL-urile pe rol și `finet_health_token`. Tokenul e obligatoriu în deploy (decizia mea): fișierul trebuie să existe și să nu fie gol. Telegram și SMTP sunt ale `notify.sh` de pe host (`/srv/finet/env/notify.env`), nu ale containerelor. Când aplicația le va folosi, se adaugă ca secrete noi.
- **`src/proxy.ts` nu s-a schimbat:** citește `HEALTH_TOKEN` din `getConfig()`, care rezolvă deja `HEALTH_TOKEN_FILE`. Verificat pe serverul standalone: `/api/health` cu tokenul din fișier → 200, cu un token greșit → 403. Doar `web` cere `CF_ACCESS_*`; `migrate` nu cere `STORAGE_DIR`. `finet-worker` e încă un stub (workerul vine în Faza 5/6). Din Faza 1, `finet-migrate` folosește imaginea de unelte `finet:tools` (ținta `tools` din `Dockerfile`) și aplică migrațiile reale (`node dist/tools/migrate.mjs`, ADR 0003), idempotent, cod ≠ 0 la eroare; URL-ul trebuie să fie în modul sesiune (5432). `finet-migrate` rulează pe rețeaua implicită a proiectului (`finet_default`), nu pe `apps`, fără IP static.

Ce fixează compose-ul în `environment` (au prioritate față de `env_file`): `FINET_ROLE`, `NODE_ENV=production`, `APP_MODE=personal`, `CF_ACCESS_REQUIRED=true` (web), `STORAGE_DRIVER=local`, `STORAGE_DIR=/data/storage` (doar web; workerul nu are storage din Faza 5, I1), `HOSTNAME=0.0.0.0`, `PORT=3000`, `NODE_OPTIONS`, căile secretelor (`DATABASE_URL_FILE` și `HEALTH_TOKEN_FILE` la web, `WORKER_DATABASE_URL_FILE` la worker, `MIGRATOR_DATABASE_URL_FILE` la migrate) și `DATABASE_CA_FILE` (toate trei).

Întărire: `read_only: true` (tmpfs pentru `/tmp` și `/app/.next/cache`), `cap_drop: [ALL]`, `no-new-privileges`, `init: true`, `pids_limit`, limite de memorie (web 512 MB, worker 150 MB din Faza 5; `memswap_limit` egal, fără swap) și CPU (1,0 / 0,5), loguri `json-file` 3×10 MB.

**Riscul de memorie:** cu ~1,1 GB disponibili pe host, `finet-web` (până la 512 MB) poate pune presiune pe celelalte servicii; sub OOM, kernelul omoară procese din containere. Valoarea reală a consumului **nu a fost măsurată** pe host (NOT RUN). Build-ul imaginii pe host (`--build`) cere temporar ~1,5 GB (`NODE_OPTIONS=--max-old-space-size=1536` în etapa de build): fă-l când hostul are memorie liberă sau construiește imaginea în altă parte.

**Workerul:** din Faza 5 (ADR 0011) e workerul pg-boss real (recurențele), rulat din imaginea de unelte (`node dist/tools/worker.mjs`), cu `mem_limit: 150m` (măsurat: RSS de vârf ~86 MB). Rămâne în profilul `worker`, deci **nu pornește implicit**; pornirea pe producție: secțiunea 4g. Healthcheck-ul Docker e dezactivat (fără HTTP); starea lui apare în `/api/health` ca `queue` (semnalul din `finet.service_heartbeats`: `ok`, `degraded` peste 180 s fără semnal, `unknown` dacă e oprit).

**Storage:** `STORAGE_DRIVER=local`, `STORAGE_DIR=/data/storage`, bind mount din `${FINET_DATA_DIR}/storage` (implicit `/srv/finet/storage`, în afara backup-ului de `/home`), cu `create_host_path: false` (directorul trebuie creat de operator, deținut de uid 1000, mod 700). În Faza 0, `STORAGE_DRIVER=s3` dă `storage: unknown` și `/api/health` = `degraded` (driverul S3 e un schelet; vine în Faza 6).

### Supabase din container (TLS, `DATABASE_CA_FILE`)
URL-urile Supabase au `sslmode=verify-full`. CA-ul Supabase (`prod-ca-2021.crt`, din panou: Settings → Database → SSL) e public, deci nu e un secret. Stă în `/srv/finet/ca/` (644), montat read-only în `/run/finet/ca` (compose: `x-ca-volume`), iar `DATABASE_CA_FILE=/run/finet/ca/${FINET_DATABASE_CA_NAME}` e fixat în `environment` pentru toate cele trei servicii.

**Cum se folosește CA-ul** (`src/lib/db-client.ts`, clientul comun):
- `verify-full` sau `verify-ca` cu `DATABASE_CA_FILE` → `ssl: { ca: <conținutul fișierului>, rejectUnauthorized: true }`. E acceptat **doar** un certificat semnat de acest CA, nu de oricare CA public.
  - Numele serverului se verifică în ambele moduri: `verify-ca` e la fel de strict ca `verify-full` (decizia mea).
- `verify-full` fără `DATABASE_CA_FILE` → postgres.js verifică față de trust store-ul Node: CA-urile publice, plus `NODE_EXTRA_CA_CERTS` dacă e setată la pornirea procesului.
  - Asta e varianta de rezervă: CA-ul Supabase se **adaugă** la cele publice, nu le înlocuiește.
- `sslmode=require` (sau `prefer`) → conexiunea e criptată, dar postgres.js **nu verifică** lanțul de certificate, deci nu protejează față de un intermediar. Nu se folosește în producție.
- `sslmode=disable` sau lipsă → fără TLS. Rămâne valabil în dezvoltare și CI.

**Reguli la pornire** (`src/lib/config.ts`), toate decizia mea:
- `DATABASE_CA_FILE` cu un URL fără `sslmode=verify-full` sau `verify-ca` → eroare. Altfel CA-ul ar fi ignorat, cu o încredere falsă.
- `sslrootcert` în URL → eroare. postgres.js nu-l citește ca fișier: îl trimite serverului ca parametru, iar serverul refuză conexiunea cu `unrecognized configuration parameter "sslrootcert"`, inclusiv pentru `sslrootcert=system`.
- CA-ul trebuie să fie un fișier PEM (`-----BEGIN CERTIFICATE-----`) de cel mult 64 KiB. Se citește o singură dată.

**Ce s-a verificat:**
- **Local (T7):** Postgres 17 efemer cu certificat semnat de un CA de test, prin `src/lib/db-client.test.ts` și serverul standalone.
  - `verify-full` cu CA-ul corect → `db: ok`.
  - Cu alt CA → `down`.
  - Fără CA (CA-ul de test nu e în trust store) → `down`.
  - Cu alt nume de host decât cel din certificat → `down`.
  - `NODE_EXTRA_CA_CERTS` cu CA-ul corect → `ok`.
  - `require` → `ok`, dar fără verificarea lanțului.
- **Coordonatorul, direct cu postgres.js 3.4.9, nu prin aplicație:** pooler-ul Supabase (eu-west-1) acceptă `ssl: { ca: <prod-ca-2021.crt>, rejectUnauthorized: true }` pe 6543 și pe 5432.
- **Prin aplicație, pe Supabase:** NOT RUN (așteaptă deploy-ul).

### Liveness și monitorizare
- Healthcheck-ul Docker cere `GET http://127.0.0.1:3000/api/health/live` din interiorul containerului. `src/proxy.ts` îl lasă fără JWT doar pentru metoda `GET` (`HEAD`, `POST` etc. → 403), doar pe calea exactă (variantele codificate, de exemplu `%2f`, → 403; `/api/health/live/` primește de la Next un 308 spre calea exactă, înaintea proxy-ului) și doar dacă `Host` e loopback și lipsesc antetele de proxy (`cf-connecting-ip`, `cf-ray`, `cf-ipcountry`, `x-real-ip`, `cf-access-jwt-assertion`), iar `X-Forwarded-*` indică tot loopback.
- **`/api/health/live` nu se publică** prin Traefik sau tunel: routerul Traefik îl exclude (`!Path(...)`), iar prin tunel cererea are antete Cloudflare și cere Access. În tunel nu se setează „HTTP Host Header” la o adresă loopback.
- **Limitare cunoscută:** un alt container de pe `apps` care cere `http://finet-web:3000/api/health/live` cu antetul `Host: 127.0.0.1` primește „ok”. Răspunsul nu expune nimic în afară de „procesul răspunde”.
- Monitorizarea internă (agent-queue, n8n etc.) folosește `GET http://finet-web:3000/api/health` cu antetul `X-Finet-Health-Token: <HEALTH_TOKEN>` (minimum 32 de caractere, `openssl rand -hex 32`). Fără `HEALTH_TOKEN` setat, `/api/health` cere JWT Access.
- `/api/health` întoarce `ok`/`degraded` (200) sau `down` (503), cu `db`, `storage`, `queue`, `ai` (ultimele două `unknown` până în fazele lor) și `diskFreePercent`.

## 4. Pașii operatorului, în ordine

1. **Decide** varianta de intrare (A tunel, recomandat; B Traefik). Fișierele FINET stau în `/srv/finet/` (vezi „Date în afara `/home`”).
2. **Supabase:** `ops/supabase/README.md` (proiect UE, Data API oprit, SSL, Network Restrictions pe IP-ul de ieșire al VPS-ului, `roles.sql` cu psql, bucket privat). Actualizează `ops/postgres/VERSION` cu versiunea reală.
3. **Cloudflare:** `ops/cloudflare/README.md` (hostname, ruta în tunel sau DNS pentru Traefik, aplicația Access după `access-policy.md`, WARP). Notează `CF_ACCESS_TEAM_DOMAIN` și `CF_ACCESS_AUD`.
4. **Directoare și fișiere pe server** (toate în `/srv/finet/`, nimic sub `/home`):
   ```bash
   sudo install -d -o root -g root -m 755 /srv/finet
   sudo install -d -o root -g root -m 700 /srv/finet/env       # mediul nesecret pe rol + notify.env
   sudo install -d -o root -g root -m 700 /srv/finet/secrets   # secretele, câte un fișier
   sudo install -d -o root -g root -m 755 /srv/finet/compose   # compose.env (fără secrete)
   sudo install -d -o root -g root -m 755 /srv/finet/ca        # CA-ul Supabase (public)
   sudo install -d -o 1000 -g 1000 -m 700 /srv/finet/storage   # fișierele aplicației (uid 1000 = node)
   sudo install -o root -g root -m 600 ops/docker/finet.env.example         /srv/finet/env/finet.env
   sudo install -o root -g root -m 600 ops/docker/finet.worker.env.example  /srv/finet/env/finet.worker.env
   sudo install -o root -g root -m 600 ops/docker/finet.migrate.env.example /srv/finet/env/finet.migrate.env
   sudo install -o root -g root -m 600 ops/docker/compose.env.example       /srv/finet/compose/compose.env
   sudo install -o root -g root -m 600 ops/notify/notify.env.example        /srv/finet/env/notify.env
   sudoedit /srv/finet/env/finet.env /srv/finet/env/finet.worker.env /srv/finet/env/finet.migrate.env /srv/finet/env/finet.admin.env /srv/finet/compose/compose.env
   ```
   Fișierele de mediu (doar valori nesecrete) sunt citite de `docker compose` (rulat cu `sudo`), deci rămân `root:root 600`.

   **Secretele**, câte un fișier `1000:1000 0400`. Valoarea se tastează (sau se lipește) la un prompt ascuns, deci nu apare în comandă, în istoricul shell-ului sau în `ps`. `sudo -v` cere parola înainte, ca promptul lui `sudo` să nu consume valoarea din stdin:
   ```bash
   sudo -v
   for s in finet_database_url finet_worker_database_url finet_migrate_database_url; do
     printf '%s (URL complet, cu sslmode=verify-full, fără sslrootcert): ' "$s"
     IFS= read -rs v; echo
     printf '%s' "$v" | sudo install -o 1000 -g 1000 -m 400 /dev/stdin "/srv/finet/secrets/$s"
   done
   unset v
   # Tokenul de sănătate: generat direct în fișier (îl citește monitorizarea cu `sudo cat`).
   openssl rand -hex 32 | sudo install -o 1000 -g 1000 -m 400 /dev/stdin /srv/finet/secrets/finet_health_token
   # Secretul Better Auth (F1-B): generat direct în fișier, nu se afișează nicăieri.
   openssl rand -base64 32 | sudo install -o 1000 -g 1000 -m 400 /dev/stdin /srv/finet/secrets/finet_better_auth_secret
   sudo ls -ln /srv/finet/secrets/    # 5 fișiere, 1000 1000, -r--------
   ```
   - Creează toate cele cinci fișiere, chiar dacă workerul și migrarea nu pornesc încă. Rotirea `finet_better_auth_secret` invalidează toate sesiunile și tokenurile bearer (utilizatorii se reconectează).
     - Compose nu verifică existența lor la `config` (verificat).
     - Pornirea unui serviciu al cărui fișier lipsește ar trebui să eșueze la bind mount (neverificat).
   - URL-urile: pooler-ul Supabase, `postgres://<rol>.<ref>:<parola>@<host-pooler>:<port>/postgres?sslmode=verify-full`.
     - `finet_database_url`: portul 6543, rolul `finet_app`.
     - `finet_worker_database_url`: portul 5432, rolul `finet_app`.
     - `finet_migrate_database_url`: portul 5432, rolul `finet_migrator`.
     - Parola se scrie cu codificare procentuală dacă are caractere speciale.
   - Rotirea unui secret: rescrii fișierul cu aceeași comandă, apoi recreezi serviciul (`up -d --force-recreate finet-web`). Configurația se citește doar la pornire.

   **CA-ul Supabase:** descarcă `prod-ca-2021.crt` din panou (Settings → Database → SSL Configuration), apoi:
   ```bash
   sudo install -o root -g root -m 644 prod-ca-2021.crt /srv/finet/ca/prod-ca-2021.crt
   ```
   Alt nume de fișier → `FINET_DATABASE_CA_NAME` în `compose.env`. Checkout-ul repo-ului poate sta oriunde (nu conține secrete); recomandare `/srv/finet/src`, tot în afara `/home`.
5. **IP-uri:** confirmă că `172.88.88.130`/`.131` sunt libere (inclusiv pentru containerele oprite care au IP static în compose-urile lor):
   ```bash
   sudo docker network inspect apps --format '{{range .Containers}}{{.IPv4Address}} {{.Name}}{{"\n"}}{{end}}'
   sudo grep -rn "172.88.88.13[01]" /home/docker-apps/portainer/config/compose/ /home/docker-apps/*/docker-compose.yml
   ```
6. **Traefik (doar varianta B):** confirmă numele resolverului în `/home/docker-apps/traefik/traefik.yml` și entrypoint-ul `websecure`; `FINET_TRAEFIK_ENABLE=true` în `compose.env`.
7. **Validare și pornire**, din checkout-ul repo-ului:
   ```bash
   sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env config
   sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile worker --profile migrate config   # toate serviciile
   sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env up -d --build finet-web
   sudo docker ps --filter name=finet-web    # trebuie să ajungă (healthy)
   sudo docker logs --tail 50 finet-web       # fără erori de configurație
   # N1: niciun secret în configurația containerului (trebuie să afișeze 0 și 0)
   sudo docker inspect finet-web --format '{{json .Config.Env}}' | grep -c 'postgres://'
   sudo grep -c 'postgres://' /home/docker/containers/$(sudo docker inspect -f '{{.Id}}' finet-web)/config.v2.json
   # după primul deploy: nimic FINET în backup-ul de /home de pe Google Drive (ambele copii)
   sudo rclone ls Gdrive:vpnde/home | grep -i finet         # trebuie să nu afișeze nimic
   sudo rclone ls GdriveCrypt:home | grep -i finet          # idem, pentru copia criptată
   ```
8. **Notificări:** completează Telegram sau SMTP + `NOTIFY_EMAIL_TO` în `/srv/finet/env/notify.env` (doar pe host), apoi:
   ```bash
   sudo sh ops/notify/notify.sh --env-file /srv/finet/env/notify.env --dry-run --test
   sudo sh ops/notify/notify.sh --env-file /srv/finet/env/notify.env --test
   ```
9. **Primul utilizator (F1-B)**, după migrații (`--profile migrate run --rm finet-migrate`), cu imaginea de unelte (`--profile admin build finet-admin`). Primul utilizator creat devine administrator al platformei; fiecare primește automat preferințele implicite și o gospodărie personală. Parola NU se dă ca argument:
   ```bash
   C="sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile admin"
   # Varianta 1: parola generată, afișată o singură dată (o copiezi în managerul de parole).
   $C run --rm finet-admin create-user --email <email> --name '<Nume>'
   # Varianta 2: parola aleasă, tastată la un prompt ascuns și trimisă prin stdin (`-T`).
   sudo -v; IFS= read -rs p; echo; printf '%s\n' "$p" | $C run --rm -T finet-admin \
     create-user --email <email> --name '<Nume>' --password-stdin; unset p
   # Resetarea parolei (fără SMTP, singura cale); revocă toate sesiunile utilizatorului.
   $C run --rm finet-admin reset-password --email <email>
   # Un membru al familiei în gospodăria altcuiva (id-ul gospodăriei apare la create-user).
   $C run --rm finet-admin add-member --household <id-gospodărie> --email <email> [--role member]
   ```
   `finet-admin` rulează cu rolul `finet_app` (același URL ca web, ADR 0003), pe rețeaua `finet_default`, fără secretul Better Auth. Comenzile sunt idempotente unde are sens (un utilizator sau un membru existent nu se modifică); ieșirea conține doar id-uri, nu emailuri sau parole citite; cod ≠ 0 la eroare (1) sau la utilizare greșită (2). Local: `FINET_ROLE=admin DATABASE_URL=... pnpm admin:create-user --email ... --name ...`.
10. **Acceptarea** (secțiunea 6).

Rollback: `sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env down` (nu șterge `/srv/finet/`; nu există volume Docker numite).

## 4a. Date în afara `/home` (constatare F2, verificată pe host la 2026-10-27)

**Constatarea** (citire cu `sudo grep`, fără modificări pe host):
- `backup_home_gdrive.sh` (cron 02:30) face `rclone sync /home` spre `GdriveCrypt:home` (**criptat**).
- `backup_home_gdrive_clar.sh` (cron 03:30) face `rclone sync /home` spre `Gdrive:vpnde/home`, **NECRIPTAT**, și duminica o arhivă `tar.gz` a întregului `/home/docker` (data-root-ul Docker) spre `Gdrive:vpnde/docker-archives/`, tot necriptată.
- Ambele `sync` folosesc `backup_home_gdrive.filter`, care exclude `/docker/**`, modelele Ollama, cache-uri și câteva baze, dar **nimic FINET**. Orice director FINET sub `/home` (de exemplu fostul `/home/docker-apps/finet/`, propus inițial, cu bonuri, extrase și fișierele `.env`) ar fi urcat zilnic pe Google Drive, inclusiv în clar.

**Decizia:** toate datele și secretele FINET stau în **`/srv/finet/`** (`env/`, `secrets/`, `storage/`, `compose/`, `ca/`), în afara surselor ambelor backup-uri. Valorile implicite din `ops/docker/docker-compose.yml` și din `compose.env.example` indică acolo. Backup-ul propriu, **criptat**, al FINET (`pg_dump` din Supabase + fișierele, cu restic) e implementat în Faza 3 (F3-D, [`docs/BACKUP.md`](BACKUP.md)); până îl instalează operatorul, datele din `/srv/finet/storage` nu au backup. Repository-ul restic NU se pune sub `/home` (și, pentru o destinație locală de test, tot în `/srv/finet/backup-repo`).

**Secretele în data-root-ul Docker (N1): închis tehnic pentru FINET (T7).**
- Docker copiază valorile din `environment`/`env_file` în `/home/docker/containers/<id>/config.v2.json`, iar arhiva săptămânală necriptată a `/home/docker` le-ar urca pe Drive.
- De aceea URL-urile bazei și tokenul de sănătate sunt acum **fișiere montate prin `secrets:`** (vezi „Secretele ca fișiere”). În `config.v2.json` ajunge doar calea lor.
- `env_file` mai conține doar valori nesecrete (`APP_URL`, `CF_ACCESS_*`, limite).

**Riscuri care rămân:**
- **Logurile `json-file`** ale containerului stau tot în `/home/docker/containers/` și sunt în arhivă. Aplicația nu scrie secrete în loguri: mesajele de configurație numesc doar variabila.
- **Celelalte containere de pe host:** arhiva necriptată existentă (și cele viitoare) conține în continuare **mediul altor containere** (alte stack-uri cu secrete în `environment`/`env_file`). E un risc preexistent, în afara FINET. Agentul nu a modificat scripturile de backup.
  - Variante pentru operator: excluderea `/home/docker/containers` din arhivă (`tar --exclude`) sau criptarea arhivei (de exemplu prin `GdriveCrypt`).

**Verificare după deploy** (operatorul): `sudo rclone ls Gdrive:vpnde/home | grep -i finet` și `sudo rclone ls GdriveCrypt:home | grep -i finet` nu afișează fișiere de date FINET.

## 4b. Faza 1 pe producție (operatorul, după revizuiri)

Agentul nu a rulat nimic din această secțiune. Ordinea:

0. **Imaginile se construiesc în CI, nu pe host** (hostul are swap plin și ~1,5 GB liberi; un build local a fost oprit de sistem la 2026-10-28). Workflow-ul `images` (`.github/workflows/images.yml`, la fiecare push pe `main` sau `phase/**`) construiește `web` (`finet:local`) și `tools` (`finet:tools`) și le păstrează 7 zile ca artefacte. Pe host: `sudo sh ops/deploy/pull-images.sh <sha-complet-al-commit-ului>` (verifică suma sha256 și încarcă imaginile sub numele așteptate de compose). Tokenul GitHub (`Actions: read`) se citește din `/home/docker-apps/secrete/github-finet.token`; nu apare în argumentele proceselor.

1. **Backup înainte de migrații** (Supabase: backup-ul zilnic al planului sau un `pg_dump` al schemei `finet` cu URL-ul migratorului). Faza 1 e prima cu tabele, deci în practică baza e goală.
2. **Secretul Better Auth** (dacă nu există deja): `openssl rand -base64 32 | sudo install -o 1000 -g 1000 -m 400 /dev/stdin /srv/finet/secrets/finet_better_auth_secret` (doar `finet-web` îl primește; rotirea lui invalidează toate sesiunile și tokenurile bearer).
3. **`/srv/finet/env/finet.admin.env`** din `ops/docker/finet.admin.env.example` (nesecret; URL-ul bazei vine din `finet_database_url`), și `APP_URL=https://finet.<domeniu>` în `finet.env` (originea exactă din browser: Better Auth și CSRF-ul din `/api/v1` o compară cu `Origin`).
4. **Migrațiile**, ca `finet_migrator` (portul 5432, modul sesiune), cu imaginea de unelte:
   ```bash
   C="sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env"
   $C --profile migrate build finet-migrate
   $C --profile migrate run --rm finet-migrate      # „aplicate acum 2” prima dată
   $C --profile migrate run --rm finet-migrate      # a doua oară: „aplicate acum 0” (idempotent)
   ```
   Runner-ul rulează toate migrațiile în așteptare într-o singură tranzacție (sub `pg_advisory_xact_lock`) și refuză o migrație aplicată și modificată ulterior (ADR 0003).
5. **Primul utilizator**: pasul 9 din secțiunea 4 (`finet-admin create-user`, parola din stdin sau generată).
6. **Redeploy `finet-web`** cu imaginea nouă, apoi verificări prin Access: `/login` se deschide, login → `/dashboard` cu „Gospodăria mea”, `/profile` arată sesiunea curentă; antetele: `curl -sD- -o /dev/null https://finet.<domeniu>/login` (cu cookie-ul Access) conține `content-security-policy` cu `nonce-`, `strict-transport-security`, `x-frame-options: DENY`. Fără Access, orice cale dă 403, tot cu antetele de securitate.

**Rollback:**
- aplicația: imaginea anterioară a `finet-web` (`docker compose up -d finet-web` cu tag-ul vechi). F1-C nu are migrații; cookie-ul `finet_theme` rămâne inofensiv.
- migrațiile Fazei 1 nu au „down” automat. Pe o bază fără date reale: `drop schema finet cascade` ca proprietar și recrearea schemei goale după `ops/supabase/README.md` (`roles.sql`), apoi rularea migrațiilor din nou. Cu date reale: restaurarea backup-ului de la pasul 1. Nicio operație distructivă fără decizia explicită a operatorului.

**HSTS `preload`:** nu e pus. Se adaugă doar după decizia operatorului (domeniul stabil, toate subdomeniile pe HTTPS), în `src/lib/security-headers.ts`.

## 4c. Faza 2 (F2-B): migrația `0003` și curățarea cheilor de idempotență

Agentul nu a rulat nimic din această secțiune.

1. **Migrațiile** `0002_ledger` și `0003_idempotency_purge` se aplică împreună, ca la 4b, pasul 4 (backup înainte; prima rulare: „aplicate acum 2”, a doua: „aplicate acum 0”). `0003` nu creează tabele: adaugă funcția `finet.purge_idempotency_keys()` și două politici `TO finet_migrator`. Rollback: comenzile din antetul `src/db/migrations/0003_idempotency_purge.sql`.
2. **Curățarea cheilor > 24 h** (`finet-admin`, aceeași imagine de unelte și aceleași secrete ca `create-user`):
   ```bash
   C="sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env"
   $C --profile admin run --rm -T finet-admin cleanup-idempotency   # scrie doar numărul de chei șterse
   ```
   Idempotentă (a doua rulare scrie `0`); exit ≠ 0 la eroare. Programarea e decizia operatorului: de exemplu o dată pe zi, din `sudo crontab -e` (nu `crontab -`) sau dintr-un job Portainer. Fără curățare nu se strică nimic (o cheie expirată se înlocuiește la refolosire), doar tabelul crește. Din Faza 3+ o va prelua workerul.

## 4d. Faza 2 pe producție (operatorul, după revizuiri)

Agentul nu a rulat nimic din această secțiune. Ordinea:

1. **Imaginile** din workflow-ul `images` pentru commit-ul aprobat (`sudo sh ops/deploy/pull-images.sh <sha>`), ca la 4b, pasul 0.
2. **Backup** al schemei `finet` (4b, pasul 1). Faza 2 adaugă tabele, nu modifică datele Fazei 1.
3. **Migrațiile** `0002_ledger` + `0003_idempotency_purge` (4c, pasul 1): prima rulare „aplicate acum 2”, a doua „aplicate acum 0”. `0000`/`0001` nu se schimbă.
4. **Redeploy `finet-web`** cu imaginea nouă. Fără variabile de mediu sau secrete noi.
5. **Verificări prin Access**, în browser: `/accounts` → „Adaugă cont” (sold inițial `1.000,00`) → `/transactions` → „Adaugă cheltuială” (`25,50`) → soldul `974,50 lei` pe `/accounts` și pe `/dashboard`; un transfer între două conturi; `/categories`. Antetele: `curl -sD- -o /dev/null https://finet.<domeniu>/accounts` (cu cookie-ul Access și al sesiunii) conține `content-security-policy` cu `nonce-`. Fără sesiune, paginile dau 307 la `/login?next=…`.
6. **Programarea** `finet-admin cleanup-idempotency` (4c, pasul 2), decizia operatorului.

**Rollback:** imaginea anterioară a `finet-web` (UI-ul Fazei 1 nu citește tabelele noi). Migrațiile `0002`/`0003`: comenzile din antetele fișierelor, doar cu backup și decizia explicită a operatorului (distrug datele registrului).

## 4e. Faza 3 pe producție (operatorul, după revizuiri și după F3-D)

Agentul nu a rulat nimic din această secțiune. Interfața Fazei 3 (F3-C) nu are pași proprii de deploy: vine în imaginea `finet-web`. Ordinea:

1. **Imaginile** din workflow-ul `images` pentru commit-ul aprobat (`sudo sh ops/deploy/pull-images.sh <sha>`, acum `web`, `tools` și `backup`), ca la 4b, pasul 0.
2. **Backup** al schemei `finet` (4b, pasul 1). `0004` adaugă tabele și o constrângere unică nedistructivă pe `transactions`. Dacă backup-ul F3-D e deja instalat (pasul 6), un `run-backup.sh` manual e backup-ul de dinainte.
3. **Migrația** `0004_budgets_goals_tags` (rolul `migrate`): prima rulare „aplicate acum 1”, a doua „aplicate acum 0”. `0000`–`0003` nu se schimbă.
4. **Redeploy `finet-web`** cu imaginea nouă. Fără variabile de mediu sau secrete noi pentru UI (backup-ul F3-D are pașii lui).
5. **Verificări prin Access**, în browser: `/dashboard` (selectorul de lună, onboarding-ul), `/budgets/new` → un buget de `100` pe o categorie → o cheltuială de `85` în acea categorie → semafor galben și bannerul „Atenție la bugete”; `/goals/new` → o contribuție; `/tags`; `/transactions` → „Export CSV” (fișier `finet-tranzactii.csv`, separator `;`). Antetele CSP ca la 4d, pasul 5.

6. **Backup-ul zilnic (F3-D)**, pașii din [`docs/BACKUP.md`](BACKUP.md), secțiunea 5: rolul `finet_backup` (`ops/backup/backup-role.sql`; verifică întâi că `postgres` are `BYPASSRLS`), destinația aleasă de operator, **Google Drive prin rclone** (`rclone:Gdrive:finet-backup/restic`, suprapunerea `ops/backup/compose.rclone.yml`, `FINET_BACKUP_DEST=rclone`; `docs/BACKUP.md` 2a), secretele în `/srv/finet/secrets` (`finet_restic_password`, `finet_backup_repository`, `finet_backup_pg_service`, `finet_rclone_conf` = DOAR secțiunea `[Gdrive]` din configul rclone al root-ului, `1000:1000 0400`, la fel de sensibil ca tot Drive-ul), `/srv/finet/env/finet.backup.env` și `backup-host.env`, `init`, primul backup manual `sudo sh ops/backup/run-backup.sh` (cod 0, două instantanee), notificarea de test, programarea cu `sudo crontab -e` (nu `crontab -`): `/bin/sh /srv/finet/src/ops/backup/run-backup.sh`, din checkout-ul `/srv/finet/src` care trebuie să fie `root:root` fără drept de scriere pentru alții (scriptul refuză altfel; `docs/BACKUP.md` 6), logul `/var/log/finet-backup.log` creat `0600` + `logrotate`.
7. **Restaurarea reală de verificare** (`docs/BACKUP.md` 7.A, pe un Postgres de probă, nu peste producție) și rezultatul notat în `docs/reports/faza-3.md`. **Abia după ea se introduc date reale.**

**Rollback:** imaginea anterioară a `finet-web` (UI-ul Fazei 2 nu citește tabelele noi). Backup-ul nu schimbă nimic în aplicație: se oprește scoțând linia din crontab. Migrația `0004`: comenzile din antetul fișierului, doar cu backup și decizia explicită a operatorului (distruge datele etichetelor, bugetelor și obiectivelor).

## 4f. Faza 4 pe producție (operatorul, după revizuiri)

Agentul nu a rulat nimic din această secțiune. Ordinea:

1. **Imaginile** din workflow-ul `images` pentru commit-ul aprobat (`sudo sh ops/deploy/pull-images.sh <sha>`), ca la 4b, pasul 0.
2. **Backup** al schemei `finet` (un `run-backup.sh` manual, dacă F3-D e instalat; altfel 4b, pasul 1). `0005` adaugă doar un index.
3. **Migrația** `0005_perf_indexes` (rolul `migrate`): prima rulare „aplicate acum 1”, a doua „aplicate acum 0”. `0000`–`0004` nu se schimbă. `CREATE INDEX` blochează scrierile pe `transactions` cât se construiește (sub o secundă la volumul actual). Rollback: `drop index if exists finet.transactions_household_date_idx;` (antetul fișierului).
4. **Redeploy `finet-web`** cu imaginea nouă. Fără variabile de mediu sau secrete noi.
5. **Verificări prin Access**, în browser: data în listele de tranzacții e `zz.ll.aaaa`; `Tab` pe orice pagină autentificată afișează „Sari la conținut”; `/transactions` → două etichete bifate + „Toate” → doar tranzacțiile cu ambele. Recuperarea după deploy: cu un tab deschis ÎNAINTE de redeploy, o navigare după redeploy reîncarcă pagina o singură dată (sau, cu un formular început, afișează „Versiune nouă disponibilă. Salvează și reîncarcă.”).
6. **Programarea curățării cheilor de idempotență** (4c, pasul 2), zilnic, din crontab-ul root. Se editează cu `sudo crontab -e` (NU `crontab -` și NU redirectări: ar suprascrie celelalte joburi root). Linia propusă (04:15, după backup-urile de la 02:30/03:30 și după `dockerai.py` de la 04:00):
   ```cron
   15 4 * * *  cd /srv/finet/src && docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile admin run --rm -T finet-admin cleanup-idempotency >> /var/log/finet-cleanup.log 2>&1
   ```
   Înainte: `sudo install -m 0600 /dev/null /var/log/finet-cleanup.log` (logul conține doar numărul de chei șterse) și o regulă `logrotate` (săptămânal, 4 rotații). Verificare: a doua zi, `sudo tail -n 2 /var/log/finet-cleanup.log` arată un număr; `sudo crontab -l | wc -l` are cu o linie mai mult decât înainte. Oprire: linia se șterge cu `sudo crontab -e`.

**Rollback:** imaginea anterioară a `finet-web` (aplicația Fazei 3 funcționează și cu indexul nou). Indexul se poate lăsa sau șterge (comanda de la pasul 3); nu atinge datele.

## 4g. Faza 5 pe producție (operatorul, după revizuiri)

Agentul nu a rulat nimic din această secțiune. Ordinea contează: schema `pgboss` → migrațiile → workerul.

1. **Imaginile** din workflow-ul `images` pentru commit-ul aprobat (`sudo sh ops/deploy/pull-images.sh <sha>`): `finet` (web) și `finet:tools` (migrare, CLI și, din Faza 5, workerul).
2. **Backup** al schemei `finet` (un `run-backup.sh` manual; altfel 4b, pasul 1).
3. **Schema `pgboss`**, o singură dată, ca utilizatorul `postgres` al proiectului (ca la `roles.sql`, cu psql, nu din SQL Editor): `psql "<url-postgres>?sslmode=verify-full&sslrootcert=<ca.crt>" -f ops/supabase/pgboss-schema.sql`. Rezultatul așteptat: `pgboss | finet_migrator`; `anon`/`authenticated` fără USAGE. Schema **nu** se adaugă la „Exposed schemas” din Data API. Fără acest pas, migrația `0007` se oprește cu „lipsește schema pgboss deținută de finet_migrator” și nu aplică nimic (nici `0006`: toate într-o tranzacție).
4. **Migrațiile** `0006_recurring` și `0007_pgboss` (rolul `migrate`, ca la 4f pasul 3; dacă `0005` nu e încă aplicată, se aplică împreună): prima rulare „aplicate acum 2” (sau 3), a doua „aplicate acum 0”. `0006` adaugă pe `transactions` o cheie `NOT VALID` + `VALIDATE` și un index parțial (lock scurt pe scrieri). Rollback: comenzile din antetul fiecărui fișier, doar cu backup și decizia operatorului.
5. **Redeploy `finet-web`** (imaginea nouă citește semnalul workerului în `/api/health` și, din F5-B, servește API-ul `/api/v1/recurring` și paginile `/recurring`). Fără variabile sau secrete noi pentru web. Butonul „Generează scadentele” rulează în serverul web (nu prin coada workerului), deci funcționează și cu workerul oprit; verificare după deploy: `/recurring` se deschide (200, prin Access), o regulă de probă cu start în trecut + „Generează” creează tranzacțiile, a doua apăsare „Nicio tranzacție nouă”; apoi ștergi regula (tranzacțiile rămân, le ștergi din `/transactions`).
6. **Pornirea workerului.** Secretul `finet_worker_database_url` există din Faza 0 (pasul 4): trebuie să fie pooler-ul în **modul sesiune (5432)**, rolul `finet_app`, **exact** `sslmode=verify-full` (o singură dată, fără alți parametri TLS: fără `ssl=`, `sslrootcert`, `uselibpqcompat`; CA-ul vine din `DATABASE_CA_FILE`). Altfel workerul refuză să pornească (`start_failed`, motivul în log, fără URL), în orice `NODE_ENV`. `FINET_ALLOW_INSECURE_DB` nu se setează pe producție (e doar pentru teste și e refuzată acolo). Verifică: `sudo sed -nE 's#^postgres(ql)?://([^:]+):.*@[^@:/]+:([0-9]+)/.*#\2 \3#p' /srv/finet/secrets/finet_worker_database_url` → `finet_app.<ref> 5432` (pooler-ul Supabase cere utilizatorul cu referința proiectului; `-n … p` afișează DOAR utilizatorul și portul, nimic dacă URL-ul nu are forma așteptată). Apoi:
   ```bash
   sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile worker up -d finet-worker
   sudo docker logs --tail 20 finet-worker        # {"event":"started"} și nimic cu "start_failed"/"boss_error"
   ```
7. **Verificări:** `/api/health` (prin Access sau cu `X-Finet-Health-Token`) arată `"queue":"ok"` în cel mult un minut. `sudo docker stats --no-stream finet-worker`: sub 150 MiB. După primul minut 5 al orei: în log, `{"job":"recurring.generate",…}` cu contoare. Oprirea: `sudo docker compose … stop finet-worker` (oprire grațioasă, ≤ 35 s) → `"queue":"unknown"`.

**Rollback:** `sudo docker compose … stop finet-worker` (regulile nu se mai generează; nimic nu se pierde: la repornire se recuperează cel mult 12 scadențe pe regulă pe rulare). Imaginea anterioară a `finet-web` funcționează și cu tabelele noi. Migrațiile: comenzile din antete (`0007`: `drop schema pgboss cascade`, cu workerul oprit).

## 4h. Faza 6 (F6-A) pe producție (operatorul, după revizuiri și după F6-B/F6-C)

Agentul nu a rulat nimic din această secțiune. F6-A singur nu schimbă comportamentul vizibil (fără rută publică de încărcare și fără job în worker); pașii se fac odată cu deploy-ul Fazei 6.

1. **Imaginile** `finet` și `finet:tools` din workflow-ul `images` (`sudo sh ops/deploy/pull-images.sh <sha>`). `finet:tools` conține acum `sharp`, `unpdf`, `busboy` (dependențe de producție) și `dist/tools/pdf-child.mjs`; verifică `prlimit`: `sudo docker run --rm --network none --entrypoint sh finet:tools -c 'which prlimit'` → `/usr/bin/prlimit` (fără el, PDF-urile sunt refuzate, `pdf_sandbox_unavailable`).
2. **Backup** al schemei `finet` (ca la 4g).
3. **Migrația `0008_documents`** (rolul `migrate`, ca la 4g pasul 4): „aplicate acum 1”, apoi „aplicate acum 0”. Adaugă pe `transactions` cheia `transactions_document_fk` (`NOT VALID` + `VALIDATE`) și un index parțial (lock scurt). Rollback: comenzile din antetul fișierului (cu backup; fișierele din `/srv/finet/storage/households/*/documents/` se șterg separat).
4. **Variabile noi (opționale, nesecrete)** în `/srv/finet/env/finet.env` și `finet.worker.env`: `MAX_UPLOAD_MB` (10), `MAX_PDF_PAGES` (6), `MAX_IMAGE_PIXELS` (50000000), `RECEIPT_IMAGE_RETENTION_DAYS` (180), `DOCUMENT_DUPLICATE_MAX_DISTANCE` (6). Variabilele AI (`AI_BASE_URL`, `AI_API_KEY_FILE` …) vin în F6-B.
5. **Workerul**: compose-ul îi montează acum `${FINET_DATA_DIR}/storage` **doar citire** în `/data/storage` și fixează `STORAGE_DIR=/data/storage` (obligatoriu în producție pentru rolul `worker`), `mem_limit`/`memswap_limit` 384m, `NODE_OPTIONS=--max-old-space-size=160`. Directorul există din Faza 0 (`1000:1000`, mod 700): workerul rulează tot ca uid 1000, deci îl poate citi. `sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile worker up -d finet-worker`, apoi `sudo docker inspect finet-worker --format '{{range .Mounts}}{{.Destination}} rw={{.RW}} {{end}}'` → `/data/storage rw=false`.
6. **Încărcările mari prin proxy (F6-C):** cu `src/proxy.ts` pe ruta de încărcare, Next 16 trunchiază corpul la 10 MB (`proxyClientMaxBodySize`); F6-C exclude ruta din proxy sau ridică limita (ADR 0013). Limita de corp a Cloudflare (100 MB pe planul gratuit) și a Traefik sunt peste plafonul FINET (~41 MB).
7. **Spațiul pe disc:** cota implicită e 5000 MB pe gospodărie (`STORAGE_QUOTA_MB`); discul VPS-ului are ~60 GB liberi. `/api/health` raportează `diskFreePercent`.

### 4h-bis. F6-B (pipeline-ul AI) pe producție

Agentul nu a rulat nimic din această secțiune și nu a atins LiteLLM-ul real.

1. **Migrația `0009_receipt_pipeline`** (după `0008`, același mod): „aplicate acum 1”, apoi 0. Atinge doar `finet.receipts`, gol pe producție, plus două tabele noi (`vat_rates` cu seed, `ai_budget_usage`) și trei funcții SECURITY DEFINER. Rollback: antetul fișierului.
2. **Alias-urile în LiteLLM** (stack 262). Pe gazdă, modelele nu stau în `config.yaml`: le adaugi din UI/API-ul LiteLLM, cu masterkey-ul, ca orice model.
   - `finet-vision-external` → de exemplu `gemini/gemini-3.8-flash` (vision);
   - `finet-text-external` → același model sau `gemini/gemini-3.7-flash`.

   Verificare: `curl -s -m 240 -H "Authorization: Bearer $K" localhost:4000/health`.
3. **Cheia virtuală FINET** (per aplicație, cu buget în LiteLLM și doar cele două alias-uri permise): `/srv/finet/secrets/finet_litellm_key`, `1000:1000`, mod 400 (`sudo install -o 1000 -g 1000 -m 400 /dev/stdin /srv/finet/secrets/finet_litellm_key`). Compose-ul o montează DOAR în `finet-worker` (`AI_API_KEY_FILE`). Recomandat: jurnalele LiteLLM fără corpurile cererilor pentru această cheie (PRIVACY_NOTES).
4. **`/srv/finet/env/finet.worker.env`:** `AI_BASE_URL=http://172.88.88.4:4000/v1`, `AI_ALLOWED_HOSTS=172.88.88.4:4000`, modelele, `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_CONFIDENCE_THRESHOLD`, `AI_PRICE_INPUT_PER_MTOK`/`AI_PRICE_OUTPUT_PER_MTOK` (tarifele reale ale modelului ales, în moneda bugetului), `AI_RESPONSE_FORMAT=json_object` (implicit; `json_schema` e refuzat de Gemini prin LiteLLM cu HTTP 400). **`AI_MONTHLY_BUDGET` rămâne 0** (nimic nu pleacă) până după pasul 6.
5. **Rețeaua:** `finet-worker` e pe `apps` (`172.88.88.131`), ca `litellm-apps` (`172.88.88.4`). Firewall-ul gazdei (`LEVINETIT-FW` în `DOCKER-USER`) privește porturile publicate; traficul între containerele de pe `apps` merge deja (open-webui → openclaw). Verificare: `sudo docker exec finet-worker node -e "fetch('http://172.88.88.4:4000/health/liveliness').then(r=>console.log(r.status))"` → 200.
6. **Prima verificare reală, înainte de buget > 0:** din imaginea de unelte sau dintr-un clone, `AI_EVAL=1 AI_BASE_URL=… AI_API_KEY_FILE=… pnpm eval:receipts` (8 bonuri sintetice, sub 1 cent la tarifele Flash).
   - Cu `json_object`, schema exactă (cheile, tipurile, un exemplu) e în promptul sistem; un răspuns cu alte chei e respins de validarea strictă și bonul ajunge „De verificat” (`extraction_failed`).
   - Rezultatul pe bonuri sintetice NU e o evaluare reală: evaluează apoi pe 20–30 de bonuri reale proprii, cu `ground-truth` scris de mână, și notează modelul ales într-un ADR (3.6).
7. **Bugetul:** `AI_MONTHLY_BUDGET` (de exemplu `5.00`) + `AI_MONTHLY_BUDGET_CURRENCY=USD`, apoi recrearea `finet-worker`. Ce s-a consumat luna aceasta: `select month, currency, reserved_minor, calls from finet.ai_budget_usage` (ca `finet_migrator`). Rezervarea e pesimistă, deci consumul raportat e peste costul real.
8. **Verificare:** logul workerului are `{"event":"receipts","enabled":true,"ai":true}` la pornire. Un bon încărcat cu consimțământ trece în ≤ 1 minut în `needs_review` (`select status, confidence, issues from finet.receipts order by created_at desc limit 5`).

## 4i. Faza 6 pe producție (ordinea completă, după revizuiri; F6-C)

Agentul nu a rulat nimic din această secțiune și nu a atins LiteLLM-ul real sau producția. Pașii 4h și 4h-bis rămân valabili; aici e ordinea întregii faze, cu ce adaugă F6-C (API-ul public, paginile `/import`, `/receipts`, retenția). ADR 0013, 0014, 0015.

1. **Imaginile** `finet` și `finet:tools` pentru commit-ul aprobat (`sudo sh ops/deploy/pull-images.sh <sha>`); `prlimit` în `finet:tools` (4h, pasul 1).
2. **Backup** al schemei `finet` (un `run-backup.sh` manual).
3. **Migrațiile `0008`–`0011`** (rolul `migrate`; prima rulare „aplicate acum 4”, a doua „aplicate acum 0”):
   - `0008_documents`, `0009_receipt_pipeline` (4h, 4h-bis);
   - `0010_worker_queue_fairness` (F6-B: selecția echitabilă pe gospodării; doar funcții și o politică);
   - `0011_document_retention` (F6-C: funcția `expired_documents`, SECURITY DEFINER, doar identificatori, și politica `documents_migrator_expired`; schema tabelelor nu se schimbă). Rollback: antetul fișierului.
4. **LiteLLM**: alias-urile, cheia virtuală per aplicație cu buget (`/srv/finet/secrets/finet_litellm_key`, `1000:1000`, mod 400; montată DOAR în `finet-worker` ca `AI_API_KEY_FILE`), variabilele `AI_*` în `finet.worker.env`, **`AI_MONTHLY_BUDGET=0`** până după evaluare (4h-bis, pașii 2–6). Rețeaua: `finet-worker` (`172.88.88.131`) → `litellm-apps` (`172.88.88.4:4000`) pe `apps`; `AI_ALLOWED_HOSTS=172.88.88.4:4000` (anti-SSRF: orice altă gazdă e refuzată).
5. **Workerul**: `mem_limit`/`memswap_limit` 384m, storage-ul DOAR citire, `STORAGE_DIR=/data/storage` (4h, pasul 5); `up -d finet-worker`, apoi `sudo docker stats --no-stream finet-worker` sub 384 MiB după primul bon.
6. **Redeploy `finet-web`** (aceeași imagine aduce rutele `/api/v1/documents`, `/api/v1/receipts`, `/api/v1/ai/usage` și paginile). Variabile nesecrete opționale în `finet.env`: `MAX_UPLOAD_MB` (10), `MAX_PDF_PAGES` (6), `MAX_IMAGE_PIXELS`, `RECEIPT_IMAGE_RETENTION_DAYS` (180), `AI_DAILY_DOCUMENT_LIMIT` (contorul zilei de pe `/import`). Fără secrete noi pentru web. **Încărcarea și proxy-ul**: `/api/v1/documents` e exclusă din `src/proxy.ts` (fluxul nu mai e copiat în memorie și trunchiat la 10 MB), cu aceeași verificare Cloudflare Access în rută; Traefik și Cloudflare (100 MB pe planul gratuit) sunt peste plafonul FINET (~41 MB pe cerere).
7. **Verificări prin Access (browser):**
   - fără Access: `curl -s -o /dev/null -w '%{http_code}' -X POST https://finet.<domeniu>/api/v1/documents` → `403` (ruta exclusă din proxy refuză la fel);
   - `/profile` → „Citirea bonurilor cu AI” pornit; `/import` → un bon de probă → „În coadă” → în ≤ 1–2 minute „De verificat” → „Vezi bonul”: poza se afișează, câmpurile se pot corecta, „Confirmă și salvează” creează tranzacția „din bon” (apoi o poți șterge);
   - același fișier încă o dată → „deja încărcat”; o poză HEIC → mesajul de conversie;
   - fără consimțământ (alt cont) → „Așteaptă acordul pentru AI” și nicio cerere în jurnalul LiteLLM.
8. **Retenția originalelor** (`RECEIPT_IMAGE_RETENTION_DAYS`, implicit 180): serviciul one-shot `finet-cleanup` (profilul `cleanup`; storage-ul în SCRIERE doar aici; aceleași drepturi în bază ca `finet-admin`, `finet.admin.env` + `finet_database_url`). Prima rulare manuală:
   ```bash
   sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile cleanup run --rm -T finet-cleanup
   # → expired=<n> failed=0 temp=<n>     (doar contoare; „storage=empty” = storage nemontat, nimic șters)
   ```
   Programarea zilnică, cu `sudo crontab -e` (NU `crontab -` și NU redirectări: ar suprascrie celelalte joburi root), la 04:25 (după backup-uri și după `cleanup-idempotency` de la 04:15):
   ```cron
   25 4 * * *  cd /srv/finet/src && docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile cleanup run --rm -T finet-cleanup >> /var/log/finet-cleanup.log 2>&1
   ```
   Același log ca la 4f (`0600`, `logrotate`). Codul de ieșire 1 = cel puțin un document n-a putut fi șters (se reia a doua zi). Oprire: linia se șterge cu `sudo crontab -e`. Fișierele temporare `*.tmp-*` mai vechi de 24 h (scrieri întrerupte, constatarea F9) se șterg la aceeași rulare (`--temp-hours <ore>`).
9. **Bugetul AI > 0** abia după evaluarea pe bonuri reale (4h-bis, pașii 6–7).

**Rollback:** imaginea anterioară a `finet-web` (paginile și rutele noi dispar; datele rămân); `stop finet-worker` (bonurile rămân `queued`); linia de cron a curățării se scoate. Migrațiile: comenzile din antete, doar cu backup și decizia operatorului.

## 4j. Faza 8 (F8-A): verificarea dinaintea migrației `0012_family`

Agentul nu a rulat nimic de aici. Pașii completi de deploy ai Fazei 8 vin în F8-B; F8-A adaugă doar migrația și o verificare OBLIGATORIE înainte de ea, pentru că `0012` schimbă vizibilitatea: un cont cu `owner_user_id` setat devine PERSONAL și dispare pentru ceilalți membri (ADR 0016).

1. Pe Supabase (SQL editor, rol cu drept de citire peste RLS, de exemplu `postgres`), înainte de `0012`:
   ```sql
   select a.household_id, count(*) as conturi_cu_proprietar,
          (select count(*) from finet.household_members m where m.household_id = a.household_id) as membri
     from finet.accounts a
    where a.owner_user_id is not null
    group by a.household_id;
   ```
   Ce anume ar dispărea pentru ceilalți membri (revizuirea m6) — tranzacțiile și regulile recurente create de ALT membru decât proprietarul contului, plus transferurile dintre un astfel de cont și un cont comun (ceilalți vor vedea doar jumătatea comună):
   ```sql
   select a.household_id, a.id as cont,
          (select count(*) from finet.transactions t
            where t.account_id = a.id and t.created_by_user_id is distinct from a.owner_user_id)
            as tranzactii_ale_altora,
          (select count(*) from finet.recurring_rules r
            where r.account_id = a.id and r.created_by_user_id is distinct from a.owner_user_id)
            as reguli_ale_altora,
          (select count(*) from finet.transactions t
             join finet.transactions o on o.transfer_group_id = t.transfer_group_id and o.id <> t.id
             join finet.accounts oa on oa.id = o.account_id and oa.owner_user_id is null
            where t.account_id = a.id and t.transfer_group_id is not null)
            as transferuri_cu_conturi_comune,
          (select count(*) from finet.transactions t where t.account_id = a.id) as tranzactii_total
     from finet.accounts a
    where a.owner_user_id is not null
    order by a.household_id, a.id;
   ```
   Dacă rezultatul e gol sau gospodăriile au un singur membru: nimic de făcut. Altfel, decide cu familia: conturile care trebuie să rămână comune se fac comune ÎNAINTE de migrare (`update finet.accounts set owner_user_id = null where id in (...)`, cu backup).
2. Backup, apoi migrațiile (rolul `migrate`; „aplicate acum 1”, a doua rulare „aplicate acum 0”). Rollback: antetul `0012_family.sql`.
3. Nicio variabilă și niciun secret nou pentru F8-A.

## 4k. Faza 8 pe producție (ordinea completă, după revizuiri; F8-B)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0016, 0017.

1. **Verificarea dinaintea migrației** (4j, obligatorie: conturile cu `owner_user_id` deja setat devin personale).
2. **Imaginile** `finet` și `finet:tools` pentru commit-ul aprobat (`sudo sh ops/deploy/pull-images.sh <sha>`).
3. **Backup** al schemei `finet` (un `run-backup.sh` manual), apoi **migrația `0012_family`** (rolul `migrate`; prima rulare „aplicate acum 1”, a doua „aplicate acum 0”). Rollback: antetul fișierului, doar cu backup.
4. **Redeploy `finet-web`** (aduce `/api/v1/family/*`, `/api/v1/invites/accept`, `/api/v1/households/active`, `/api/v1/transactions/{id}/split`, `GET /api/v1/events` și paginile `/family`, `/join/[token]`). **Nicio variabilă și niciun secret nou.** Workerul nu se schimbă pentru Faza 8 (redeploy doar dacă imaginea e comună și vrei aceeași versiune).
5. **Cloudflare Access:** fiecare membru invitat trebuie să aibă emailul în politica aplicației Access (altfel linkul `/join/<token>` dă 403 la margine, înaintea FINET). Contul FINET al membrului se creează în continuare cu CLI-ul (`admin create-user`, modul `personal`), apoi el acceptă invitația din aplicație (nu mai e nevoie de `admin add-member`).
6. **Actualizările live prin tunel** (ADR 0017; pe producție NOT RUN de agent):
   ```bash
   # din browserul autentificat prin Access (DevTools → Network → events): tipul `eventsource`, statusul 200,
   # `content-type: text/event-stream`, iar mesajul `ready` apare imediat (fără întârziere de bufferizare).
   # Fără Access:
   curl -s -o /dev/null -w '%{http_code}\n' https://finet.<domeniu>/api/v1/events   # → 403
   ```
   Cu două ferestre (doi membri) pe `/family`: o decontare înregistrată într-una apare în cealaltă în câteva secunde, fără reîncărcare. Dacă evenimentele întârzie până la închiderea fluxului (bufferizare la un proxy), aplicația trece singură pe reîncărcare la 60 s; de raportat ca defect (Traefik: fără middleware de compresie pe `text/event-stream`; tunelul Cloudflare nu bufferizează SSE).
7. **Verificări funcționale (browser, prin Access):**
   - `/family` → „Creează link de invitație” → linkul apare o singură dată (după reîncărcare nu mai e afișat);
   - al doilea membru deschide linkul → „Acceptă invitația” → intră; comutatorul de gospodărie apare deasupra paginilor;
   - un cont „personal” al membrului → o cheltuială → pagina tranzacției → „Împarte cheltuiala” (egal) → la amândoi soldurile pe `/family` și widgetul de pe Acasă;
   - decontare parțială → soldul scade; anulare → revine;
   - același link încă o dată → „Invitația nu mai este valabilă…”.
8. **Jurnale:** linkul de invitație conține tokenul în cale; jurnalele Cloudflare/Traefik pot conține căi `/join/<token>`. Tokenul e de unică folosință și expiră (≤ 168 h); dacă jurnalele de acces sunt păstrate și partajate, revocă invitațiile neacceptate. Același token mai trece prin două canale (risc ACCEPTAT, SECURITY_CHECKLIST §20): `/login?next=/join/<token>` (cine deschide linkul fără sesiune) și, dacă e configurat SMTP, emailul magic-link (URL-ul de întoarcere conține `next`). Atenuări: unică folosință, expiră ≤ 168 h, cere Access + sesiune, destinatarul e invitatul, revocabil; pe `/join/*` răspunsurile au `Referrer-Policy: no-referrer`.
9. **Bazele de dezvoltare/staging** care au aplicat o versiune ANTERIOARĂ a `0012_family` (din branch, înaintea revizuirilor) trebuie recreate: hash-ul migrației s-a schimbat, iar runner-ul refuză o migrație modificată după aplicare. Producția nu e afectată (`0012` nu e aplicată acolo).

**Rollback:** imaginea anterioară a `finet-web` (paginile și rutele familiei dispar; datele rămân). Migrația `0012`: comenzile din antet, doar cu backup și decizia operatorului (atenție: rollback-ul ei face din nou conturile personale vizibile tuturor).

## 4l. Faza 9 (F9-A): PWA, offline, aplicația Android — pe producție (după revizuiri)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0020. **Fără migrație, fără variabilă de mediu nouă, fără secret nou.**

1. **Imaginea** `finet` pentru commit-ul aprobat, apoi **redeploy `finet-web`** (aduce `/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/offline`, `/pwa/*`, `/help`, `/settings`, `/settings/android`, `GET /api/v1/app/android/latest`). Workerul nu se schimbă.
2. **Cloudflare Access: nu se schimbă nimic.** Toate căile de mai sus cer Access, ca restul aplicației. Manifestul e cerut cu credențiale. Opțional (decizia operatorului), dacă iconițele lipsesc la instalare: o aplicație Access de tip *Bypass* DOAR pe căile exacte `/manifest.webmanifest`, `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-192.png`, `/icons/icon-maskable-512.png`, `/icons/apple-touch-icon.png` (fișiere statice, fără date) — și atunci și excepția exactă în aplicație (ADR 0020 §1; nefăcută acum). **Niciodată** bypass pe `/sw.js`, `/offline`, `/api/**` sau pe un prefix.
3. **Verificări (browser, prin Access):**
   - DevTools → Application → Service Workers: `/sw.js` activ, domeniul `/`; Cache Storage: un singur `finet-static-<BUILD_ID>` cu `/offline`, `/pwa/*`, iconițele, manifestul și `/_next/static/*` — **niciun** `/api/*`, nicio pagină;
   - DevTools → Network → „Offline” → navighează la `/transactions` → pagina „Nu există conexiune la internet”;
   - `/import` offline → o poză → „Păstrează pentru mai târziu” → „În așteptare (offline)”; înapoi online → dispare, documentul apare o singură dată;
   - după un deploy nou: bannerul „Versiune nouă a aplicației disponibilă” → „Actualizează”.
   ```bash
   # fără Access, toate dau 403:
   for p in /sw.js /manifest.webmanifest /icons/icon-192.png /offline /api/v1/app/android/latest; do
     curl -s -o /dev/null -w "$p %{http_code}\n" "https://finet.<domeniu>$p"; done
   ```
4. **Aplicația Android (când există un release):** fișierul `<STORAGE_DIR>/app/android-latest.json` (în container: `${STORAGE_DIR}/app/android-latest.json`; pe host: volumul de storage al `finet-web`), proprietar uid-ul containerului, ≤ 16 KiB:
   ```json
   {
     "versionName": "1.0.0",
     "versionCode": 1,
     "minSupportedVersionCode": 1,
     "url": "https://github.com/<organizatie>/<repo>/releases/download/FINET-v1.0.0/finet-1.0.0.apk",
     "sha256": "<64 de caractere hex din finet-1.0.0.apk.sha256>",
     "sizeBytes": 23456789,
     "notes": "Prima versiune.",
     "publishedAt": "2026-11-01T10:00:00Z"
   }
   ```
   Se citește la fiecare cerere (fără restart). Un fișier invalid înseamnă „indisponibil” (log `[android] android-latest.json: conținut invalid`). Verificare: `/settings/android` arată versiunea, suma și codul QR; `GET /api/v1/app/android/latest` → 200.

**Rollback:** imaginea anterioară a `finet-web`. Service worker-ul deja instalat rămâne în browsere până la următoarea verificare: scriptul vechi lipsește (404) → browserul îl dezînregistrează singur; pentru o oprire imediată, utilizatorii pot șterge datele site-ului.

## 4m. Faza 9 (F9-B): GDPR, statistici, retenție — pe producție (după revizuiri, după 4l)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0021. **O migrație (`0016_gdpr_stats`), fără variabilă de mediu nouă, fără secret nou.** La merge cu Faza 7 (migrațiile 0013–0015), jurnalul `meta/_journal.json` se reconciliază: `0016` rămâne ultima (`when` 1794600000000), cu `idx` după 0015.

1. **Verificarea dinainte (doar citire, Supabase SQL Editor sau `psql` ca `finet_migrator`):**
   ```sql
   -- câte evenimente intră în prima agregare (mai vechi de 13 luni); orientativ, fără date personale
   select count(*) from finet.app_events where occurred_at < now() - interval '13 months';
   -- administratorul platformei (nu își poate șterge contul din aplicație)
   select count(*) from finet.users where is_platform_admin;
   ```
   Nimic de corectat: migrația nu rescrie date și nu adaugă coloane pe tabelele existente.
2. **Backup propriu verificat** (`run-backup.sh` reușit chiar înainte), apoi **migrația**: `docker compose … --profile migrate run --rm finet-migrate` → `aplicată: 0016_gdpr_stats`; a doua rulare: `aplicate acum 0`.
3. **Imaginea** `finet` pentru commit-ul aprobat, apoi redeploy `finet-web` (paginile `/settings/privacy`, `/settings/statistics` și rutele `GET /api/v1/me/export`, `GET /api/v1/me/deletion`, `POST /api/v1/me/delete`, `GET /api/v1/admin/stats`) și imaginea `tools` (comanda `aggregate-events`). Workerul nu se schimbă. **Cloudflare Access: nimic de schimbat** (toate căile cer Access).
4. **Retenția evenimentelor:** prima rulare manuală, apoi zilnic, cu `sudo crontab -e` (NU `crontab -`, NU redirectări care suprascriu crontab-ul), la 04:35 (după `cleanup-idempotency` 04:15 și `finet-cleanup` 04:25):
   ```cron
   35 4 * * *  cd /srv/finet/src && docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile admin run --rm -T finet-admin aggregate-events >> /var/log/finet-cleanup.log 2>&1
   ```
   Ieșirea: doar numărul de evenimente agregate (prima dată poate fi mare; loturi de 10 000). Verificare: a doua zi `sudo tail -n 3 /var/log/finet-cleanup.log`.
5. **Verificări prin Access (browser):**
   - ca administrator: `Setări → Statistici` arată tabelele (utilizatori activi, instalări, login-uri), fără sume sau descrieri; ca alt membru: 404;
   - `Setări → Datele mele → Descarcă arhiva` → `finet-export.zip` se deschide (README, `profil.json`, `gospodarii/<n>/…`);
   - ștergerea: doar pe un cont de test creat pentru asta (`finet-admin create-user`), niciodată pe un cont real; după ștergere, login-ul eșuează. Logul `finet-web` are o linie `[gdpr] cont șters; … fișiere=N eșuate=M`. Dacă `eșuate` > 0 (sau periodic): fișierele orfane se găsesc și se șterg cu comanda dedicată, întâi în dry-run (doar contoare):
     ```bash
     sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile cleanup run --rm -T finet-cleanup cleanup-orphan-storage          # scanned=… orphans=… deleted=0 dry_run=1
     sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env --profile cleanup run --rm -T finet-cleanup cleanup-orphan-storage --yes    # șterge cel mult 100
     ```
     Rulează în serviciul `finet-cleanup` (singurul cu storage-ul montat în SCRIERE), cu aceeași regulă de siguranță ca `cleanup-documents`: fără `STORAGE_DIR` montat nu atinge nimic; refuză dacă niciun director nu are gospodărie în bază. Opțional, săptămânal (`sudo crontab -e`), DOAR în dry-run, ca semnal în log: `45 4 * * 1  cd /srv/finet/src && docker compose … --profile cleanup run --rm -T finet-cleanup cleanup-orphan-storage >> /var/log/finet-cleanup.log 2>&1`; ștergerea (`--yes`) rămâne manuală, după citirea raportului (ADR 0021 §1).
6. **HSTS `preload`:** rămâne oprit. Consecințele sunt în `docs/SECURITY_CHECKLIST.md`, secțiunea 22.

**Rollback:** imaginile anterioare ale `finet-web` și `tools`; migrația se poate lăsa aplicată (nimic din aplicația veche nu o folosește). Rollback-ul complet al 0016 e în antetul fișierului și pierde agregatele zilnice.

## 4n. Faza 7 pe producție (ordinea completă, după revizuiri; F7-A + F7-B)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0018 (inclusiv §11, calea PDF) și ADR 0019.

1. **Ordinea:** după 4k (`0012_family`) și 4m (`0016_gdpr_stats`, deja aplicată pe producție). Jurnalul migrațiilor are ordinea `… 0012, 0016, 0013, 0014`: `0013` și `0014` au `when` ridicat peste `0016` la merge-ul cu Faza 9 (1794700000000, 1794800000000), ca runner-ul să le aplice DUPĂ `0016` (refuză o migrație nouă anterioară uneia deja aplicate); numele fișierelor rămân. Imaginile `finet` și `finet:tools` pentru commit-ul aprobat.
2. **Verificarea dinaintea lui `0014`** (indexul unic „un bon per tranzacție” pe `receipts`): pe Supabase, ca `postgres`, cu psql (ca la `roles.sql`):
   ```bash
   psql "<url-postgres>?sslmode=verify-full&sslrootcert=<ca.crt>" -X -At -c \
     "select transaction_id, count(*) from finet.receipts where transaction_id is not null group by 1 having count(*) > 1;"
   ```
   Rezultatul trebuie să fie GOL. Dacă apar rânduri (două bonuri legate de aceeași tranzacție), migrația ar eșua la crearea indexului (fără efecte: totul într-o tranzacție): se dezleagă manual bonul în plus (`update finet.receipts set transaction_id = null, status = 'needs_review' where id = '<id>'`), apoi se reia verificarea.
3. **Backup** al schemei `finet`, apoi **migrațiile `0013_statements` și `0014_statement_uploads`** (rolul `migrate`; prima rulare „aplicate acum 2”, a doua „aplicate acum 0”). `0013` nu modifică tabelele existente. `0014` adaugă trei tabele noi, pe `receipts` indexul unic parțial `receipts_transaction_key` și triggerul `receipts_check_transaction`, pe `statement_usage_daily` triggerul care refuză scăderea contorului, plus 5 funcții SECURITY DEFINER (doar identificatori). Rollback: antetele fișierelor, doar cu backup.
4. **Nicio variabilă și niciun secret nou.** PDF-urile de extras se scriu de `finet-web` în același `STORAGE_DIR` (sub `households/<id>/documents/`), le citește `finet-worker` (montajul doar-citire existent) și le șterge web-ul la confirmare/renunțare sau `finet-cleanup` la expirare (24 h). Workerul (imaginea `tools`) conține `dist/tools/pdf-items-child.mjs` (folosește `prlimit`, deja în imagine); limita de memorie (≤ 384 MB) rămâne: procesul copil are plafonul lui, iar extrasele se citesc unul câte unul (concurență 1).
5. **Curățarea:** serviciul existent `finet-cleanup` (4i, `cleanup-documents`) șterge acum și PDF-urile de extras expirate sau eșuate și previzualizările neconfirmate mai vechi de 7 zile; ieșirea are în plus `statements=<n> statements_failed=<n> previews=<n>` (doar contoare). Fără cron nou dacă 4i e programat; altfel programarea din 4i e acum obligatorie (fără ea, PDF-urile neconfirmate rămân pe disc).
6. **Proxy:** ruta exactă `/api/v1/statements/uploads` e exclusă din proxy-ul Next (extrase până la 20 MB, ca `/api/v1/documents`); ruta refăce verificarea Cloudflare Access. Dacă există un plafon al corpului în Traefik/tunel, trebuie să permită ≥ 21 MB pe această cale.
7. **Redeploy** `finet-web` și `finet-worker`. Jurnalul workerului la pornire: `{"event":"receipts",…,"statements":true}`.
8. **Verificare după deploy:** pe un cont de test, un CSV mic → alegerea coloanelor → previzualizare → confirmare → reîncărcare („deja importat”, 0 tranzacții noi) → anulare; un PDF de extras propriu → „în coadă” → previzualizare în ≤ 2 minute; `select count(*) from finet.statement_uploads where storage_key is not null` revine la 0 după confirmare/renunțare; jurnalele (`docker logs finet-worker`) conțin doar coduri și contoare.

## 4o. Faza 10 (F10-A): liste de cumpărături — pe producție (după revizuiri, după 4n)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0022. Se aplică împreună cu F10-B (4p) sau separat; ordinea migrațiilor la merge: `0017`, apoi `0018`.

1. **Ordinea:** după 4n (Faza 7, `0013`/`0014`) și 4m (`0016`). Jurnalul are `0017_shopping_lists` cu `when` 1794900000000, mai mare decât ultima intrare aplicată (1794800000000, `0014`); runner-ul refuză o migrație nouă mai veche decât una aplicată. Imaginile `finet` și `finet:tools` pentru commit-ul aprobat (construite în CI, nu local).
2. **Backup** al schemei `finet`, apoi **migrația `0017_shopping_lists`** (rolul `migrate`; „aplicate acum 1”). Adaugă trei tabele (`shopping_lists`, `shopping_list_items`, `shopping_list_ai_requests`) cu RLS ENABLE + FORCE, 7 funcții/triggere SECURITY DEFINER sau de plafon și, pe `receipt_lines`, doar cheia unică `receipt_lines_id_household_key (id, household_id)` (nu rescrie date). Rollback: antetul fișierului, doar manual, cu backup (distruge listele și coada AI).
3. **Variabile:** `AI_LIST_MATCH` (doar `finet-worker`, `0` implicit; vezi `finet.worker.env.example`). Cu `0` sau lipsă, pasul LLM e oprit și comparația rulează numai din cod. Pentru `1` sunt necesare AI configurat (Faza 6) și consimțământul `external_ai` al utilizatorului; consumă din bugetul AI lunar existent (`task = list_match` în `ai_calls`). Nicio variabilă pe `finet-web`, niciun secret nou.
4. **Redeploy** `finet-web` și `finet-worker`. Jurnalul workerului la pornire conține job-urile `list-match.sweep`/`list-match.process` (doar nume de joburi, fără conținut).
5. **Verificare după deploy:** pe un cont de test: creează o listă comună cu 3 articole, bifează unul (apare live la un al doilea membru), creează o listă PERSONALĂ (al doilea membru NU o vede, nici ca id), arhivează, copiază; confirmă un bon sintetic și rulează „Comparație cu bonul” (potrivite/neplanificate/uitate); `select count(*) from finet.shopping_list_ai_requests` rămâne 0 cu `AI_LIST_MATCH=0`; jurnalele (`docker logs finet-worker`) nu conțin nume de produse.
6. **Backup/GDPR:** listele intră în backup-ul restic existent (schema `finet`); nu e nevoie de modificări. Ștergerea contului elimină listele personale ale utilizatorului (ADR 0022 §6).

## 4p. Faza 10 (F10-B): prețuri, inflație, rapoarte de micro-cheltuieli — pe producție (după revizuiri)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0023. Se aplică după 4o (F10-A) sau separat; ordinea migrațiilor la merge: `0017`, apoi `0018`.

1. **Ordinea:** după 4n; jurnalul are `0018_report_definitions` cu `when` 1795000000000, mai mare decât `0017` (1794900000000) și decât ultima intrare aplicată. Imaginile `finet` și `finet:tools` pentru commit-ul aprobat (construite în CI).
2. **Backup** al schemei `finet`, apoi **migrația `0018_report_definitions`** (rolul `migrate`; „aplicate acum 1” dacă 0017 e deja aplicată). Tabel nou cu RLS ENABLE + FORCE, un trigger de plafon și șase rapoarte de sistem inserate de migrație (`is_system`, fără gospodărie). **Nu modifică tabelele existente.** Rollback: antetul fișierului, doar manual, cu backup (distruge rapoartele proprii ale gospodăriilor).
3. **Nicio variabilă și niciun secret nou; fără LLM și fără apeluri externe.** Utilizatorii E2E `insights`/`insights2` sunt doar pentru CI (nu se creează pe producție).
4. **Redeploy** `finet-web` (calculele rulează în procesul web; workerul nu se schimbă).
5. **Verificare după deploy:** pe un cont cu bonuri confirmate: `/insights` arată cele șase rapoarte de sistem; „Pungi și sacoșe” rulat pe „toată arhiva” include «PUNGA RAFIE» și NU «PUNGI MENAJ»; un raport propriu cu previzualizare, salvare, export CSV; sub pragul de date (3 observații / 2 luni) prețurile arată „Nu sunt suficiente date”; cu un al doilea membru, un bon legat de contul PERSONAL al primului nu apare în totalurile celui de-al doilea; `select count(*) from finet.report_definitions where is_system` = 6.
6. **Performanță (măsurată, nu estimată):** `FINET_PERF=1 DATABASE_URL=<superuser> pnpm exec vitest run src/db/perf-prices.test.ts`, ~50.000 de linii (4.200 de bonuri, 3 ani), ca `finet_app` cu RLS, PG17 cu 256 MB pe gazda de dezvoltare (mediana din 5 / minim): prețuri 12 luni 6,7 s / 4,4 s; prețuri 3 ani 1,9 s / 1,7 s; inflație 0,9 s / 0,8 s; rapoarte pe toată arhiva 0,13–2,0 s. Planul (auto_explain, `EXPLAIN ANALYZE, BUFFERS`): `Index Scan using receipts_id_household_key` / `receipts_household_status_idx` pe `receipts` (3.780 de bonuri vizibile din 4.200), `Seq Scan` pe `receipt_lines` filtrat pe gospodărie (~50.000 de rânduri, ~25 ms), hash join și sortare externă (~200 ms, 5 MB pe disc la memoria mică); acoperirea proiecției ~138 ms. Nu s-a adăugat niciun index. Cifrele NU sunt sub o secundă pe acest volum; de reluat pe Supabase (mai multă memorie) înainte de a decide un index sau o materializare. Peste 100.000 de linii în fereastră: `409 too_many_lines`.
7. **Backup/GDPR:** `report_definitions` intră în backup-ul restic existent; exportul GDPR include rapoartele create de utilizator.

## 5. Supabase: conexiuni și limite
| Ce | Valoare |
|---|---|
| Regiune | UE, Irlanda (`eu-west-1`), proiect creat la 2026-10-27 |
| Versiune PostgreSQL | `17` (17.11 la 2026-10-27, verificat prin Management API); `ops/postgres/VERSION` = `17` |
| Limita de conexiuni a planului (pooler, directe) | **TODO operator** (din panou, după alegerea planului) |
| Pool-uri FINET | `/api/health`: 1 conexiune (`max: 1`); clientul Drizzle (`src/db/index.ts`): implicit 5 pe proces (`DEFAULT_POOL_MAX`, decizia mea, de ajustat sub limita planului); `finet-migrate`: 1; `finet-worker` (Faza 5, modul sesiune 5432): 3 (`pg`, pg-boss) + 2 (postgres.js, serviciile) |
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
2. Compatibilitatea: workflow-ul săptămânal `.github/workflows/pg-next.yml` (din Faza 9) rulează testele pe `postgres:<VERSION+1>-alpine` și încercarea upgrade-ului (`ops/postgres/upgrade-test.sh`: dump pe versiunea curentă → restaurare pe cea următoare, amprenta identică, migrațiile „aplicate acum 0”). Trebuie să fie verde înainte de pasul 6. Manual (pe host, doar containere efemere pe o rețea privată, cu `--memory=256m`):
   ```bash
   # serverul vechi (VERSION) migrat + datele de control; serverul nou gol; apoi:
   docker run --rm --network <rețea> -v "$PWD/ops/postgres:/ops:ro" -e FINET_UPGRADE_TEST=1 \
     -e OLD_URL=postgres://finet:<fictiv>@<vechi>:5432/finet_upgrade \
     -e NEW_URL=postgres://finet:<fictiv>@<nou>:5432/finet_upgrade \
     -e NEW_MIGRATOR_URL=postgres://finet_migrator:finet_migrator_ci@<nou>:5432/finet_upgrade \
     --entrypoint sh postgres:<nou>-alpine /ops/upgrade-test.sh
   ```
   Rezultatul încercării 17 → 18 (Faza 9): `docs/reports/faza-9.md`, F9-B.
3. Backup propriu verificat (`pg_dump` + fișiere, restic; `docs/BACKUP.md`): un `run-backup.sh` reușit chiar înainte. Pentru o versiune majoră nouă, imaginea de backup trebuie să aibă `pg_dump` cel puțin de acea versiune (`postgresql<N>-client` în `ops/backup/Dockerfile`), altfel pg_dump refuză serverul mai nou.
4. Notează valorile de control: numărul și suma tranzacțiilor pe gospodărie (interogare din Faza 3).
5. Anunț către familie; fereastră de noapte.
6. Supabase → Settings → Infrastructure → Upgrade project.
7. După: `/api/health` = `ok`; valorile de control identice; `docker logs finet-web` fără erori.
8. PR: `ops/postgres/VERSION` și imaginea din `.devcontainer/docker-compose.yml` actualizate.
9. Dacă verificarea eșuează: restaurare din backup într-un proiect nou și comutarea `DATABASE_URL`.

## 8. Notificări operaționale
`ops/notify/notify.sh`: Telegram (`NOTIFY_TELEGRAM_BOT_TOKEN` + `NOTIFY_TELEGRAM_CHAT_ID`) sau email (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `NOTIFY_EMAIL_TO`), `--test`, `--dry-run`, `--env-file`. Folosește `curl` (pe host); secretele nu apar în argumentele proceselor. Îl folosește backup-ul (`ops/backup/run-backup.sh`, F3-D: alertă la eșec cu anti-flood, mesaj săptămânal de succes); scripturile pentru versiunea PostgreSQL, `/api/health` roșu și disc **nu există încă**.

## 4q. Faza 10 (F10-C, partea 1): exporturi Excel/PDF și export pentru contabil — pe producție (după revizuiri, după 4p)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0024. **Fără migrație, fără variabile, fără secrete noi**: se aplică doar prin redeploy.

1. **Imaginea `finet` (web)** pentru commit-ul aprobat, construită în CI (`pull-images.sh <sha> web`). Workerul nu se schimbă.
2. **Backup** înainte de deploy, ca de obicei (nu există modificări de schemă).
3. **Redeploy** `finet-web`.
4. **Verificare după deploy:** pe `/transactions` cu un filtru, „Export Excel” și „Export PDF” descarcă `finet-tranzactii.xlsx`/`.pdf` (Excel deschide fișierul fără avertisment, PDF-ul arată diacriticele); pe `/receipts`, cardul „Export pentru contabil” pe luna trecută: rândurile sunt cele ale bonurilor confirmate, iar „Diferență TVA”/„Diferență total” sunt 0 sau explicabile. Un membru al gospodăriei NU vede bonurile din contul personal al altui membru. `select metadata from finet.audit_events where action = 'export.downloaded' order by created_at desc limit 5` conține doar `kind`, `rows` și (pentru Excel/PDF) `format`.
5. **Memorie (măsurată pe 10 coloane):** Excel cu 20.000 de rânduri ≈ 133 MB RSS peste cel de repaus (~1 s), PDF cu 3.000 ≈ 57 MB; `finet-web` are 512 MB (repaus ~86 MB). Două exporturi mari simultane pot apropia limita; plafonul Excel e `XLSX_MAX_ROWS` (`src/lib/xlsx.ts`). Dacă apar OOM-uri, cere exportul în CSV (flux, memorie mică).

## 4r. Faza 10 (F10-C, partea 2): „Întreabă FINET” și rezumatul lunii — pe producție (după revizuiri, după 4q)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0025. **Fără migrație, fără variabile, fără secrete noi, fără apeluri AI**: se aplică doar prin redeploy.

1. **Imaginea `finet` (web)** pentru commit-ul aprobat, construită în CI (`pull-images.sh <sha> web`). Workerul nu se schimbă.
2. **Backup** înainte de deploy, ca de obicei (nu există modificări de schemă).
3. **Redeploy** `finet-web`.
4. **Verificare după deploy:** pe `/ask`, „Cât am cheltuit luna trecută?” întoarce o sumă egală cu totalul de pe `/reports` pentru aceeași lună și arată interogarea folosită; „Ce vreme e mâine?” întoarce „Nu am înțeles”; pe `/reports`, cardul „Rezumatul lunii” are eticheta „Rezumat automat, nu sfat financiar.”. Un membru NU vede în răspunsuri cheltuielile din contul personal al altui membru. `docker logs finet-web` nu conține textul întrebărilor.
5. **Pasul cu LLM (neimplementat):** necesită o decizie (acces al web-ului la LiteLLM sau coadă către worker) și migrația `0019` (sarcina `ask_finet`); vezi ADR 0025 §2. Până atunci `AI_*` rămân doar pe worker.

## 4s. Faza 10 (F10-C, pasul LLM): „Întreabă FINET” cu model extern — pe producție (după revizuiri, după 4r)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0026. **Oprit implicit.** Pași, în ordine; fiecare cere acordul explicit al operatorului (migrație Supabase, secret nou, variabile pe `finet-web`, redeploy):

1. **Imaginea `finet` (web) și `finet:tools` (migrația)** pentru commit-ul aprobat, construite în CI (`pull-images.sh <sha> web` și `tools`). Workerul nu se schimbă.
2. **Backup** al schemei `finet`, apoi **migrația `0019_ask_finet_task`** (rolul `migrate`; „aplicate acum 1”). Înlocuiește două constrângeri CHECK (`ai_calls_task_valid`: + `ask_finet`; `consents_kind_valid`: + `external_ai_ask`); nicio coloană, politică sau dată. Rollback: antetul fișierului, doar manual, cu backup.
3. **Cheie LiteLLM DEDICATĂ** (nu cea a workerului): în LiteLLM, o cheie virtuală nouă pentru „finet-ask”, permisă DOAR pe modelul text (`finet-text-external`/`gemini-3.8-flash`), cu plafon de cheltuieli propriu. Se salvează în `/srv/finet/secrets/finet_ask_litellm_key` (uid 1000, mod 400). Nu se afișează și nu se pune în variabile în clar (`AI_ASK_API_KEY` în clar e refuzată la pornire).
4. **Variabile pe `finet-web`** (`/srv/finet/env/finet.env`): `AI_ASK=1`, `AI_BASE_URL`, `AI_ALLOWED_HOSTS` (aceleași valori ca la worker), opțional `AI_TEXT_MODEL`, `AI_TIMEOUT_MS=30000`, `AI_MAX_RETRIES=1`, `AI_RESPONSE_FORMAT=json_object`, `AI_PRICE_*`; `AI_MONTHLY_BUDGET` > 0 (bugetul e GLOBAL, partajat cu bonurile și listele). Web-ul trebuie să ajungă la LiteLLM (`172.88.88.4:4000` pe rețeaua `apps`): verifică atașarea rețelei și că firewall-ul/Access nu blochează.
5. **Redeploy `finet-web` cu fișierul suplimentar:** `docker compose -f ops/docker/docker-compose.yml -f ops/docker/docker-compose.ask.yml --env-file /srv/finet/compose/compose.env up -d --no-build finet-web`. Fără `docker-compose.ask.yml`, secretul nu se montează și `AI_ASK=1` face ca web-ul să nu pornească (config refuză).
6. **Verificare după deploy:** în Profil apare „Întreabă FINET cu AI”; fără acord, o întrebare formulată liber („ce sumă mi-au luat alimentele luna trecută”) răspunde „Nu am înțeles” cu indiciul pentru activare și `select count(*) from finet.ai_calls where task = 'ask_finet'` rămâne 0; după acord, aceeași întrebare răspunde cu `source: ai`, iar `ai_calls` are un rând `ask_finet`/`ok`; o întrebare pe care parserul o înțelege („Cât am cheltuit luna trecută?”) NU creează rând; `docker logs finet-web` nu conține textul întrebărilor sau cheia.
7. **Oprire rapidă:** `AI_ASK=0` în `finet.env` și redeploy fără fișierul suplimentar; datele rămân neatinse.

## 4t. Faza 11-B: feedback, anunțuri, erori, administrare — pe producție (după revizuiri)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0028. Funcțiile există doar în modul `saas`; pe producția `personal` migrația ar crea doar tabele goale și funcții neapelate (rutele dau 404), deci aplicarea e **opțională** până când există un deploy `saas`. Dacă se aplică:

1. **Imaginile `finet` (web) și `finet:tools`** pentru commit-ul aprobat (CI), apoi **backup** al schemei `finet`.
2. **Migrația `0020_admin_feedback`** (rolul `migrate`; „aplicate acum 1”): trei tabele cu RLS ENABLE + FORCE și șase funcții SECURITY DEFINER; nicio modificare a tabelelor existente. Rollback: antetul fișierului, manual, cu backup.
3. **Redeploy `finet-web`**; fără variabile sau secrete noi.
4. **Primul administrator în `saas`:** primul utilizator creat cu `finet-admin create-user` devine administrator al platformei. **Verificare:** un utilizator obișnuit primește 404 pe `/admin`; administratorul vede panoul; `select count(*) from finet.feedback` crește după un feedback; `select * from finet.audit_events where action like 'admin.%'` conține doar id-uri și stări.

## 4u. Faza 11-C1: înregistrarea publică și `/support` — pe producție (după revizuiri)

Agentul nu a rulat nimic din această secțiune și nu a atins producția. ADR 0029. **Fără migrație.** Nimic nu se schimbă pe producția `personal` (rutele dau 404). În `saas`, înregistrarea e **închisă implicit**.

1. **Imaginea** `finet` (web) pentru commit-ul aprobat (CI), apoi redeploy `finet-web`. Variabila nouă: `SIGNUP_ENABLED` (`0` implicit; `1` deschide `/register` și `POST /api/v1/register*`, doar în `saas` și doar cu SMTP configurat).
2. **Înainte de `SIGNUP_ENABLED=1` pe un deploy accesibil public** (toate, nu opțional): Turnstile implementat (11-C2) sau înregistrare doar din rețea controlată; textele juridice revizuite (`SITE_LEGAL_REVIEWED=1`, datele firmei complete); sursa IP de încredere stabilită (altfel limitele pe IP sunt comune); politica Cloudflare Access/WAF pentru `/register`, `/register/complete`, `/api/v1/register*`; plan pentru curățarea conturilor neconfirmate; un SMTP cu SPF/DKIM/DMARC (linkurile de confirmare trebuie să ajungă).
3. **Verificare** (după deschidere, pe un email de test): cererea de pe alt `Origin` → 403; `POST /api/v1/register` → 202; emailul conține linkul `/register/complete?token=…`; parola aleasă permite autentificarea; același link a doua oară → 410; `select email_verified from finet.users where email = '<test>'` → `true`; `select action from finet.audit_events where action = 'user.email_verified'`.

## 4v. Faza 11-C2: Turnstile pe `/register` — pe producție (după revizuiri)

Agentul nu a rulat nimic din această secțiune. ADR 0030. **Fără migrație.** Doar pentru un deploy `saas`; pe `personal` nu are efect.

1. **Cheile**, din Cloudflare (Turnstile, widget „Managed”, domeniul aplicației): cheia site (publică) în `finet.env` ca `TURNSTILE_SITE_KEY=…`; cheia secretă ca fișier: `printf '%s' '<cheia-secretă>' | sudo install -o 1000 -g 1000 -m 400 /dev/stdin /srv/finet/secrets/finet_turnstile_secret` (NU o pune în `finet.env`, în istoricul shell-ului sau într-un mesaj).
2. **Redeploy `finet-web`** cu `-f ops/docker/docker-compose.turnstile.yml` ADĂUGAT la fișierele compose deja folosite (inclusiv `docker-compose.ask.yml`, dacă e cazul: lista de fișiere trebuie să fie completă la fiecare redeploy).
3. **Verificare** (browser, pe adresa publică): pe `/register` apare widgetul și butonul se activează după verificare; în consolă nu apar încălcări CSP; `/login` și `/register/complete` NU încarcă nimic de la `challenges.cloudflare.com`; un POST fără token la `/api/v1/register` → `400 turnstile`. Cu o cheie secretă greșită, orice înregistrare e respinsă (fail-closed), nu acceptată.
4. `SIGNUP_ENABLED=1` rămâne subordonat restului listei din 4u (texte juridice revizuite, sursă de IP de încredere, curățarea conturilor neconfirmate, politica Access pentru căile publice).

## 4w. Faza 11-C2: autentificarea cu Google — pe producție (după revizuiri)

Agentul nu a rulat nimic din această secțiune. ADR 0032. **Fără migrație.** Doar `APP_MODE=saas`; doar conturi FINET existente cu email verificat (fără creare de cont).

1. **Google Cloud Console:** un client OAuth „Web application”; „Authorized redirect URI” = `<APP_URL>/api/auth/callback/google` (exact); ecranul de consimțământ cu numele aplicației, domeniul și linkul către politica de confidențialitate publicată; scope-uri doar `openid`, `email`, `profile` (nesensibile, fără verificare extinsă).
2. **Configurare:** `GOOGLE_CLIENT_ID=…` în `finet.env`; secretul ca fișier: `printf '%s' '<secret>' | sudo install -o 1000 -g 1000 -m 400 /dev/stdin /srv/finet/secrets/finet_google_client_secret` și, în compose, `GOOGLE_CLIENT_SECRET_FILE: /run/secrets/finet_google_client_secret` + secretul montat în `finet-web` (ca la `finet_turnstile_secret`; lista de fișiere compose trebuie să fie completă la fiecare redeploy). NU pune secretul în `finet.env`.
3. **Verificare** (browser, cont de test existent, cu email verificat și parolă): „Continuă cu Google” deschide Google; după alegerea contului revii în aplicație autentificat; `select provider_id, account_id, access_token, refresh_token, id_token from finet.auth_accounts where provider_id = 'google'` arată `access_token`, `refresh_token`, `id_token` goale; un cont Google cu alt email → înapoi la `/login` cu mesajul fix, fără utilizator nou (`select count(*) from finet.users` neschimbat); un cont FINET cu email neverificat → același mesaj.
4. Rezerva: ștergerea variabilelor `GOOGLE_*` și redeploy opresc complet fluxul (căile revin la 404); conturile Google legate rămân inerte în `auth_accounts`.

## 4x. Curățarea conturilor de înregistrare neconfirmate (Faza 11, 0021) — pe producție

Agentul nu a rulat nimic din această secțiune. SECURITY_CHECKLIST §36. **Cere migrația `0021_purge_unverified`** (o singură funcție de citire; fără schimbări de schemă; rollback în antetul fișierului) și o frază explicită pentru Supabase. Are sens doar în `APP_MODE=saas` cu `SIGNUP_ENABLED=1`: în `personal` nu există conturi neconfirmate, deci comanda raportează `found=0`.

1. **Migrația:** `finet-migrate` ca la 0020 (după backup). Verificare: „aplicate acum 1, deja aplicate 20”.
2. **Dry-run** (nu șterge nimic): `docker compose -f docker-compose.yml -f docker-compose.ask.yml --env-file /srv/finet/compose/compose.env --profile cleanup run --rm -T finet-cleanup cleanup-unverified` → `found=N purged=0 failed=0 dry_run=1`.
3. **Ștergerea:** aceeași comandă cu `--yes` (opțional `--days 7 --limit 200`). Ieșirea are doar contoare, fără emailuri sau id-uri.
4. **Programare** (cron root, prin `sudo crontab -e`, nu `crontab -`): zilnic, după `finet-cleanup` (04:25), de exemplu 04:30, cu comanda de la pasul 3. Cod de ieșire 1 dacă un cont n-a putut fi șters (se reîncearcă la rulare următoare).
5. Un cont șters astfel poate fi reînregistrat de proprietarul adresei oricând (pasul 1 din ADR 0029).

## 4y. Planurile și abonamentele (Faza 12-A, 0023) — pe producție `saas`

Agentul nu a rulat nimic din această secțiune. ADR 0035, SECURITY_CHECKLIST §38. **Cere migrația `0023_plans_subscriptions`** (două tabele și o funcție de citire; rollback în antetul fișierului) și o frază explicită pentru Supabase. Are sens doar în `APP_MODE=saas`; în `personal` tabelele rămân goale și nu se citesc.

1. **Migrația:** `finet-migrate` ca la 0021/0022 (după backup). Verificare: „aplicate acum 1, deja aplicate 22”.
2. **Planurile se scriu de operator**, ca `finet_migrator` (aplicația nu poate): un plan implicit (gospodăriile fără abonament) și câte unul pe treaptă plătită. **Valorile le stabilești tu** (costul pe document din Faza 6); nimic de mai jos nu e o recomandare. Cheile `limits` recunoscute (numere întregi ≥ 0; lipsă sau invalid = 0, deci nimic permis): `ai.dailyDocuments`, `storage.quotaMb`, `household.maxMembers`, `documents.maxFileMb` (dimensiunea maximă a unui fișier, MB), `queue.priority` (mai mare = mai devreme în coada workerului, în cadrul aceluiași rând de echitate; 0 implicit), `receipts.historyMonths` (cu excepția acestei chei, lipsă = fără plafon: istoricul vizibil în luni). Funcții recunoscute în `features`: `ask.finet`, `reports.custom`, `documents.jpeg`, `documents.png`, `documents.webp`, `documents.pdf` (**un plan fără ele nu primește fișiere de acel tip**) și `receipts.archive` (istoric permanent). **0024** (`0024_queue_priority`, 12-A.2) se aplică la fel ca 0023; verificare: „aplicate acum 1, deja aplicate 23”.
   ```sql
   insert into finet.plans (code, name, is_default, limits, features)
   values ('<cod>', '<nume>', true,
           '{"ai.dailyDocuments": <n>, "storage.quotaMb": <n>, "household.maxMembers": <n>}'::jsonb,
           array['<funcție>']);
   ```
   Cel mult un plan implicit, activ. Fără niciun plan implicit, `saas` refuză toate scrierile (503 `plans_not_configured`).
3. **Abonament manual** (de exemplu fondator): `insert into finet.subscriptions (household_id, plan_id, status, provider) values ('<gospodărie>', '<plan>', 'active', 'founder');` (fără `current_period_end` nu expiră). Pentru probă: `status = 'trialing'` și `trial_end`.
4. **Verificare:** `select * from finet.household_plan('<gospodărie>');` → `plan_code`, `limits`, `features`, `state` (`ok`, `read_only` sau `none`).
5. **Efect:** abonament expirat sau anulat → scrierile primesc 402, citirea și exportul merg (API.md). Reînnoirea (status `active` cu perioadă viitoare) redeschide scrierile imediat.
6. **Trecerea `personal` → `saas` și planul fondator** (12-D): `docs/MIGRARE_PERSONAL_SAAS.md` (scripturile `ops/saas/founder-plan*.sql`).
7. Rezerva: ștergerea planului implicit (`delete`) face `saas` doar-citire; migrația se anulează cu comenzile din antet, doar cu backup și decizia explicită a operatorului.
## 4z. Recomandări (Faza 12-C, felia 1, 0025) — pe producție `saas`

Agentul nu a rulat nimic din această secțiune. ADR 0037, SECURITY_CHECKLIST §40. **Cere migrația `0025_referrals`** (trei tabele, patru funcții, `household_plan` redefinită; rollback în antet) și o frază explicită pentru Supabase. Felia 1 e doar stratul de date: fără rute sau interfață încă.

1. **Migrația:** `finet-migrate` ca la 0023/0024 (după backup). Verificare: „aplicate acum 1, deja aplicate 24”.
2. **Recompensele sunt oprite implicit.** Le pornești tu, ca `finet_migrator`, cu valorile TALE (planul trebuie să existe și să fie activ; nicio valoare de mai jos nu e o recomandare):
   ```sql
   update finet.referral_settings set
     reward_plan_code = '<cod plan existent>',
     invitee_days = <zile pentru invitat>,
     inviter_days = <zile pentru invitator>,
     inviter_max_rewards = <câte recompense primește un invitator>,
     redeem_window_hours = <ore, 1–720; implicit 24; cel puțin 48, cât valabilitatea linkului de confirmare>;
   ```
   Pentru oprire: `reward_plan_code = null` (sau zilele 0).
3. **Efect:** o recompensă creează/prelungește un abonament cu `provider = 'reward'`. Abonamentele `manual`, `founder`, `stripe` nu sunt atinse. La expirare, gospodăria revine la planul implicit (nu devine doar-citire).
4. **Verificare:** `select * from finet.referrals;` și `select * from finet.household_plan('<gospodărie>');`.
