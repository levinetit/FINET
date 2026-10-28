# ADR 0009 — Backup propriu cu restic și restaurare testată (Faza 3, F3-D)

- **Stare:** propus (F3-D: imaginea, scripturile, serviciul compose, testul de restaurare în CI). Instalarea pe server, destinația și primul backup real: operatorul (`docs/BACKUP.md`).
- **Legături:** master prompt 3.1 (notificări), 3.5 (Supabase, backup propriu), Faza 3 („Backup zilnic”); ADR 0002 (Docker pe VPS), ADR 0003 (roluri, secrete ca fișiere); `docs/INFRA.md` 4a (date în afara `/home`).

## Context

Datele FINET sunt în Supabase (schema `finet`, RLS `ENABLE`+`FORCE` pe toate tabelele cu date, proprietar `finet_migrator`) și în `/srv/finet/storage` pe VPS. Planul gratuit Supabase nu are backup-uri descărcabile, iar master promptul cere oricum un backup propriu, criptat, în altă destinație, cu retenție 7/4/12, alertă la eșec și restaurare **testată**. Hostul are puțină memorie (~1 GB disponibil), nu construiește imagini și are deja un backup `rclone` al `/home` (inclusiv o copie necriptată), din care FINET e exclus intenționat.

## Decizii

### Unealta: restic într-o imagine separată

- **restic** (criptare autentificată, deduplicare, compresie zstd, retenție `forget`, `check`, backend-uri S3/SFTP/local): cerut de master prompt. Versiunea ≥ 0.17 pentru `backup --stdin-from-command`; Alpine 3.22 are 0.18.
- Imaginea `finet:backup` (`ops/backup/Dockerfile`, Alpine 3.22.7, `restic~0.18`, `postgresql17-client~17`, `openssh-client-default`, `tzdata`), separată de `finet:tools`: imaginea Node nu are nevoie de restic/pg_dump și invers. Construită de workflow-ul `images` (matricea are acum `web`, `tools`, `backup`) și adusă cu `pull-images.sh <sha> backup`; niciun build pe host.
- Imaginea de bază e fixată pe digest (`alpine:3.22.7@sha256:2e0b81d6…`, indexul multi-arch citit din registry fără pull, LOW-3 din revizuirea Fazei 3); actualizarea: `docker buildx imagetools inspect alpine:3.22.<n>` și se schimbă eticheta și digestul împreună.
- Pachetele sunt fixate pe versiunea minoră (`~0.18`, `~17`), nu pe revizia exactă (dispare din depozitul Alpine la fiecare patch de securitate; build-ul s-ar rupe). **Decizia mea.** pg_dump trebuie să fie ≥ versiunea majoră a serverului: la upgrade-ul Supabase la 18 se schimbă pachetul (pas adăugat în procedura din `docs/INFRA.md` 7).

### Serviciul `finet-backup`: one-shot, minim

Profilul `backup`, `restart: "no"`, `user: 1000:1000` (proprietarul `storage`, mod 700), `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, 256 MiB (`memswap` egal), tmpfs `/tmp` 96 MiB (HOME + cache restic), storage montat **read-only**, CA-ul Supabase, rețeaua `finet_default` (nu `apps`, fără IP static, fără porturi). Fără `container_name` (rulat cu `run --rm`).

### Dump-ul: `pg_dump --schema=finet --format=custom --compress=0` direct în restic

- `restic backup --stdin-from-command -- pg_dump …`: dump-ul nu atinge discul în clar și, spre deosebire de `pg_dump | restic backup --stdin` (POSIX `sh` nu are `pipefail`), un pg_dump care eșuează la jumătate **nu** produce un instantaneu „reușit”. Testat (dump ca migrator/app/parolă greșită → cod ≠ 0, niciun instantaneu nou).
- `--compress=0`: restic comprimă și deduplică; un dump comprimat de pg_dump n-ar deduplica între zile.
- Formatul custom permite restaurarea selectivă prin listă (`pg_restore -l/-L`), necesară pentru schema pre-creată (mai jos).

### Rolul de dump: `finet_backup` cu BYPASSRLS

Verificat pe PostgreSQL 17 cu rolurile reale (`restore-test.sh`): pg_dump pune `row_security = off`, deci pentru orice rol supus RLS dump-ul **eșuează** (`FORCE` se aplică și proprietarului `finet_migrator`); cu `--enable-row-security` „reușește” dar scrie 0 rânduri. `pg_read_all_data` nu ocolește RLS și citește tot clusterul. Varianta cu cel mai mic privilegiu care produce un dump complet: rol dedicat `LOGIN BYPASSRLS`, fără alte atribute, `connection limit 2`, `default_transaction_read_only`, `USAGE` + `SELECT` doar pe schema `finet` și privilegii implicite pentru tabelele migrațiilor viitoare (`ops/backup/backup-role.sql`, în doi pași: rolul ca `postgres`, drepturile ca `finet_migrator`). **De verificat de operator:** din PG16 doar un rol cu BYPASSRLS poate crea unul; dacă `postgres`-ul Supabase nu are atributul, rezerva e dump-ul ca `postgres` (de notat).

Alternative respinse: dump ca `finet_migrator` (eșuează), dezactivarea temporară a `FORCE` (fereastră fără izolare, cere DDL zilnic), `--enable-row-security` (backup gol).

### Restaurarea: ca proprietarul, într-o schemă pre-creată, o singură tranzacție

`restore.sh`: baza țintă trebuie să aibă schema `finet` goală, deținută de utilizatorul conectat (migratorul nu are CREATE pe bază; schema o creează `roles.sql`). Lista dump-ului fără intrarea `SCHEMA - finet`, `pg_restore --single-transaction --exit-on-error`, **fără** `--no-owner`/`--no-acl` (proprietarul și GRANT-urile lui `finet_app`, inclusiv pe coloane, trebuie să revină). Datele se încarcă înainte de `ENABLE/FORCE ROW LEVEL SECURITY` și de triggere (secțiunea post-data), deci migratorul le poate scrie; verificat. Refuză fără `--yes` și peste o schemă care nu e goală. Fișierele se restaurează într-un director separat, niciodată peste storage-ul viu.

### Secrete ca fișiere, nimic în argumente

Parola restic și adresa repository-ului: `RESTIC_PASSWORD_FILE`/`RESTIC_REPOSITORY_FILE` (native). Conexiunea la bază: un **fișier de servicii libpq** (`PGSERVICEFILE` + `PGSERVICE`) în loc de URL: parola nu apare în `ps` și nu e nevoie de parsarea unui URL în `sh` (**decizia mea**; restul aplicației folosește URL-uri, dar pg_dump ar fi primit URL-ul ca argument). Scriptul cere `sslmode=verify-full`. Cheile S3 (restic nu are `_FILE`) sunt citite în mediul procesului restic; SFTP: cheie dedicată + `known_hosts` fixat, `StrictHostKeyChecking=yes`. Secretele destinației sunt doar în suprapunerea ei (`compose.s3.yml`/`compose.sftp.yml`), ca o destinație să nu ceară fișierele alteia.

### Destinația: configurabilă; aleasă de operator: Google Drive prin rclone

**Decizia operatorului (2026-10-28):** `rclone:Gdrive:finet-backup/restic`, cu remote-ul `Gdrive` existent pe host (rclone, scope `drive`, ~1 TiB liber), fără `crypt` rclone (restic criptează deja totul). Implementare: pachetul `rclone~1.69` în imagine, suprapunerea `compose.rclone.yml` (secretul `finet_rclone_conf` → `RCLONE_CONFIG`, read-only, 384m), validarea din `lib.sh` (schema `rclone:<remote>:<cale>`, config existent și necitibil de alții, fără conținut în log), testul de restaurare și retenția rulate și prin `rclone:` cu un remote `local` (fără rețea). Fără `-o rclone.args`: argumentele implicite ale restic sunt corecte pentru Drive, iar `drive_use_trash` e implicit activ (decizia mea).

Limitări acceptate: **fără Object Lock** (coșul Drive păstrează ~30 de zile fișierele șterse de `prune`, protecție parțială; tokenul poate goli coșul); **tokenul Drive e larg** (scope `drive` complet, `root_folder_id` nu restrânge permisiunile), deci secretul e la fel de sensibil ca tot Drive-ul și ca backup-urile hostului din același cont; **tokenul reîmprospătat nu se salvează** (config read-only, reîmprospătare în memorie la fiecare rulare, decizia mea: un config scriibil de container ar putea fi modificat persistent). Variante mai stricte, pentru mai târziu: client OAuth cu `drive.file` sau cont Google dedicat; S3 cu Object Lock.

Alternativele rămân disponibile: S3-compatibil (cu Object Lock/versiuni), SFTP sau local. Local e documentat explicit ca **nefiind** în afara serverului. Repository-ul se inițializează doar explicit (`init`): o adresă greșită nu creează în tăcere un repository nou.

### Retenție, gazdă fixă, verificare

`forget --host finet --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 12 --prune`, etichete separate `finet-db`/`finet-storage`. Gazda e fixă (`--host finet`) pentru că `docker compose run` dă alt hostname la fiecare rulare și gruparea implicită (host, paths) n-ar aplica niciodată retenția. `TZ=Europe/Bucharest` (zilele de retenție sunt zile locale). Testat pe 49 de instantanee simulate: exact 20 păstrate, cu datele așteptate. `restic check` la fiecare rulare, cu `--read-data-subset=10%` duminica (configurabil). `restic unlock` înainte (doar blocările vechi, ex. după OOM).

### Alerta: de pe host, prin canalul existent

`ops/backup/run-backup.sh` rulează din cron-ul root (`sudo crontab -e`), pornește containerul și, la orice cod ≠ 0, trimite alerta prin `ops/notify/notify.sh` (Telegram sau email, 3.1). Alerta de pe host prinde și eșecurile pe care containerul nu le poate raporta (imagine lipsă, OOM 137, timeout, rulare suprapusă) și ține tokenul botului în afara containerelor. Anti-flood: aceeași pereche etapă+cod cel mult o dată pe oră. Mesaj de succes săptămânal (**decizia mea**, configurabil) și `last-success` în `/srv/finet/backup-state`.

## Consecințe

- Testul de restaurare rulează în CI (job `backup-restore`) pe imaginea reală, cu 256 MiB, și verifică la final cu `migrate.mjs` că baza restaurată e utilizabilă („aplicate acum 0”). Local, același test a rulat într-un container Alpine cu aceleași pachete.
- Nimic nu e verificat încă pe Supabase și pe o destinație reală (S3/SFTP): crearea rolului BYPASSRLS, latența, costurile, primul backup și restaurarea de probă rămân pașii operatorului (`docs/BACKUP.md` 5).
- Secretele backup-ului (în special parola restic) trebuie păstrate și în afara serverului; altfel o pierdere a VPS-ului face backup-ul ilizibil.
- `pull-images.sh <sha> all` cere acum și artefactul `backup`, deci un commit construit după F3-D.
