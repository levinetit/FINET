# Ghid de construire FINET — de la zero, direct din GitHub

Acest ghid e pentru **tine, operatorul**. Spune ce configurezi o singură dată (GitHub, server, bază de date, Cloudflare) și cum construiești apoi aplicația fază cu fază, cu un agent (Claude Code), fără să instalezi nimic pe calculatorul tău.

Ce face agentul în fiecare fază e descris în [`FINET_MASTER_PROMPT.md`](FINET_MASTER_PROMPT.md) și [`FINET_ANDROID_MASTER_PROMPT.md`](FINET_ANDROID_MASTER_PROMPT.md). Ghidul de față nu le repetă; spune ce pregătești tu și în ce ordine.

> Valorile între `< >` (de exemplu `<domeniu>`) le înlocuiești cu ale tale. Parolele și cheile nu se scriu niciodată în repository, în issue-uri sau în chat.

---

## 0. Cum arată totul

```
                 ┌──────────────── GitHub (levinetit/FINET) ────────────────┐
  tu (browser) → │ cod · PR-uri · GitHub Actions (teste, build, APK)        │
                 │ Codespaces (mediu de lucru în browser, cu Postgres local)│
                 │ Releases (APK Android)                                   │
                 └───────────────▲──────────────────────────────────────────┘
                                 │ operatorul aduce codul din main (git pull)
                                 │ și construiește imaginea (deploy manual)
┌──────────── VPS docker-apps (Docker, rețeaua `apps`) ─────────────┐
│ finet-web (Next.js, container) · finet-worker (stub până în F5/6) │
│ finet-migrate (one-shot) · ollama / litellm-apps (existente)      │──── TLS ────▶ Supabase (UE)
│ cloudflare-tunnel (existent) sau traefik-main (existent) ──┐      │              PostgreSQL (schema finet)
│ date și secrete FINET în /srv/finet (în afara /home)       │      │              Storage (bucket privat)
└────────────────────────────────────────────────────────────┼──────┘
                                                             ▼
                     Cloudflare Tunnel + Access (doar emailurile familiei)
                                                             ▲
                   browser (login Access)  ·  telefon (Cloudflare One / WARP + FINET Android)
```

Principii:
- **GitHub** e locul unde se scrie și se testează totul (CI). Imaginea Docker se construiește deocamdată pe server; construirea ei în CI e planificată.
- **Serverul** e VPS-ul `docker-apps` (decizia din [ADR 0002](adr/0002-deploy-docker-pe-vps.md)): rulează aplicația și workerul în containere Docker, din `ops/docker/docker-compose.yml`. Codul nou îl aduci tu din `main`, după ce testele au trecut; deploy-ul automat e planificat (pasul 5).
- **Supabase** păstrează baza de date PostgreSQL și fișierele (pozele bonurilor, extrasele). Doar serverul FINET vorbește cu Supabase; browserul și telefonul nu.
- **Niciun port publicat** pentru FINET: intrarea se face prin tunelul Cloudflare existent (recomandat) sau prin Traefik-ul existent (`docs/INFRA.md`).

---

## 1. Ce îți trebuie

| Ce | De ce | Cost |
|---|---|---|
| Cont GitHub (ai deja `levinetit`) | cod, teste, Codespaces, Releases | gratuit pentru repository public; Codespaces are o cotă lunară gratuită |
| Acces la Claude Code (claude.ai/code sau CLI) | agentul care scrie codul pe faze | abonamentul tău Claude |
| VPS-ul `docker-apps` (Docker, Docker Compose, rețeaua `apps`, `cloudflare-tunnel` și `traefik-main` existente), cu acces `sudo` | rulează FINET în containere | existent |
| Cont Supabase | baza de date PostgreSQL și fișierele | gratuit pentru început; planul plătit e recomandat pentru date reale (backup-uri zilnice, fără suspendare) |
| Un domeniu administrat în Cloudflare | adresa aplicației (`finet.<domeniu>`) | prețul domeniului |
| Cont Cloudflare Zero Trust | tunel + Access + WARP | gratuit până la 50 de utilizatori |
| O destinație pentru backup | copia de siguranță în afara serverului | depinde (alt server, storage box sau bucket S3) |
| Un canal pentru alerte: bot Telegram sau un cont SMTP | notificări (backup, upgrade, server căzut) | gratuit |

---

## 2. Pasul 1 — Configurează repository-ul GitHub (o singură dată, 10 minute)

Toate setările de mai jos sunt în **Settings** pe `github.com/levinetit/FINET`.

### 2.1 Protejează `main`
**Settings → Rules → Rulesets → New branch ruleset**, țintă `main`:
- **Require a pull request before merging** (fără aprobări obligatorii dacă lucrezi singur; poți cere 1).
- **Require status checks to pass:** adaugi `ci` după ce agentul creează workflow-ul în Faza 0.
- **Block force pushes** și **Restrict deletions**.

Rezultatul: nimic nu ajunge în `main` fără PR și fără teste verzi, deci pe server ajunge doar cod testat, atâta timp cât faci deploy din `main`.

### 2.2 Securitate
**Settings → Code security**, pornește:
- Dependabot alerts și Dependabot security updates;
- Secret scanning și Push protection (blochează un push care conține din greșeală o cheie).

### 2.3 Actions pentru un repository public
**Settings → Actions → General:**
- *Fork pull request workflows from outside collaborators:* **Require approval for all external contributors**.
- *Workflow permissions:* **Read repository contents** (permisiunile suplimentare se dau explicit în fiecare workflow).

### 2.4 Secrete și variabile
**Settings → Secrets and variables → Actions.** Le adaugi pe măsură ce sunt cerute de faze; lista completă e în secțiunea 10. În Faza 0 nu e nevoie de niciun secret: testele folosesc o bază de date temporară, fără parole reale.

---

## 3. Pasul 2 — Mediul de lucru în browser (Codespaces)

Ca să vezi și să încerci aplicația fără să instalezi nimic local, agentul creează în Faza 0 un **dev container** (`.devcontainer/`) cu:
- Node 24 și pnpm;
- PostgreSQL local, aceeași versiune majoră ca proiectul Supabase (doar pentru dezvoltare, cu parolă de test, fără date reale);
- Mailpit (vezi emailurile de login fără un SMTP real).

Cum îl folosești, după Faza 0: pe pagina repository-ului, **Code → Codespaces → Create codespace on main**. În terminalul din browser:

```bash
pnpm install
pnpm db:migrate
pnpm db:seed:demo   # opțional, date fictive marcate „Demo”
pnpm dev
```

Codespaces deschide automat linkul aplicației. Dev container-ul există doar pentru dezvoltare; în producție, aplicația rulează în containerele din `ops/docker/docker-compose.yml` (pasul 5).

Fragmentul de referință pentru agent (`.devcontainer/devcontainer.json`, cu un `docker-compose.yml` alături):

```jsonc
{
  "name": "FINET",
  "dockerComposeFile": "docker-compose.yml",
  "service": "app",
  "workspaceFolder": "/workspaces/FINET",
  "forwardPorts": [3000, 8025],
  "postCreateCommand": "corepack enable && pnpm install",
  "remoteEnv": {
    "DATABASE_URL": "postgres://finet:finet_dev@db:5432/finet_dev",
    "APP_MODE": "personal"
  }
}
```

```yaml
# .devcontainer/docker-compose.yml (doar pentru dezvoltare)
services:
  app:
    image: mcr.microsoft.com/devcontainers/typescript-node   # cu tagul pentru Node 24, ales de agent
    volumes: ["..:/workspaces/FINET:cached"]
    command: sleep infinity
  db:
    image: postgres:<versiune>  # versiunea majoră a proiectului Supabase, din ops/postgres/VERSION
    environment: { POSTGRES_USER: finet, POSTGRES_PASSWORD: finet_dev, POSTGRES_DB: finet_dev }
  mailpit:
    image: axllent/mailpit
```

---

## 4. Pasul 3 — Pregătește serverul (o singură dată)

Serverul e VPS-ul `docker-apps`, care are deja Docker, Docker Compose, rețeaua `apps`, `cloudflare-tunnel` și `traefik-main` ([ADR 0002](adr/0002-deploy-docker-pe-vps.md)). Faptele despre el și pașii completi, în ordine, sunt în [`docs/INFRA.md`](INFRA.md) (secțiunile 1 și 4); aici e doar rezumatul. Agentul nu atinge serverul: comenzile de mai jos le rulezi tu, ca utilizator cu `sudo`.

### 4.1 Spațiu pe disc și memorie
Ai nevoie de **cel puțin 8 GB liberi**. Pe `docker-apps` erau ~54–56 GB liberi la 2026-10-27, deci pragul e îndeplinit. Memoria e punctul slab: hostul e partajat și avea doar ~1,1–2,4 GB RAM disponibili; `finet-web` e limitat la 512 MB, iar build-ul imaginii pe host cere temporar ~1,5 GB (`docs/INFRA.md`, secțiunea 3).

```bash
df -h /
free -h
```

Presiunea pe disc a produs incidente pe acest host; nu șterge nimic până nu știi ce este (agentul sau Radar propune o listă, iar tu o aprobi).

### 4.2 Directoare și fișiere de mediu
Toate datele și secretele FINET stau în **`/srv/finet/`**, în afara backup-ului de `/home` al hostului (motivul în secțiunea 7 și în `docs/INFRA.md` 4a). Nu se creează un utilizator de sistem: containerele rulează ca `node` (uid 1000).

```bash
sudo install -d -o root -g root -m 755 /srv/finet
sudo install -d -o root -g root -m 700 /srv/finet/env       # secretele, câte un fișier pe rol
sudo install -d -o root -g root -m 755 /srv/finet/compose   # compose.env (fără secrete)
sudo install -d -o root -g root -m 755 /srv/finet/ca        # certificatul CA Supabase (public)
sudo install -d -o 1000 -g 1000 -m 700 /srv/finet/storage   # fișierele aplicației (uid 1000 = node)
```

Copierea modelelor `ops/docker/*.env.example` în `/srv/finet/env/` (`finet.env`, `finet.worker.env`, `finet.migrate.env`) și în `/srv/finet/compose/compose.env` e în `docs/INFRA.md`, secțiunea 4, pasul 4. Variabilele sunt în secțiunea 10.

### 4.3 Codul pe server
Pe host nu se instalează Node sau pnpm: ele există doar în imaginea Docker (`Dockerfile`, Node 24). Ai nevoie doar de un checkout al repository-ului (nu conține secrete), recomandat tot în afara `/home`:

```bash
sudo git clone https://github.com/levinetit/FINET.git /srv/finet/src
```

### 4.4 Baza de date pe Supabase

**Creează proiectul** pe [supabase.com](https://supabase.com): **New project**, regiune **Frankfurt (eu-central-1)**, o parolă generată (o salvezi în managerul de parole). Nu folosim Supabase Auth și nici cheile `anon`/`service_role`.

**Securitate (în panoul Supabase):**
1. **Settings → Data API:** dezactivează Data API-ul. Dacă nu se poate, scoate orice altă schemă în afară de `public` din „Exposed schemas”. Tabelele FINET stau în schema `finet`, care nu trebuie să apară acolo.
2. **Settings → Database → SSL Configuration:** pornește *Enforce SSL*. Descarcă certificatul CA în `/srv/finet/ca/supabase-ca.crt` (644) pe server.
3. **Settings → Database → Network Restrictions:** permite doar IP-ul de ieșire al serverului (`curl -s https://ifconfig.me` pe server; verifică și din container, vezi `ops/supabase/README.md`). Temporar, dacă lucrezi tu din SQL Editor sau `psql`, adaugă și IP-ul tău, apoi scoate-l.

**Rolurile FINET.** Varianta recomandată e scriptul `ops/supabase/roles.sql`, rulat cu `psql` (instrucțiunile și verificările sunt în `ops/supabase/README.md`, inclusiv cum eviți trimiterea parolei în clar). Ca referință, esențialul lui e mai jos. Parolele le generezi pe server cu `openssl rand -base64 32` și le pui doar în baza de date și în fișierele de mediu ale rolurilor (`/srv/finet/env/finet.env`, `finet.worker.env` pentru `finet_app`; `finet.migrate.env` pentru `finet_migrator`):

```sql
create role finet_migrator login password '<parola-migrator>';
create role finet_app      login password '<parola-app>' nobypassrls;
create schema finet authorization finet_migrator;
grant usage on schema finet to finet_app;
revoke all on schema finet from anon, authenticated;
```

Drepturile pe tabele (`finet_app` doar pe date, fără schimbări de structură) și politicile RLS le creează migrațiile agentului.

**Conexiunile** (de la **Connect** în panoul Supabase), **câte una pe fișier de mediu**, în `/srv/finet/env/` (permisiuni `600`, `root:root`). Fiecare container primește doar URL-ul rolului său (`FINET_ROLE`, fixat în compose); un URL al altui rol în același fișier oprește pornirea:

```bash
# /srv/finet/env/finet.env (finet-web): pooler, modul tranzacție (6543)
DATABASE_URL=postgres://finet_app.<ref-proiect>:<parola-app>@<host-pooler>:6543/postgres?sslmode=verify-full
# /srv/finet/env/finet.worker.env (finet-worker, pg-boss): pooler, modul sesiune (5432)
WORKER_DATABASE_URL=postgres://finet_app.<ref-proiect>:<parola-app>@<host-pooler>:5432/postgres?sslmode=verify-full
# /srv/finet/env/finet.migrate.env (finet-migrate): pooler, modul sesiune (5432)
MIGRATOR_DATABASE_URL=postgres://finet_migrator.<ref-proiect>:<parola-migrator>@<host-pooler>:5432/postgres?sslmode=verify-full
```

Formatul exact al utilizatorului pentru pooler (cu sufixul `.<ref-proiect>`) îl vezi în panoul **Connect**.

**Certificatul CA în URL-uri:** driverul `postgres` (postgres.js) folosit de FINET **nu** acceptă în URL parametrul cu calea fișierului CA (îl trimite serverului, care refuză conexiunea; verificat pe PostgreSQL 17). De aceea URL-urile au doar `sslmode=verify-full`. CA-ul Supabase ajunge în container astfel (`docs/INFRA.md`, „Supabase din container”):
- **acum, netestat pe Supabase:** montezi `/srv/finet/ca/supabase-ca.crt` read-only în container și setezi `NODE_EXTRA_CA_CERTS` la calea din container (montarea nu e încă în compose; CA-ul se adaugă la cele publice, nu le înlocuiește);
- **planificat (Faza 1):** `ssl: { ca }` din cod, ca să fie acceptat doar CA-ul Supabase.

**Fișierele (Storage):**
1. **Storage → New bucket** `finet-documents`, **privat** (fără acces public).
2. **Settings → Storage → S3 Connection:** creează o cheie de acces S3. Cheia și secretul merg doar în `/srv/finet/env/finet.env` (`STORAGE_S3_*`, secțiunea 10). Driverul S3 e planificat pentru Faza 6; până atunci compose-ul fixează `STORAGE_DRIVER=local`. FINET servește fișierele doar prin rutele lui autorizate.

**Verificare rapidă**, de pe server, cu `psql` (pachetul `postgresql-client`). Pentru `psql`, CA-ul se dă prin variabila libpq `PGSSLROOTCERT`:

```bash
sudo sh -c 'PGSSLROOTCERT=/srv/finet/ca/supabase-ca.crt psql "$(grep ^MIGRATOR_DATABASE_URL /srv/finet/env/finet.migrate.env | cut -d= -f2-)" -c "select version();"'
```

**Versiunea PostgreSQL:** o alege Supabase. Actualizările minore le face Supabase. Upgrade-ul la o versiune majoră nouă îl pornești tu din **Settings → Infrastructure**, după procedura din `docs/INFRA.md` (backup propriu înainte, verificarea datelor după). Un job săptămânal te anunță când există o versiune nouă.

### 4.6 Fără reverse proxy propriu
FINET nu are un vhost sau un proxy local al lui. Containerul `finet-web` ascultă pe portul 3000 doar în rețeaua Docker `apps` (IP static, implicit `172.88.88.130`, de confirmat că e liber; `docs/INFRA.md`, secțiunea 4, pasul 5) și **nu publică porturi pe host**. Cererile ajung la el prin `cloudflare-tunnel` sau prin `traefik-main`, ambele existente (pasul următor).

---

## 5. Pasul 4 — Cloudflare: tunel, Access, telefoane

### 5.1 Domeniu
Domeniul tău trebuie să fie în Cloudflare (**Add a site**, apoi schimbi nameserverele la registrar). Alege subdomeniul aplicației, de exemplu `finet.<domeniu>`.

### 5.2 Intrarea: tunelul existent sau Traefik
Nu se instalează un `cloudflared` nou și nu se creează un tunel separat: pe `docker-apps` există deja containerul `cloudflare-tunnel` (gestionat din panoul Cloudflare) și `traefik-main`. Alegi una dintre variante; pașii detaliați sunt în [`ops/cloudflare/README.md`](../ops/cloudflare/README.md), iar harta de rețea în `docs/INFRA.md`, secțiunea 2.

| | **A. `cloudflare-tunnel` (recomandată)** | B. `traefik-main` |
|---|---|---|
| Ce configurezi | în tunelul existent, **Public Hostname → Add**: `finet.<domeniu>` → `HTTP` → `finet-web:3000` (numele containerului) | DNS `finet.<domeniu>` **proxied** spre IP-ul VPS-ului; în `compose.env`: `FINET_TRAEFIK_ENABLE=true`, `FINET_HOST`, resolverul confirmat din `traefik.yml` |
| Port nou pe host | niciunul | niciunul (443 e deja deschis) |
| Cerere directă la IP-ul serverului | nu ajunge la FINET | ajunge la Traefik; FINET răspunde 403 fără JWT Access (abatere de notat la acceptarea Fazei 0) |

La varianta A, **nu** seta „HTTP Host Header” la `127.0.0.1` sau `localhost` în setările rutei: ruta de liveness locală ar deveni atinsă prin tunel (`ops/cloudflare/README.md`, pasul 3).

### 5.3 Access (doar familia)
1. **Access → Applications → Add an application → Self-hosted**, domeniul `finet.<domeniu>`.
2. Politică **Allow**, regula *Emails*: adresele familiei.
3. Metodă de login: **One-time PIN** (cod pe email), plus Google, dacă vrei.
4. Notează **Application Audience (AUD) tag** și **team domain**-ul (`<echipa>.cloudflareaccess.com`). FINET le folosește ca să verifice semnătura Access (variabilele `CF_ACCESS_AUD` și `CF_ACCESS_TEAM_DOMAIN` din `/srv/finet/env/finet.env`, secțiunea 10). Politica detaliată: `ops/cloudflare/access-policy.md`.

### 5.4 Telefoanele (WARP)
1. **Settings → WARP Client → Device enrollment permissions:** aceleași emailuri ale familiei.
2. Fiecare membru instalează **Cloudflare One** din Google Play, alege *Zero Trust*, scrie numele echipei și se loghează cu emailul.
3. Cu Cloudflare One pornit, `https://finet.<domeniu>` merge din browserul telefonului și din aplicația FINET Android.

### 5.5 Verificare
- Din browser, cu un email permis: ajungi la FINET.
- Cu alt email: Access te oprește.
- `curl -I https://finet.<domeniu>` de pe un calculator fără login: redirect către Access, nu către FINET.
- Lista completă (cerere directă la IP, liveness, telefon, loguri): `ops/cloudflare/README.md`, secțiunea 6. Testează din afara rețelei de acasă: firewall-ul hostului permite mereu IP-ul de acasă.

---

## 6. Pasul 5 — Deploy cu Docker Compose

FINET rulează din imaginea Docker construită din `Dockerfile` (multi-stage, Next.js `standalone`, user `node`, healthcheck pe `/api/health/live`), cu serviciile din `ops/docker/docker-compose.yml`:
- `finet-web` (`FINET_ROLE=web`): serverul aplicației, pornit implicit;
- `finet-worker` (`FINET_ROLE=worker`, profilul `worker`): în Faza 0 un stub oprit implicit; workerul real (pg-boss) e planificat pentru Faza 5/6;
- `finet-migrate` (`FINET_ROLE=migrate`, profilul `migrate`): one-shot pentru migrații; în Faza 0 e un stub (migrațiile Drizzle vin în Faza 1).

**Ce există acum: deploy manual, făcut de tine.** Din checkout-ul de pe server (`/srv/finet/src`), după ce PR-ul a fost unit și `ci` e verde pe `main`:

```bash
cd /srv/finet/src && sudo git pull --ff-only origin main
C="sudo docker compose -f ops/docker/docker-compose.yml --env-file /srv/finet/compose/compose.env"
$C config >/dev/null                          # validează compose-ul și fișierele de mediu
$C build finet-web                            # construiește imaginea pe host (finet:local)
$C --profile migrate run --rm finet-migrate   # migrațiile, cu imaginea nouă (din Faza 1; în Faza 0 doar un mesaj)
$C up -d finet-web                            # repornește aplicația pe imaginea nouă
sudo docker ps --filter name=finet-web        # trebuie să ajungă (healthy)
sudo docker logs --tail 50 finet-web          # fără erori de configurație
```

Imaginea se construiește **pe host** (tag implicit `finet:local`, din `FINET_IMAGE`); `finet-migrate` folosește aceeași imagine, de aceea build-ul vine înaintea migrațiilor. Build-ul cere temporar ~1,5 GB RAM: fă-l când hostul are memorie liberă. Ordinea completă a primei porniri (inclusiv verificarea IP-urilor și a backup-ului) e în `docs/INFRA.md`, secțiunea 4.

**Revenire:** `$C down` oprește FINET fără să atingă `/srv/finet/` (nu există volume Docker numite). Pentru o revenire la versiunea anterioară a imaginii nu există încă un mecanism (face parte din deploy-ul automat planificat, mai jos).

**Migrațiile** trebuie să fie compatibile cu versiunea anterioară a aplicației (adăugări înaintea ștergerilor), ca revenirea să nu strice baza.

**Planificat, neimplementat:**
- construirea imaginii în GitHub Actions și publicarea ei într-un registry (CI-ul de acum doar testează și face `pnpm build`, fără imagine Docker);
- deploy-ul automat: serverul ar verifica periodic `main`, ar porni doar dacă `ci` e verde pe acel commit, ar rula migrațiile, ar reporni containerele, ar verifica `/api/health` și ar reveni singur la versiunea anterioară, cu notificare. Până atunci, deploy-ul e cel manual de mai sus.

Repository-ul e **public**. De aceea serverul **nu** rulează un GitHub runner: o cerere de modificare de la un străin ar putea încerca să ruleze cod pe el. Deploy-ul automat, când va exista, trebuie să tragă codul (sau imaginea) de pe server, nu să fie împins din GitHub. Alternativa cu runner GitHub pe server e sigură doar dacă repository-ul devine privat.

---

## 7. Pasul 6 — Backup (înainte de date reale)

**Backup-ul hostului nu acoperă FINET, intenționat.** Datele și secretele FINET stau în `/srv/finet/`, în afara backup-ului zilnic de `/home` al hostului `docker-apps` (care urcă `/home` pe Google Drive, o dată criptat și o dată **necriptat**). Până la Faza 3, `/srv/finet/storage` nu are backup (în Faza 0 nu există date reale). Detalii: `docs/INFRA.md` 4a.

> **Atenție, rămas deschis (decizia ta):** scriptul de backup necriptat al hostului face duminica și o arhivă `tar.gz` **necriptată** a întregului `/home/docker` (data-root-ul Docker). Docker copiază valorile din `env_file` în configurația containerului (`/home/docker/containers/<id>/config.v2.json`), deci arhiva conține **URL-urile bazei de date cu parolele și celelalte secrete FINET**, chiar dacă fișierele `.env` stau în `/srv/finet/env`. Variante: excluzi `/home/docker/containers` din arhivă, criptezi arhiva sau, mai târziu, treci la secrete Docker montate ca fișiere (`docs/INFRA.md` 4a, `docs/ROADMAP.md`). Rezolv-o înainte de a pune date reale.

**Backup-ul propriu FINET (planificat, Faza 3):** criptat, cu restic. Agentul îl construiește în Faza 3; tu alegi destinația și creezi depozitul **o singură dată**. Exemplu orientativ (comenzile exacte, utilizatorul și locul fișierului cu parole le stabilește Faza 3):

```bash
# exemplu cu un server SFTP; pentru un bucket S3 se folosește RESTIC_REPOSITORY=s3:...
sudo restic -r sftp:<user>@<host>:/backups/finet init
```

Backup-ul zilnic va face `pg_dump` din Supabase (cu `MIGRATOR_DATABASE_URL`), va copia fișierele (din `/srv/finet/storage` sau din bucketul Supabase, după driver) și le va pune pe amândouă în restic. E necesar chiar și cu backup-urile Supabase: pe planul gratuit nu există backup-uri descărcabile, iar o copie la tine permite mutarea pe alt PostgreSQL oricând.

- Parola restic și credențialele destinației vor sta tot în `/srv/finet/` (de exemplu `/srv/finet/env/backup.env`, `root:root 600`; de confirmat în Faza 3), nu sub `/home`. **Păstrează parola restic și în afara serverului** (de exemplu într-un manager de parole): fără ea backup-ul nu poate fi citit.
- Retenția din prompt: 7 zilnice, 4 săptămânale, 12 lunare.
- Faza 3 nu e gata până nu s-a făcut o **restaurare reală** pe o bază de test.

---

## 8. Pasul 7 — Construiește aplicația, fază cu fază

### 8.1 Cum rulezi o fază
1. Deschide **claude.ai/code** (sau Claude Code CLI) pe repository-ul `levinetit/FINET`.
2. Scrie promptul de pornire:
   > Citește `docs/FINET_MASTER_PROMPT.md` și `docs/ROADMAP.md`. Execută Faza N. Oprește-te la criteriile ei de acceptare și raportează conform secțiunii 8.
3. Agentul lucrează pe branch-ul `phase/NN-nume` și deschide un PR.
4. Tu citești raportul și PR-ul, verifici că `ci` e verde, încerci în Codespaces sau pe server, apoi unești PR-ul.
5. Faci deploy-ul pe server (pasul 5; deploy-ul automat e planificat).
6. O singură fază pe sesiune.

Pașii de pe server (instalări, Cloudflare, backup) nu se pot face dintr-o sesiune în cloud. Îi faci tu, după instrucțiunile din `docs/INFRA.md`, sau un agent care rulează pe server (de exemplu Radar), pe care îl aprobi pas cu pas.

### 8.2 Ce pregătești tu pentru fiecare fază

| Fază | Ce face agentul (pe scurt) | Ce pregătești tu înainte |
|---|---|---|
| 0 | (din sesiune Claude Code, nu din issue; vezi 8.4) Proiectul, CI, dev container, `Dockerfile` și `ops/docker/docker-compose.yml` ([ADR 0002](adr/0002-deploy-docker-pe-vps.md)), `/api/health`, conexiunea la Supabase și testul că Data API nu expune datele | Pașii 1–5 din acest ghid; canalul de alerte (token bot Telegram sau date SMTP în `/srv/finet/env/finet.env`); **începi să aduni 50–100 de bonuri și 2–3 extrase pe bancă** |
| 1 | Login, sesiuni, gospodărie, RLS, login pentru telefon (`bearer`) | `pnpm admin:create-user` pe server, pentru tine (rulat în container; comanda exactă vine cu Faza 1); apoi `admin:add-member` pentru familie |
| 2 | Conturi, tranzacții, transferuri, primele API `/api/v1`, statistici | Conturile tale reale (nume, sold inițial) |
| 3 | Dashboard, bugete, obiective, export, **backup** | Destinația backup-ului (pasul 6); un test de restaurare. **De aici poți introduce date reale.** |
| 4 | Corecturi după prima săptămână de folosire | Lista ta de probleme |
| 5 | Recurențe | Plățile tale lunare (chirie, abonamente) |
| 6 | Bonuri cu AI local, verificare, bon lung | Bonurile adunate, anonimizate, în `fixtures/receipts`; decizia privind AI extern (doar cu acordul tău) |
| 7 | Extrase, potrivire bon ↔ tranzacție | Extrase reale anonimizate în `fixtures/statements` |
| 8 | Familie, împărțiri, decontări | Emailurile familiei (și în Cloudflare Access) |
| 9 | PWA, offline, GDPR, procedura de upgrade PostgreSQL pe Supabase, statistici, pagina Android | O fereastră de câteva minute în care aplicația poate fi oprită, pentru proba de upgrade |
| 10 | Liste de cumpărături, prețuri, micro-cheltuieli | — |
| 11–12 | Doar dacă lansezi public (`saas`) | Firmă, termeni, Stripe, verificarea numelui FINET |

### 8.3 Aplicația Android
- Faza A poate începe oricând (date simulate). Faza B, după Fazele 1–2 FINET.
- Promptul de pornire: *„Citește `docs/FINET_ANDROID_MASTER_PROMPT.md`, `docs/FINET_MASTER_PROMPT.md` și `docs/ROADMAP.md`. Execută Faza Android X…”*
- APK-urile se construiesc în GitHub Actions, nu pe server (hostul `docker-apps` e partajat și are puțină memorie liberă).

---

### 8.4 Automatizat din GitHub: issue → agent → PR

În loc să pornești fiecare fază dintr-o sesiune Claude Code, o poți porni dintr-un issue. Agentul rulează în GitHub Actions (workflow-ul `.github/workflows/claude-faza.yml`).

**Configurare (o singură dată):**
1. Instalează aplicația GitHub **Claude** pe repository: [github.com/apps/claude](https://github.com/apps/claude) → *Install* → doar `levinetit/FINET`. Alternativ, din Claude Code CLI: `/install-github-app`.
2. Autentificarea, una dintre variante:
   - **abonamentul Claude:** pe calculatorul tău sau într-un Codespace rulezi `claude setup-token` și pui tokenul afișat în secretul `CLAUDE_CODE_OAUTH_TOKEN`;
   - **cheie API:** creezi o cheie în [console.anthropic.com](https://console.anthropic.com) și o pui în secretul `ANTHROPIC_API_KEY`. Plătești per utilizare, deci setează o limită lunară de cheltuieli în consolă.
3. Variabile (Settings → Secrets and variables → Actions → *Variables*):
   - `CLAUDE_MODEL`, opțional (implicit `claude-opus-5-5`; pentru cost mai mic, `claude-sonnet-5-5`);
   - `CLAUDE_MAX_TURNS`, opțional (implicit `300`);
   - `POSTGRES_MAJOR`, versiunea majoră a proiectului Supabase (de exemplu `17`), ca testele agentului să ruleze pe aceeași versiune.
4. Eticheta `faza` trebuie să existe (Issues → Labels → New label `faza`).

**Folosire, pentru fiecare fază:**
1. **Issues → New issue → „Fază FINET”**, alegi faza din listă și completezi, dacă e cazul, materialele sau deciziile. Fără parole.
2. La creare, eticheta `faza` pornește agentul. Progresul apare într-un comentariu în issue și în fila **Actions**.
3. Agentul lucrează pe un branch `phase/...`, rulează testele și deschide un PR cu raportul.
4. Pentru corecturi scrii în PR sau în issue un comentariu care începe cu `@claude` (de exemplu „@claude testul X pică, corectează”).
5. Verifici raportul și testele, apoi apeși **Merge** și faci deploy-ul pe server (pasul 5).

**Limite și siguranță:**
- Agentul poate fi pornit doar de utilizatori cu drept de scriere în repository. Pe un repository public, doar comentariile tale ajung la agent (`include_comments_by_actor`).
- Rulează o singură fază odată; o rulare nouă așteaptă terminarea celei curente. O rulare durează cel mult 3 ore.
- Agentul are acces doar la repository și la o bază PostgreSQL de test, creată pentru fiecare rulare. **Nu** are acces la server, la Supabase, la Cloudflare sau la secretele aplicației. Pașii de acolo îi scrie ca instrucțiuni pentru tine în `docs/INFRA.md`.
- **Faza 0** creează workflow-urile GitHub (acum: `ci.yml` și `claude-faza.yml`; build-ul imaginii, deploy-ul și APK-ul sunt planificate). Modificarea fișierelor din `.github/workflows/` cere o permisiune specială pe care tokenul agentului din Actions poate să nu o aibă. Rulează Faza 0 dintr-o sesiune Claude Code (claude.ai/code sau CLI), iar fazele următoare din issue-uri. Dacă o fază ulterioară trebuie să modifice un workflow și nu poate, agentul scrie modificarea în PR ca instrucțiune, iar tu o aplici.
- Merge-ul rămâne la tine. Nu activa unirea automată a PR-urilor agentului.

## 9. Pasul 8 — Publicarea APK-ului

O singură dată, pe calculatorul tău sau într-un Codespace (nu pe server):

```bash
keytool -genkeypair -v -keystore finet-upload.jks -alias finet \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 finet-upload.jks > finet-upload.jks.b64
```

- Pui conținutul `.b64` și parolele în GitHub Secrets (secțiunea 10), apoi **ștergi** fișierele din Codespace.
- Păstrezi `finet-upload.jks` și parolele într-un loc sigur, cu backup. Fără cheie nu mai poți publica actualizări peste aplicația instalată.

Publicarea unei versiuni:

```bash
git tag FINET-v1.0.0
git push origin FINET-v1.0.0
```

Workflow-ul construiește APK-ul semnat și îl pune pe `https://github.com/levinetit/FINET/releases`, cu suma SHA-256.

---

## 10. Toate secretele și variabilele

### 10.1 Pe server: `/srv/finet/env/` (trei fișiere, câte unul pe rol, `root:root`, permisiuni `600`)

Fiecare serviciu din `ops/docker/docker-compose.yml` primește prin `env_file` **doar** fișierul rolului său, iar compose-ul îi fixează `FINET_ROLE`. Validarea e în `src/lib/config.ts`; modelele, cu valori fictive, sunt `ops/docker/finet.env.example`, `finet.worker.env.example` și `finet.migrate.env.example` (verificate de `pnpm test:ops`).

| Fișier | Serviciu | `FINET_ROLE` | Singurul URL de bază de date permis |
|---|---|---|---|
| `finet.env` | `finet-web` | `web` | `DATABASE_URL` |
| `finet.worker.env` | `finet-worker` | `worker` | `WORKER_DATABASE_URL` |
| `finet.migrate.env` | `finet-migrate` | `migrate` | `MIGRATOR_DATABASE_URL` |

URL-ul altui rol prezent în fișier **oprește pornirea** (mesajul numește variabila, nu valoarea).

**Fixate de compose, nu le pui în fișiere** (`environment:` are prioritate): `FINET_ROLE`, `NODE_ENV=production`, `APP_MODE=personal`, `CF_ACCESS_REQUIRED=true` (web), `STORAGE_DRIVER=local`, `STORAGE_DIR=/data/storage` (web, worker; montat din `/srv/finet/storage`), `HOSTNAME`, `PORT=3000`, `NODE_OPTIONS`.

| Variabilă | Fișier | Exemplu / sursă | Fază |
|---|---|---|---|
| `APP_URL` | `finet.env` | `https://finet.<domeniu>` | 0 |
| `NEXT_PUBLIC_APP_NAME` | `finet.env` | `FINET` | 0 |
| `DATABASE_URL` | `finet.env` | Supabase, pooler modul tranzacție (6543), rol `finet_app`, doar `sslmode=verify-full` (pasul 4.4) | 0 |
| `WORKER_DATABASE_URL` | `finet.worker.env` | Supabase, pooler modul sesiune (5432), rol `finet_app` | 0 (folosit din Faza 5/6) |
| `MIGRATOR_DATABASE_URL` | `finet.migrate.env` | Supabase, pooler modul sesiune (5432), rol `finet_migrator` | 0 (folosit din Faza 1) |
| `STORAGE_QUOTA_MB` | `finet.env`, `finet.worker.env` | de exemplu `5000` | 0 |
| `CF_ACCESS_TEAM_DOMAIN` | `finet.env` | `<echipa>.cloudflareaccess.com`, fără `https://` | 0 |
| `CF_ACCESS_AUD` | `finet.env` | AUD tag-ul aplicației Access | 0 |
| `HEALTH_TOKEN` | `finet.env` | opțional, minimum 32 de caractere (`openssl rand -hex 32`); `/api/health` detaliat din rețeaua `apps`, cu antetul `X-Finet-Health-Token` | 0 |
| `NOTIFY_TELEGRAM_BOT_TOKEN` + `NOTIFY_TELEGRAM_CHAT_ID`, sau `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` + `NOTIFY_EMAIL_TO` | `finet.env` | canalul de alerte (`ops/notify/notify.sh`); Telegram cere ambele variabile, `SMTP_HOST` cere `SMTP_FROM` | 0 |
| `AI_DAILY_DOCUMENT_LIMIT`, `AI_MONTHLY_BUDGET`, `AI_MONTHLY_BUDGET_CURRENCY` | `finet.env`, `finet.worker.env` | limite tehnice (implicit `50`, `0`, `USD`) | 0 (folosite din Faza 6) |
| `NODE_EXTRA_CA_CERTS` | fiecare fișier al unui serviciu care se conectează la bază | calea CA-ului Supabase în container; **netestat**, cere și montarea fișierului (pasul 4.4) | 0 |
| `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | `finet.env` | din Supabase → Storage → S3 Connection; driverul S3 e **planificat** (compose-ul fixează acum `STORAGE_DRIVER=local`) | 6 |
| `BETTER_AUTH_SECRET` | `finet.env` | `openssl rand -base64 32` (**planificat**) | 1 |
| `SMTP_*` pentru login | `finet.env` | opțional în `personal` (magic link, resetare parolă; **planificat**) | 1 |
| `LITELLM_BASE_URL`, `AI_LOCAL_MODEL` | de stabilit | pe host există `litellm-apps` pe rețeaua `apps` (de evaluat); **planificat**, numele se confirmă în faza respectivă | 6 |
| `AI_EXTERNAL_*` | de stabilit | doar dacă accepți AI extern (**planificat**) | 6 |
| `RECEIPT_IMAGE_RETENTION_DAYS` | de stabilit | de exemplu `365` (**planificat**) | 6 |

Separat, `/srv/finet/compose/compose.env` (model `ops/docker/compose.env.example`, fără secrete) are variabilele de interpolare ale compose-ului: `FINET_HOST`, `FINET_IMAGE`, `FINET_ENV_DIR`, `FINET_DATA_DIR`, `FINET_WEB_IP`, `FINET_WORKER_IP`, `FINET_TRAEFIK_ENABLE`, `FINET_CERTRESOLVER`.

### 10.2 Pe server: secretele backup-ului (planificat, Faza 3)
`RESTIC_REPOSITORY`, `RESTIC_PASSWORD` și credențialele destinației, într-un fișier sub `/srv/finet/` (locul exact se stabilește în Faza 3; vezi pasul 6).

### 10.3 În GitHub (Settings → Secrets and variables → Actions)

| Nume | Tip | Pentru |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | secret | semnarea APK |
| `ANDROID_KEYSTORE_PASSWORD` | secret | semnarea APK |
| `ANDROID_KEY_ALIAS` | secret | semnarea APK |
| `ANDROID_KEY_PASSWORD` | secret | semnarea APK |
| `ANDROID_CERT_SHA256` | variabilă | verificarea certificatului după build |
| `API_BASE_URL` | variabilă (mediul `production`) | `https://finet.<domeniu>` |
| `CLAUDE_CODE_OAUTH_TOKEN` sau `ANTHROPIC_API_KEY` | secret | agentul din GitHub Actions (8.4) |
| `CLAUDE_MODEL`, `CLAUDE_MAX_TURNS` | variabile, opționale | agentul din GitHub Actions (8.4) |
| `POSTGRES_MAJOR` | variabilă | versiunea PostgreSQL a proiectului Supabase, pentru testele agentului |

CI-ul aplicației web nu are nevoie de secrete: folosește o bază PostgreSQL temporară, creată pentru fiecare rulare.

---

## 11. Verificări rapide

| Verificare | Comandă / loc |
|---|---|
| Aplicația merge | `sudo docker ps --filter name=finet-web` arată `(healthy)`; `https://finet.<domeniu>` după login Access; `/api/health` detaliat din rețeaua `apps` cu `HEALTH_TOKEN` (`docs/INFRA.md`, „Liveness și monitorizare”) |
| Serviciile | `sudo docker ps -a --filter name=finet`; `sudo docker logs --tail 50 finet-web`; tunelul: `sudo docker ps --filter name=cloudflare-tunnel` |
| Ultimul deploy | `sudo docker inspect finet-web --format '{{.Created}} {{.Image}}'`; `sudo git -C /srv/finet/src log -1 --oneline` |
| Baza de date | `psql` cu `PGSSLROOTCERT` (pasul 4.4) sau panoul Supabase |
| Data API nu expune datele | în panou, schema `finet` nu apare la „Exposed schemas”; testul automat vine cu primul tabel (Faza 1) |
| Acces la bază doar de pe server | Supabase → Network Restrictions conține doar IP-ul serverului |
| Niciun port public pentru FINET | `sudo docker port finet-web` nu afișează nimic |
| Backup | planificat (Faza 3); până atunci, `sudo rclone ls Gdrive:vpnde/home \| grep -i finet` și `sudo rclone ls GdriveCrypt:home \| grep -i finet` nu afișează nimic (`docs/INFRA.md` 4a) |
| Teste | fila **Actions** din GitHub |
| Progres | `docs/ROADMAP.md` |

## 12. Dacă ceva nu merge

- **CI roșu:** deschide rularea din fila Actions și dă eroarea agentului în aceeași sesiune; nu uni PR-ul.
- **Deploy-ul nu merge:** citește ieșirea `docker compose ... build` (de obicei memorie insuficientă pe host) și `sudo docker logs finet-web` (de obicei o variabilă de mediu lipsă sau URL-ul altui rol în fișier; mesajul numește variabila). Dacă build-ul pică, containerul vechi rămâne pornit.
- **Nu ajungi la aplicație din afară:** verifică tunelul în panoul Cloudflare (*Healthy*), `sudo docker logs --tail 50 cloudflare-tunnel` (varianta A) sau `sudo docker logs traefik-main 2>&1 | grep -i finet` (varianta B), și că `finet-web` e `healthy`.
- **Telefonul nu se conectează:** Cloudflare One pornit și înrolat cu un email permis.
- **Disc plin:** `df -h /`; pe acest host, discul plin strică simultan mai multe servicii, deci verifică-l primul. Alerta automată de disc e planificată.
- **Aplicația nu se conectează la bază:** proiectul Supabase poate fi suspendat (plan gratuit, după o perioadă fără activitate): îl repornești din panoul Supabase. Verifică și dacă IP-ul serverului s-a schimbat (Network Restrictions) și dacă URL-ul nu conține parametri pe care driverul nu îi acceptă (doar `sslmode=verify-full`, pasul 4.4).
- **Revenire manuală la versiunea anterioară:** nu există încă un mecanism (pasul 5). Oprirea completă: `docker compose ... down` (`docs/INFRA.md`, secțiunea 4).
