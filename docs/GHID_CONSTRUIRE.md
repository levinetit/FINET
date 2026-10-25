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
                                 │ serverul trage singur codul nou din main
                                 │ (nicio conexiune de intrare)
┌──────────── Server LXC (Debian, fără Docker) ────────────┐
│ finet-web (Next.js) · finet-worker (pg-boss)             │
│ nginx pe 127.0.0.1 · Ollama/LiteLLM · restic (backup)    │──── TLS ────▶ Supabase (UE)
│ cloudflared ──────────────┐                              │              PostgreSQL (schema finet)
└───────────────────────────┼──────────────────────────────┘              Storage (bucket privat)
                            ▼
        Cloudflare Tunnel + Access (doar emailurile familiei)
                            ▲
      browser (login Access)  ·  telefon (Cloudflare One / WARP + FINET Android)
```

Principii:
- **GitHub** e locul unde se scrie, se testează și se construiește totul.
- **Serverul** rulează aplicația și workerul. Codul nou și-l ia singur din GitHub, numai după ce testele au trecut.
- **Supabase** păstrează baza de date PostgreSQL și fișierele (pozele bonurilor, extrasele). Doar serverul FINET vorbește cu Supabase; browserul și telefonul nu.
- **Niciun port deschis** pe server: intrarea se face doar prin Cloudflare Tunnel.

---

## 1. Ce îți trebuie

| Ce | De ce | Cost |
|---|---|---|
| Cont GitHub (ai deja `levinetit`) | cod, teste, Codespaces, Releases | gratuit pentru repository public; Codespaces are o cotă lunară gratuită |
| Acces la Claude Code (claude.ai/code sau CLI) | agentul care scrie codul pe faze | abonamentul tău Claude |
| Serverul LXC (Debian) cu acces `sudo` | rulează FINET | existent |
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

Rezultatul: nimic nu ajunge în `main` fără PR și fără teste verzi, deci serverul nu primește niciodată cod netestat.

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

Codespaces deschide automat linkul aplicației. Containerul există doar pentru dezvoltare. Serverul de producție rămâne fără Docker, ca în prompt.

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

Faza 0 începe cu agentul **verificând** serverul și propunând planul. Comenzile de mai jos sunt cele pe care le rulezi tu sau pe care le aprobi. Rulează-le ca utilizator cu `sudo`.

### 4.1 Spațiu pe disc
Ai nevoie de **cel puțin 8 GB liberi** (mai mult dacă vrei modele AI locale mari).

```bash
df -h /
sudo du -xh / --max-depth=2 2>/dev/null | sort -h | tail -20   # ce ocupă spațiul
```

Nu șterge nimic până nu știi ce este; agentul (sau Radar) propune o listă, iar tu o aprobi.

### 4.2 Utilizator și directoare

```bash
sudo adduser --system --group --home /opt/finet finet
sudo mkdir -p /opt/finet/releases /var/lib/finet/storage /etc/finet
sudo chown -R finet:finet /opt/finet /var/lib/finet
sudo chmod 750 /etc/finet
```

### 4.3 Node 24 și pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo corepack enable    # pnpm vine în versiunea fixată în package.json
node -v
```

### 4.4 Baza de date pe Supabase

**Creează proiectul** pe [supabase.com](https://supabase.com): **New project**, regiune **Frankfurt (eu-central-1)**, o parolă generată (o salvezi în managerul de parole). Nu folosim Supabase Auth și nici cheile `anon`/`service_role`.

**Securitate (în panoul Supabase):**
1. **Settings → Data API:** dezactivează Data API-ul. Dacă nu se poate, scoate orice altă schemă în afară de `public` din „Exposed schemas”. Tabelele FINET stau în schema `finet`, care nu trebuie să apară acolo.
2. **Settings → Database → SSL Configuration:** pornește *Enforce SSL*. Descarcă certificatul CA în `/etc/finet/supabase-ca.crt` pe server.
3. **Settings → Database → Network Restrictions:** permite doar IP-ul de ieșire al serverului (`curl -s https://ifconfig.me` pe server). Temporar, dacă lucrezi tu din SQL Editor sau `psql`, adaugă și IP-ul tău, apoi scoate-l.

**Rolurile FINET** (în **SQL Editor**). Parolele le generezi pe server cu `openssl rand -base64 32` și le lipești doar aici și în `/etc/finet/finet.env`:

```sql
create role finet_migrator login password '<parola-migrator>';
create role finet_app      login password '<parola-app>' nobypassrls;
create schema finet authorization finet_migrator;
grant usage on schema finet to finet_app;
revoke all on schema finet from anon, authenticated;
```

Drepturile pe tabele (`finet_app` doar pe date, fără schimbări de structură) și politicile RLS le creează migrațiile agentului.

**Conexiunile** (de la **Connect** în panoul Supabase), în `/etc/finet/finet.env` (permisiuni `640`, `root:finet`):

```bash
# aplicația: pooler, modul tranzacție (6543)
DATABASE_URL=postgres://finet_app.<ref-proiect>:<parola-app>@<host-pooler>:6543/postgres?sslmode=verify-full&sslrootcert=/etc/finet/supabase-ca.crt
# worker (pg-boss) și migrații: pooler, modul sesiune (5432)
WORKER_DATABASE_URL=postgres://finet_app.<ref-proiect>:<parola-app>@<host-pooler>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/finet/supabase-ca.crt
MIGRATOR_DATABASE_URL=postgres://finet_migrator.<ref-proiect>:<parola-migrator>@<host-pooler>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/finet/supabase-ca.crt
```

Formatul exact al utilizatorului pentru pooler (cu sufixul `.<ref-proiect>`) îl vezi în panoul **Connect**.

**Fișierele (Storage):**
1. **Storage → New bucket** `finet-documents`, **privat** (fără acces public).
2. **Settings → Storage → S3 Connection:** creează o cheie de acces S3. Cheia și secretul merg doar în `/etc/finet/finet.env` (`STORAGE_S3_*`, secțiunea 10). FINET servește fișierele doar prin rutele lui autorizate.

**Verificare rapidă**, de pe server:

```bash
sudo apt-get install -y postgresql-client
psql "$(sudo grep ^MIGRATOR_DATABASE_URL /etc/finet/finet.env | cut -d= -f2-)" -c "select version();"
```

**Versiunea PostgreSQL:** o alege Supabase. Actualizările minore le face Supabase. Upgrade-ul la o versiune majoră nouă îl pornești tu din **Settings → Infrastructure**, după procedura din `docs/INFRA.md` (backup propriu înainte, verificarea datelor după). Un job săptămânal te anunță când există o versiune nouă.

### 4.6 nginx doar local
nginx există deja. Pentru FINET, agentul creează în Faza 0 un vhost care ascultă **doar pe `127.0.0.1`** și trimite cererile către aplicația Next.js. Intrarea din afară se face exclusiv prin Cloudflare (pasul următor).

---

## 5. Pasul 4 — Cloudflare: tunel, Access, telefoane

### 5.1 Domeniu
Domeniul tău trebuie să fie în Cloudflare (**Add a site**, apoi schimbi nameserverele la registrar). Alege subdomeniul aplicației, de exemplu `finet.<domeniu>`.

### 5.2 Tunel (fără porturi deschise)
1. **Cloudflare One (Zero Trust) → Networks → Tunnels → Create a tunnel** → tip *Cloudflared* → nume `finet`.
2. Pe server instalezi `cloudflared` din repository-ul Cloudflare:
   ```bash
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared
   ```
3. Rulezi comanda `sudo cloudflared service install <TOKEN>` afișată în panou. **Tokenul e secret**: îl lipești doar în terminalul serverului.
4. În tunel, la **Public Hostname**: `finet.<domeniu>` → `http://127.0.0.1:80`.

### 5.3 Access (doar familia)
1. **Access → Applications → Add an application → Self-hosted**, domeniul `finet.<domeniu>`.
2. Politică **Allow**, regula *Emails*: adresele familiei.
3. Metodă de login: **One-time PIN** (cod pe email), plus Google, dacă vrei.
4. Notează **Application Audience (AUD) tag** și **team domain**-ul (`<echipa>.cloudflareaccess.com`). FINET le folosește ca să verifice semnătura Access (variabilele `CF_ACCESS_AUD` și `CF_ACCESS_TEAM_DOMAIN`, secțiunea 10).

### 5.4 Telefoanele (WARP)
1. **Settings → WARP Client → Device enrollment permissions:** aceleași emailuri ale familiei.
2. Fiecare membru instalează **Cloudflare One** din Google Play, alege *Zero Trust*, scrie numele echipei și se loghează cu emailul.
3. Cu Cloudflare One pornit, `https://finet.<domeniu>` merge din browserul telefonului și din aplicația FINET Android.

### 5.5 Verificare
- Din browser, cu un email permis: ajungi la FINET.
- Cu alt email: Access te oprește.
- `curl -I https://finet.<domeniu>` de pe un calculator fără login: redirect către Access, nu către FINET.

---

## 6. Pasul 5 — Deploy automat din GitHub (serverul trage codul)

Repository-ul e **public**. De aceea serverul **nu** rulează un GitHub runner: o cerere de modificare de la un străin ar putea încerca să ruleze cod pe el. În schimb, serverul **trage** singur codul, doar din `main` și doar dacă testele au trecut.

Ce construiește agentul în Faza 0 (`ops/deploy/`):
- **`finet-deploy.timer`** (systemd), la fiecare 2 minute, rulează `ops/deploy/pull-deploy.sh` ca utilizatorul `finet`:
  1. `git fetch` din `main`, cu o **deploy key** doar pentru citire (sau fără cheie, repository-ul fiind public).
  2. Dacă există un commit nou, verifică prin API-ul GitHub că verificarea `ci` a acelui commit e **verde**. Altfel nu face nimic.
  3. Construiește într-un director nou: `/opt/finet/releases/<commit>`, apoi `pnpm install --frozen-lockfile` și `pnpm build`.
  4. Rulează migrațiile cu `MIGRATOR_DATABASE_URL`.
  5. Mută legătura `/opt/finet/current` pe versiunea nouă și repornește `finet-web` și `finet-worker`.
  6. Verifică `/api/health`. Dacă nu e verde în 2 minute, **revine** la versiunea anterioară și trimite o notificare.
  7. Păstrează ultimele 3 versiuni, ca să poți reveni manual.
- **Migrațiile** trebuie să fie compatibile cu versiunea anterioară a aplicației (adăugări înaintea ștergerilor), ca revenirea să nu strice baza.

Alternativa cu runner GitHub pe server e sigură doar dacă repository-ul devine privat. Nu o folosi pe un repository public.

---

## 7. Pasul 6 — Backup (înainte de date reale)

Agentul construiește backup-ul în Faza 3. Tu alegi destinația și creezi depozitul **o singură dată**:

```bash
sudo apt-get install -y restic postgresql-client
# exemplu cu un server SFTP; pentru un bucket S3 se folosește RESTIC_REPOSITORY=s3:...
sudo -u finet restic -r sftp:<user>@<host>:/backups/finet init
```

Backup-ul zilnic face `pg_dump` din Supabase (cu `MIGRATOR_DATABASE_URL`), copiază fișierele din bucketul Supabase și le pune pe amândouă în restic. E necesar chiar și cu backup-urile Supabase: pe planul gratuit nu există backup-uri descărcabile, iar o copie la tine permite mutarea pe alt PostgreSQL oricând.

- Parola restic și credențialele destinației merg în `/etc/finet/backup.env` (permisiuni `640`, `root:finet`). **Păstrează parola restic și în afara serverului** (de exemplu într-un manager de parole): fără ea backup-ul nu poate fi citit.
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
5. Serverul preia singur versiunea nouă (pasul 5).
6. O singură fază pe sesiune.

Pașii de pe server (instalări, Cloudflare, backup) nu se pot face dintr-o sesiune în cloud. Îi faci tu, după instrucțiunile din `docs/INFRA.md`, sau un agent care rulează pe server (de exemplu Radar), pe care îl aprobi pas cu pas.

### 8.2 Ce pregătești tu pentru fiecare fază

| Fază | Ce face agentul (pe scurt) | Ce pregătești tu înainte |
|---|---|---|
| 0 | Proiectul, CI, dev container, deploy prin tragere, vhost nginx, `/api/health`, conexiunea la Supabase și testul că Data API nu expune datele | Pașii 1–5 din acest ghid; canalul de alerte (token bot Telegram sau date SMTP în `/etc/finet/finet.env`); **începi să aduni 50–100 de bonuri și 2–3 extrase pe bancă** |
| 1 | Login, sesiuni, gospodărie, RLS, login pentru telefon (`bearer`) | `pnpm admin:create-user` pe server, pentru tine; apoi `admin:add-member` pentru familie |
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
- APK-urile se construiesc în GitHub Actions; serverul LXC nu are spațiu pentru Android SDK.

---

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

### 10.1 Pe server: `/etc/finet/finet.env` (permisiuni `640`, `root:finet`)

| Variabilă | Exemplu / sursă | Fază |
|---|---|---|
| `APP_MODE` | `personal` | 0 |
| `APP_URL` | `https://finet.<domeniu>` | 0 |
| `NEXT_PUBLIC_APP_NAME` | `FINET` | 0 |
| `DATABASE_URL` | Supabase, pooler modul tranzacție, rol `finet_app` (pasul 4.4) | 0 |
| `WORKER_DATABASE_URL` | Supabase, pooler modul sesiune, rol `finet_app` | 0 |
| `MIGRATOR_DATABASE_URL` | Supabase, pooler modul sesiune, rol `finet_migrator` | 0 |
| `STORAGE_DRIVER` | `s3` (Supabase Storage) sau `local` | 0 |
| `STORAGE_S3_ENDPOINT`, `STORAGE_S3_REGION`, `STORAGE_S3_BUCKET`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | din Supabase → Storage → S3 Connection | 0 |
| `STORAGE_DIR` | `/var/lib/finet/storage` (doar cu `STORAGE_DRIVER=local`; și pentru fișierele temporare) | 0 |
| `STORAGE_QUOTA_MB` | de exemplu `5000` | 0 |
| `CF_ACCESS_TEAM_DOMAIN` | `<echipa>.cloudflareaccess.com` | 0 |
| `CF_ACCESS_AUD` | AUD tag-ul aplicației Access | 0 |
| `NOTIFY_TELEGRAM_BOT_TOKEN`, `NOTIFY_TELEGRAM_CHAT_ID` sau `SMTP_*` | canalul de alerte | 0 |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` | 1 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | opțional în `personal` (magic link, resetare parolă) | 1 |
| `LITELLM_BASE_URL`, `AI_LOCAL_MODEL` | `http://127.0.0.1:<port>`, modelul ales după evaluare | 6 |
| `AI_DAILY_DOCUMENT_LIMIT`, `AI_MONTHLY_BUDGET` | limite tehnice | 6 |
| `AI_EXTERNAL_*` | doar dacă accepți AI extern | 6 |
| `RECEIPT_IMAGE_RETENTION_DAYS` | de exemplu `365` | 6 |

### 10.2 Pe server: `/etc/finet/backup.env`
`RESTIC_REPOSITORY`, `RESTIC_PASSWORD` și credențialele destinației (Faza 3).

### 10.3 În GitHub (Settings → Secrets and variables → Actions)

| Nume | Tip | Pentru |
|---|---|---|
| `ANDROID_KEYSTORE_BASE64` | secret | semnarea APK |
| `ANDROID_KEYSTORE_PASSWORD` | secret | semnarea APK |
| `ANDROID_KEY_ALIAS` | secret | semnarea APK |
| `ANDROID_KEY_PASSWORD` | secret | semnarea APK |
| `ANDROID_CERT_SHA256` | variabilă | verificarea certificatului după build |
| `API_BASE_URL` | variabilă (mediul `production`) | `https://finet.<domeniu>` |

CI-ul aplicației web nu are nevoie de secrete: folosește o bază PostgreSQL temporară, creată pentru fiecare rulare.

---

## 11. Verificări rapide

| Verificare | Comandă / loc |
|---|---|
| Aplicația merge | `curl -s http://127.0.0.1:3000/api/health` pe server; `https://finet.<domeniu>` după login Access |
| Serviciile | `systemctl status finet-web finet-worker cloudflared postgresql` |
| Ultimul deploy | `journalctl -u finet-deploy.service -n 50` |
| Baza de date | `psql "$MIGRATOR_DATABASE_URL" -c "select version();"` sau panoul Supabase |
| Data API nu expune datele | testul automat din Faza 0; în panou, schema `finet` nu apare la „Exposed schemas” |
| Acces la bază doar de pe server | Supabase → Network Restrictions conține doar IP-ul serverului |
| Niciun port public | `sudo ss -ltnp` nu arată servicii pe `0.0.0.0` în afară de cele știute |
| Backup | `sudo -u finet restic snapshots` |
| Teste | fila **Actions** din GitHub |
| Progres | `docs/ROADMAP.md` |

## 12. Dacă ceva nu merge

- **CI roșu:** deschide rularea din fila Actions și dă eroarea agentului în aceeași sesiune; nu uni PR-ul.
- **Deploy-ul nu se face:** `journalctl -u finet-deploy.service`; de obicei commitul nu are încă `ci` verde sau build-ul a picat (serverul rămâne pe versiunea anterioară).
- **Nu ajungi la aplicație din afară:** verifică tunelul în panoul Cloudflare (*Healthy*) și `systemctl status cloudflared`.
- **Telefonul nu se conectează:** Cloudflare One pornit și înrolat cu un email permis.
- **Disc plin:** `df -h`; backup-ul se oprește singur și trimite alertă.
- **Aplicația nu se conectează la bază:** proiectul Supabase poate fi suspendat (plan gratuit, după o perioadă fără activitate): îl repornești din panoul Supabase. Verifică și dacă IP-ul serverului s-a schimbat (Network Restrictions).
- **Revenire manuală la versiunea anterioară:** mută `/opt/finet/current` pe directorul anterior din `/opt/finet/releases/` și repornește serviciile; procedura exactă o scrie agentul în `docs/INFRA.md`.
