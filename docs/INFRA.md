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
4. **`/srv/finet/env/finet.worker.env`:** `AI_BASE_URL=http://172.88.88.4:4000/v1`, `AI_ALLOWED_HOSTS=172.88.88.4:4000`, modelele, `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_CONFIDENCE_THRESHOLD`, `AI_PRICE_INPUT_PER_MTOK`/`AI_PRICE_OUTPUT_PER_MTOK` (tarifele reale ale modelului ales, în moneda bugetului), `AI_RESPONSE_FORMAT=json_schema`. **`AI_MONTHLY_BUDGET` rămâne 0** (nimic nu pleacă) până după pasul 6.
5. **Rețeaua:** `finet-worker` e pe `apps` (`172.88.88.131`), ca `litellm-apps` (`172.88.88.4`). Firewall-ul gazdei (`LEVINETIT-FW` în `DOCKER-USER`) privește porturile publicate; traficul între containerele de pe `apps` merge deja (open-webui → openclaw). Verificare: `sudo docker exec finet-worker node -e "fetch('http://172.88.88.4:4000/health/liveliness').then(r=>console.log(r.status))"` → 200.
6. **Prima verificare reală, înainte de buget > 0:** din imaginea de unelte sau dintr-un clone, `AI_EVAL=1 AI_BASE_URL=… AI_API_KEY_FILE=… pnpm eval:receipts` (8 bonuri sintetice, sub 1 cent la tarifele Flash).
   - Dacă primul apel dă HTTP 400 (schema refuzată), pune `AI_RESPONSE_FORMAT=json_object` și repetă.
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
2. PR care rulează testele pe `postgres:<versiunea nouă>-alpine` (local sau în CI, schimbând temporar `ops/postgres/VERSION` pe branch).
3. Backup propriu verificat (`pg_dump` + fișiere, restic; `docs/BACKUP.md`): un `run-backup.sh` reușit chiar înainte. Pentru o versiune majoră nouă, imaginea de backup trebuie să aibă `pg_dump` cel puțin de acea versiune (`postgresql<N>-client` în `ops/backup/Dockerfile`), altfel pg_dump refuză serverul mai nou.
4. Notează valorile de control: numărul și suma tranzacțiilor pe gospodărie (interogare din Faza 3).
5. Anunț către familie; fereastră de noapte.
6. Supabase → Settings → Infrastructure → Upgrade project.
7. După: `/api/health` = `ok`; valorile de control identice; `docker logs finet-web` fără erori.
8. PR: `ops/postgres/VERSION` și imaginea din `.devcontainer/docker-compose.yml` actualizate.
9. Dacă verificarea eșuează: restaurare din backup într-un proiect nou și comutarea `DATABASE_URL`.

## 8. Notificări operaționale
`ops/notify/notify.sh`: Telegram (`NOTIFY_TELEGRAM_BOT_TOKEN` + `NOTIFY_TELEGRAM_CHAT_ID`) sau email (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `NOTIFY_EMAIL_TO`), `--test`, `--dry-run`, `--env-file`. Folosește `curl` (pe host); secretele nu apar în argumentele proceselor. Îl folosește backup-ul (`ops/backup/run-backup.sh`, F3-D: alertă la eșec cu anti-flood, mesaj săptămânal de succes); scripturile pentru versiunea PostgreSQL, `/api/health` roșu și disc **nu există încă**.
