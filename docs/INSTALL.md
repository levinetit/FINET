# FINET — instalare pe un server nou (installer interactiv)

Installer-ul `ops/install/finet-install.sh` automatizează procedura manuală din [`docs/INFRA.md`](INFRA.md) (§3 deploy Docker, §4 pașii operatorului, §6 acceptare), [`ops/supabase/README.md`](../ops/supabase/README.md), [`ops/cloudflare/README.md`](../ops/cloudflare/README.md) și [`docs/BACKUP.md`](BACKUP.md). Decizia: [ADR 0044](adr/0044-installer-wizard.md).

**Stare:** testat în CI cu stub-uri (Docker, git, rețea și rsync simulate, într-un container Debian efemer). **Nerulat pe un server gol și pe un Supabase/Cloudflare reale**: prima instalare reală trebuie făcută cu `--check` întâi și urmărită de operator.

## Cerințe

| Ce | Minim |
|---|---|
| OS | Linux, testat Debian/Ubuntu |
| Docker Engine + Compose v2 | Engine ≥ 24; Compose ≥ 2.24 (`env_file` cu `required:` din `docker-compose.yml`) |
| RAM / disc | ≥ 1 GB RAM (`finet-web` 512 MB, worker 768 MB); ≥ 8 GB liberi la `/srv/finet` |
| Comenzi | `curl`, `git`, `openssl`, `python3`, `tar`, `sha256sum`, `awk`, `sed`, `find`; `rsync` și `ssh` la mutare |
| Acces de ieșire | `github.com`, `api.github.com`, gazda și porturile Supabase (6543 și 5432), `AI_BASE_URL` dacă AI e activ |
| Supabase | proiect creat, `roles.sql` rulat, Network Restrictions pe IP-ul serverului (vezi mai jos), CA-ul descărcat |
| Token GitHub | cu `Actions: read` (descărcarea artefactelor CI cere autentificare chiar și pe repo public) |
| Cloudflare | tunel (sau Traefik) și aplicație Access; fără chei API: pașii rămân manuali |

## Rulare

Varianta recomandată: `git clone` și rulare din checkout, ca să poți citi scriptul înainte să-l rulezi.

```bash
git clone https://github.com/levinetit/FINET.git
cd FINET
sudo sh ops/install/finet-install.sh --check     # întâi: arată ce ar face, nu scrie nimic
sudo sh ops/install/finet-install.sh             # apoi: wizard-ul real
```

`curl -fsSL .../finet-install.sh | sudo sh` **nu e recomandat**: ai rula ca root un script pe care nu l-ai citit, iar wizard-ul are nevoie de terminal interactiv și de restul repo-ului (modele `.example`, `docker-compose.yml`).

Scriptul e POSIX `sh` (pe Debian `sudo sh` este `dash`, de aceea nu există `read -s`; valorile secrete se citesc cu `stty -echo` din `/dev/tty`). Folosește `whiptail` sau `dialog` dacă există și un terminal, altfel prompturi text.

Opțiuni: `--check` / `--dry-run`, `--answers FIȘIER`, `--mode new|move|check`, `--log FIȘIER`, `--no-tui`, `--help`.

## Ce face, pas cu pas (instalare nouă)

1. **Bun venit și alegerea modului** (1 nouă, 2 mutare, 3 doar verificare).
2. **Precondiții sistem** (oprire cu mesaj clar): OS, root, comenzi, Docker Engine, Compose v2.24+, RAM, disc.
3. **Întrebări numerotate**, cu implicite: hostname, rețea Docker (nume, subnet, IP-urile `finet-web` și `finet-worker`), intrarea (tunel nou cu `cloudflared`, tunel existent, Traefik sau niciuna), `CF_ACCESS_*`, AI (opțional), Supabase (URL-urile, CA), primul utilizator, imaginile (SHA, token GitHub), backup, cron.
4. **Verificări de rețea:** GitHub, Supabase (host:port din URL-uri), `AI_BASE_URL`; **afișează IP-ul public de ieșire** ca să-l adaugi în Supabase → Network Restrictions; verifică IP-urile libere pe rețea (inclusiv containere oprite cu IP static) și suprapunerea subnetului cu alte rețele Docker.
5. **Rezumat** și confirmarea `Aplic? [da/NU]` (implicit nu).
6. **Aplicarea:**
   - directoarele din INFRA §4 (`/srv/finet/{env,secrets,compose,ca,storage,backup-state}`, permisiuni exacte);
   - checkout root-owned în `/srv/finet/src`, la același SHA ca imaginile (condiția LOW-1 a `run-backup.sh`);
   - fișierele env din modelele `.example` (doar chei nesecrete) și `compose.env`;
   - secretele ca fișiere `1000:1000` mod `400`: URL-urile bazei (citite ascuns), URL-ul workerului derivat din cel al aplicației (același rol, portul 5432), tokenul de sănătate și secretul Better Auth (generate de `openssl` direct în fișier), cheile AI (dacă sunt), CA-ul Supabase (`root 644`);
   - rețeaua Docker (creată doar dacă lipsește);
   - imaginile `web`, `tools`, `backup` prin `ops/deploy/pull-images.sh <sha> all` (artefactele CI; **fără build local**);
   - testul de conexiune la bază cu `sslmode=verify-full`, din imaginea `tools` (cu CA-ul montat), pentru `finet_database_url` și `finet_migrate_database_url`; compară IP-ul de ieșire al containerelor cu cel al gazdei;
   - `docker compose config -q`, `finet-migrate` de două ori (a doua trebuie să raporteze „aplicate acum 0");
   - primul utilizator cu `finet-admin create-user --password-stdin` (parola generată: afișată o singură dată pe terminal, niciodată în log);
   - `up -d --no-build finet-web`, așteaptă `healthy`, apoi `--profile worker up -d --no-build finet-worker`;
   - opțional `cloudflared` (token în fișier root `600`, unitate `finet-cloudflared.service` cu `--token-file`);
   - cron în `/etc/cron.d/finet` (vezi mai jos), logrotate, loguri `600`;
   - backup (opțional): extrage din `rclone.conf` doar secțiunea remote-ului în `finet_rclone_conf`, verifică remote-ul, scrie `finet_backup_repository`, `finet_restic_password` (generată sau dată), `finet_backup_pg_service`, face `init` doar dacă repository-ul nu există, rulează opțional `run-backup.sh`.
7. **Acceptare:** N1 (niciun `postgres://` în `docker inspect` și în `config.v2.json` din `DockerRootDir`), `/api/health` cu tokenul citit **în container** din fișierul secret (nu trece prin argumente).
8. **Raport final** pe ecran și în `/srv/finet/install-<data>.log` (root, `600`, fără secrete; installer-ul își verifică logul și îl șterge dacă detectează o valoare secretă). **La eroare** (orice `die` sau întrerupere, în afara `--check`) logul se salvează și el, în `/srv/finet/install-<data>-eroare.log` (root, `600`, același control al secretelor; sau în fișierul dat cu `--log`), iar calea se afișează pe stderr. Dacă prefixul nu există încă sau nu rulezi ca root, logul nu se salvează.

## Mutare de pe un server existent (modul 2)

Copiază cu `rsync -aHAX --numeric-ids` (peste SSH, cu `--rsync-path="sudo rsync"` dacă utilizatorul sursă nu e root) `/srv/finet/{env,secrets,ca,compose,storage}`, cu permisiunile păstrate. Fișierele înlocuite pe destinație se salvează ca `.bak-<data>`.

- **Secretul Better Auth trebuie să rămână identic.** Dacă se schimbă, toate sesiunile și tokenurile bearer (aplicația Android) devin invalide. Installer-ul nu îl regenerează și compară suma `sha256` a fișierului pe ambele capete; la diferență se oprește.
- Pe serverul vechi, utilizatorul SSH are nevoie de `sudo rsync` și `sudo sha256sum` fără parolă (fișierele sunt `root 600` / `1000:1000 400`).
- Conectează-te o dată manual ca root (`sudo ssh user@host true`) ca să accepți cheia gazdei: scriptul folosește `StrictHostKeyChecking=yes`. Sub `sudo`, agentul SSH nu se păstrează; dă calea unei chei sau rulează `sudo --preserve-env=SSH_AUTH_SOCK ...`.
- **SHA-ul imaginilor la mutare = cel rulat pe serverul vechi.** Baza (Supabase) e comună, iar serverul vechi poate rămâne pornit în tot cutover-ul: imaginile unui `main` mai nou ar putea avea migrații pe care `finet-migrate` le-ar aplica pe baza de producție. De aceea, la mutare `IMAGES_SHA=auto` înseamnă SHA-ul checkout-ului de pe serverul vechi (`git rev-parse HEAD` în `<MOVE_SRC_PREFIX>/src`, citit peste SSH, doar citire; întâi fără sudo, apoi `sudo -n`). Dacă nu poate fi citit, `auto` se oprește cu un mesaj clar. Un alt SHA (explicit în `IMAGES_SHA`) cere confirmare: la prompt, sau `MOVE_SHA_DIFERIT=da` în `--answers`; fără ea installer-ul se oprește **înainte** de rsync și de migrații (`--check` raportează eșecul). Artefactele CI se păstrează 7 zile: dacă SHA-ul vechi a expirat, `pull-images.sh` eșuează (tot înainte de migrații) și trebuie dat un SHA recent, cu confirmare.
- Migrațiile trebuie să raporteze „aplicate acum 0"; altfel se oprește (baza nu era la zi față de imaginile alese). Aceasta e doar o a doua plasă: verificarea SHA-ului de mai sus se face înainte de a rula migrațiile.
- `create-user` **nu** se rulează. Valorile de rețea din `compose.env` se actualizează cu cele confirmate pentru noul server. AI (`AI_ASK`) se citește din `finet.env` copiat.
- **Cutover recomandat:** (1) rulezi mutarea cu serverul vechi încă pornit (copiază storage-ul); (2) oprești containerele vechi și scoți **toate** cron-urile FINET de acolo; (3) rulezi din nou cu `MOVE_FINAL_SYNC=da` (sincronizează doar `storage`); (4) muți ruta Cloudflare; (5) adaugi IP-ul nou în Network Restrictions înainte de pasul 1 (IP-ul vechi poate rămâne până la capăt). Fără `--delete`: ștergerile de pe sursă nu se propagă.

## Doar verificare (`--check` sau `--dry-run`)

Rulează precondițiile și verificările de rețea, citește starea (docker `version/info/inspect/ps`, `network inspect`, `crontab -l -u root`), arată fiecare acțiune ca „[verificare] ar face: ...". **Nu scrie nimic** în prefix, cron, systemd, logrotate; singurul fișier este logul temporar (șters la ieșire), sau cel dat prin `--log`. Întrebările secrete nu se cer în `--check` interactiv.

## Neinteractiv: `--answers FIȘIER`

Fișier `CHEIE=valoare`, o linie pe cheie, `#` pentru comentarii. Se parsează pe o listă de chei permise (nu se `source`-ază). Nu apelează niciodată `whiptail`/`dialog` și nu întreabă nimic: o cheie lipsă fără valoare implicită oprește scriptul cu mesajul „Lipsește răspunsul «CHEIE»". Fișierul care conține secrete (`DB_URL_*`, `ADMIN_PASSWORD`, `GITHUB_TOKEN`, ...) trebuie să fie `chmod 600`, altfel scriptul refuză. Aplicarea reală cere `CONFIRM=da`. Cheile sunt cele din `ANS_KEYS` în script (numele coincid cu cele afișate în log: `APP_HOST`, `DB_URL_APP`, `DB_URL_MIGRATE`, `CA_SRC`, `ADMIN_EMAIL`, `ENTRY`, `AI_ENABLE`, ...). Exemplu minim de verificare: `ops/install/test.sh` (funcția `make_answers`).

## Rețeaua

Rețeaua se numește implicit `apps` (subnet implicit `172.88.88.0/24`, IP-urile `.130` și `.131`), toate configurabile; numele ajunge în `compose.env` ca `FINET_APPS_NETWORK` (compose: `name: ${FINET_APPS_NETWORK:-apps}`). Dacă rețeaua există, subnetul și IP-urile implicite se iau din ea; installer-ul verifică că IP-urile sunt libere. Dacă lipsește, o creează cu subnetul ales.

## Cron

Joburile merg în **`/etc/cron.d/finet`** (fișier dedicat, `root:root 644`, cu `SHELL`, `PATH` și coloana `root`), nu prin `crontab -` (care suprascrie tot crontab-ul root). Crontab-ul root și celelalte fișiere din `cron.d` se **citesc** (`crontab -l -u root`): un job FINET deja existent nu se dublează, se avertizează.

| Oră | Job |
|---|---|
| 04:25 | `finet-cleanup` (retenția documentelor) |
| 04:30 | `finet-cleanup cleanup-unverified --yes` (no-op în `personal`) |
| 04:35 | `finet-admin aggregate-events` |
| 05:10 | `run-backup.sh` (dacă backup-ul e configurat) |
| 04:15 | `cleanup-idempotency`: **opțional, implicit nu** (INFRA 4c; nu e în producția actuală, tabelul crește fără el dar nu se strică nimic) |

Toate apelurile `docker compose` folosesc aceeași listă `-f` (inclusiv `docker-compose.ask.yml` cât `AI_ASK=1`): altfel `up` pe worker ar recrea `finet-web` fără secretul cheii „ask". Logurile `finet-cleanup.log` și `finet-backup.log` sunt create `600` și rotite săptămânal.

**Nu lăsa cron-uri FINET active pe serverul vechi** după o mutare: backup și curățări ar rula în paralel.

## Ce rămâne manual (și de ce)

| Ce | De ce |
|---|---|
| Supabase: proiect, `roles.sql`, `backup-role.sql`, Data API oprit, Network Restrictions (adăugarea IP-ului afișat) | nu există chei de administrare Supabase; rolurile cer superuser |
| Cloudflare: ruta hostname → `http://<IP finet-web>:3000` (sau `finet-web:3000` dacă tunelul rulează pe rețeaua Docker), aplicația Access, `CF_ACCESS_TEAM_DOMAIN` și `CF_ACCESS_AUD` | nu există chei API Cloudflare; AUD apare abia după crearea aplicației. Fără ele `finet-web` nu pornește: installer-ul pregătește tot și se oprește înainte de `up`, apoi reiei rularea |
| Notificări (Telegram/SMTP) în `/srv/finet/env/notify.env` | token personal; apoi `ops/notify/notify.sh --test` |
| Planuri/recompense și alte valori de business (modul `saas`) | decizii ale operatorului |
| Cheile LiteLLM (`finet`, `finet-ask`) | se creează în LiteLLM; installer-ul doar le primește |
| Traefik (varianta B) | resolverul și entrypoint-ul se confirmă în `traefik.yml` al gazdei |
| Destinații de backup S3/SFTP | installer-ul acoperă doar rclone (decizia curentă); restul: `docs/BACKUP.md` |

## Idempotență

Rulat a doua oară, installer-ul nu strică nimic: fișierele env existente se păstrează și doar cheile din wizard se actualizează (cu backup `.bak-<data>` o singură dată pe zi); secretele existente se păstrează implicit (întrebare per secret; înlocuirea face backup, iar rotirea Better Auth invalidează sesiunile); CA, cron, logrotate și unitatea `cloudflared` se rescriu doar dacă diferă; rețeaua, repository-ul restic și utilizatorul existent se recunosc. Testul din CI rulează instalarea de două ori și verifică că niciun fișier nu s-a schimbat.

## Rollback

Installer-ul nu șterge nimic din `/srv/finet`. Pentru a opri o instalare:

```bash
cd /srv/finet/src
F="-f ops/docker/docker-compose.yml -f ops/docker/docker-compose.ask.yml"   # fără al doilea dacă AI_ASK=0
sudo docker compose $F --env-file /srv/finet/compose/compose.env --profile worker down   # oprește finet-web și finet-worker
sudo rm /etc/cron.d/finet                                  # oprește joburile
sudo systemctl disable --now finet-cloudflared.service     # dacă ai instalat cloudflared
sudo rm /etc/systemd/system/finet-cloudflared.service && sudo systemctl daemon-reload
```

Rămân neatinse: `/srv/finet` (date, secrete, env), rețeaua Docker, imaginile și baza de date. Pentru a reveni la o stare anterioară a unui fișier: `<fișier>.bak-<data>`. Ștergerea datelor sau a bazei e o decizie separată (docs/INFRA.md, docs/BACKUP.md).

## Teste

`sh ops/install/test.sh` (inclus în `pnpm test:ops` și rulat în CI, în jobul `backup-restore`, într-un container Debian efemer): sintaxă `sh`/`dash`, `shellcheck`, reguli statice (fără `crontab -`, fără `read -s`, fără build local), unități (validatori, editarea fișierelor env, textul cron), `--check` neinteractiv (nu scrie nimic, doar comenzi Docker de citire, niciun secret în stdout/stderr/log/argv), instalare reală cu stub-uri (permisiuni, parola prin stdin, a doua rulare idempotentă) și mutare cu `rsync`/`ssh` simulate.
