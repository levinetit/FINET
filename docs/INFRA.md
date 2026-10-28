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

Ce fixează compose-ul în `environment` (au prioritate față de `env_file`): `FINET_ROLE`, `NODE_ENV=production`, `APP_MODE=personal`, `CF_ACCESS_REQUIRED=true` (web), `STORAGE_DRIVER=local`, `STORAGE_DIR=/data/storage` (web, worker), `HOSTNAME=0.0.0.0`, `PORT=3000`, `NODE_OPTIONS`, căile secretelor (`DATABASE_URL_FILE` și `HEALTH_TOKEN_FILE` la web, `WORKER_DATABASE_URL_FILE` la worker, `MIGRATOR_DATABASE_URL_FILE` la migrate) și `DATABASE_CA_FILE` (toate trei).

Întărire: `read_only: true` (tmpfs pentru `/tmp` și `/app/.next/cache`), `cap_drop: [ALL]`, `no-new-privileges`, `init: true`, `pids_limit`, limite de memorie (web 512 MB, worker 256 MB; `memswap_limit` egal, fără swap) și CPU (1,0 / 0,5), loguri `json-file` 3×10 MB.

**Riscul de memorie:** cu ~1,1 GB disponibili pe host, `finet-web` (până la 512 MB) poate pune presiune pe celelalte servicii; sub OOM, kernelul omoară procese din containere. Valoarea reală a consumului **nu a fost măsurată** pe host (NOT RUN). Build-ul imaginii pe host (`--build`) cere temporar ~1,5 GB (`NODE_OPTIONS=--max-old-space-size=1536` în etapa de build): fă-l când hostul are memorie liberă sau construiește imaginea în altă parte.

**Workerul (decizia mea):** în Faza 0 nu există cod de worker (pg-boss vine în Faza 5/6). Serviciul există, ca structura să fie gata, dar e în profilul `worker`, deci **nu pornește implicit**; dacă e pornit, e un proces Node minimal care scrie „finet-worker: inactiv, vine în Faza 6” și răspunde la SIGTERM. Healthcheck-ul moștenit din imagine (server web) e dezactivat pentru el.

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

**Decizia:** toate datele și secretele FINET stau în **`/srv/finet/`** (`env/`, `secrets/`, `storage/`, `compose/`, `ca/`), în afara surselor ambelor backup-uri. Valorile implicite din `ops/docker/docker-compose.yml` și din `compose.env.example` indică acolo. Backup-ul propriu, **criptat**, al FINET (`pg_dump` din Supabase + fișierele, cu restic) vine în **Faza 3**; până atunci, datele din `/srv/finet/storage` nu au backup (în Faza 0 nu există date reale).

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

## 5. Supabase: conexiuni și limite
| Ce | Valoare |
|---|---|
| Regiune | UE, Irlanda (`eu-west-1`), proiect creat la 2026-10-27 |
| Versiune PostgreSQL | `17` (17.11 la 2026-10-27, verificat prin Management API); `ops/postgres/VERSION` = `17` |
| Limita de conexiuni a planului (pooler, directe) | **TODO operator** (din panou, după alegerea planului) |
| Pool-uri FINET | `/api/health`: 1 conexiune (`max: 1`); clientul Drizzle (`src/db/index.ts`): implicit 5 pe proces (`DEFAULT_POOL_MAX`, decizia mea, de ajustat sub limita planului); `finet-migrate`: 1 |
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
