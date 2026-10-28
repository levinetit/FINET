# FINET — backup și restaurare

Backup-ul propriu al FINET (master prompt 3.5 și Faza 3): în fiecare zi, un `pg_dump` al schemei `finet` din Supabase și fișierele din `/srv/finet/storage`, criptate cu **restic**, într-o destinație în afara serverului, cu retenție 7 zilnice / 4 săptămânale / 12 lunare și alertă la eșec. Decizia și alternativele: [ADR 0009](adr/0009-backup-restic.md).

**Fără un backup reușit și o restaurare verificată pe producție (pasul 8 de mai jos) nu se introduc date reale.**

Agentul nu a rulat niciun backup real, nu a creat roluri pe Supabase și nu a atins `/srv/finet`. Tot ce urmează după „Instalare” e de făcut de operator.

## 1. Arhitectura

```
cron root (host) ── ops/backup/run-backup.sh ──┬── docker compose run --rm finet-backup backup
                                               │      (imaginea finet:backup, uid 1000, read-only,
                                               │       cap_drop ALL, 256 MiB, rețeaua finet_default)
                                               │        ├─ pg_dump --schema=finet ──► restic backup --stdin-from-command
                                               │        ├─ /data/storage (read-only) ──► restic backup
                                               │        ├─ restic forget 7/4/12 --prune
                                               │        └─ restic check (duminica și un subset de date)
                                               └── la eșec: ops/notify/notify.sh (Telegram/email), max 1/oră pe eroare
```

| Componentă                          | Fișier                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Imaginea (restic 0.18, pg_dump 17)  | `ops/backup/Dockerfile` (ținta `backup`, construită de workflow-ul `images`, nu pe host)  |
| Serviciul compose                   | `finet-backup` în `ops/docker/docker-compose.yml` (profilul `backup`, one-shot)           |
| Destinația                          | suprapunerile `ops/backup/compose.{s3,sftp,local}.yml`                                    |
| Backup                              | `ops/backup/backup.sh` (prin `entrypoint.sh backup`)                                      |
| Restaurare                          | `ops/backup/restore.sh` (prin `entrypoint.sh restore --yes`) + `compose.restore.yml`      |
| Rularea zilnică + alerta            | `ops/backup/run-backup.sh` (host, root), config `ops/backup/backup-host.env.example`      |
| Rolul bazei                         | `ops/backup/backup-role.sql`                                                              |
| Testul de restaurare                | `ops/backup/restore-test.sh` (job-ul CI `backup-restore`), `ops/backup/test.sh` (`test:ops`) |

Garanții verificate de teste:

- un `pg_dump` care iese cu cod ≠ 0 (rol greșit, parolă greșită, RLS) **nu** produce instantaneu (`--stdin-from-command`), iar scriptul iese cu cod ≠ 0;
- dump-ul nu atinge discul în clar; parola bazei, parola restic și cheile nu apar în argumente, în `docker inspect` sau în log;
- instantaneele au gazda fixă `finet` (`docker compose run` schimbă hostname-ul la fiecare rulare), deci retenția chiar se aplică;
- restaurarea readuce identic rândurile și conținutul fiecărui tabel, secvențele, soldurile, RLS `ENABLE`+`FORCE`, politicile, GRANT-urile (inclusiv pe coloane), privilegiile implicite, funcțiile și triggerele.

## 2. Destinația (alege operatorul)

`RESTIC_REPOSITORY` e configurabil (fișierul-secret `finet_backup_repository`) și se alege suprapunerea potrivită:

| Destinație                                                                 | Adresa în `finet_backup_repository`         | Suprapunere         | Observații                                                                                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **S3-compatibil** (Backblaze B2, Wasabi, Hetzner Object Storage, AWS S3)   | `s3:https://<endpoint>/<bucket>`            | `compose.s3.yml`    | recomandată: cheie dedicată cu drepturi doar pe acel bucket; ideal cu Object Lock / versiuni, ca un atacator de pe VPS să nu poată șterge tot |
| **SFTP** (storage box, alt server)                                         | `sftp:<utilizator>@<gazdă>:/<cale>`         | `compose.sftp.yml`  | cheie SSH dedicată, `known_hosts` fixat (verificat cu amprenta furnizorului), cont fără shell                                                 |
| **Local**                                                                  | `/backup/repo`                              | `compose.local.yml` | **NU e backup în afara serverului**: pierderea discului sau a VPS-ului ia și backup-ul. Doar pentru test sau temporar                        |

Nu folosi Google Drive-ul existent al hostului prin `/home`: directorul FINET trebuie să rămână în afara `rclone sync /home` (copia necriptată, `docs/INFRA.md` 4a). restic criptează oricum, dar parola și cheile ar fi pe același server.

## 3. Rolul bazei de date (`finet_backup`)

Toate tabelele FINET au `FORCE ROW LEVEL SECURITY`. `pg_dump` pune `row_security = off`, iar pentru un rol supus RLS asta dă **eroare** la primul tabel, nu un dump filtrat. Verificat în `restore-test.sh` cu rolurile reale, pe PostgreSQL 17:

| Rol                                            | Rezultat                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `finet_migrator` (proprietarul schemei)        | eșuează: `query would be affected by row-level security policy` (FORCE se aplică proprietarului) |
| `finet_app` (NOBYPASSRLS)                      | eșuează                                                                                      |
| `finet_app` cu `--enable-row-security`         | „reușește”, dar scrie **0 din 125** de tranzacții: un backup gol care pare bun (nu se folosește) |
| `finet_backup` (LOGIN, BYPASSRLS, doar SELECT) | dump complet, verificat prin restaurare                                                      |

Deci varianta cu cel mai mic privilegiu care produce un dump complet e un rol dedicat **`finet_backup`**: `LOGIN BYPASSRLS`, fără superuser/CREATEDB/CREATEROLE/replicare, `connection limit 2`, `default_transaction_read_only = on`, `USAGE` pe schema `finet` și `SELECT` pe tabelele și secvențele ei, plus privilegii implicite pentru tabelele create de migrațiile viitoare (altfel backup-ul ar eșua cu „permission denied” la prima migrație nouă; testul verifică un tabel creat după GRANT-uri). `pg_read_all_data` nu ajută (nu ocolește RLS) și ar da citire pe tot clusterul, inclusiv schema `auth` a Supabase.

Crearea (operatorul, o dată), ca în `ops/supabase/README.md`:

```bash
# Verificare: din PostgreSQL 16, doar un rol cu BYPASSRLS poate crea un rol BYPASSRLS.
psql "<url-postgres>?sslmode=verify-full&sslrootcert=<ca.crt>" -c \
  "select rolbypassrls, rolcreaterole from pg_roles where rolname = current_user"

read -rs FINET_BACKUP_PASSWORD; export FINET_BACKUP_PASSWORD      # openssl rand -base64 32
psql "<url-postgres>?sslmode=verify-full&sslrootcert=<ca.crt>" -v step=role -f ops/backup/backup-role.sql
psql "<url-migrator>?sslmode=verify-full&sslrootcert=<ca.crt>" -v step=grants -f ops/backup/backup-role.sql
unset FINET_BACKUP_PASSWORD
```

Ultima interogare a pasului `grants` trebuie să întoarcă `tabele_fara_select = 0`.

**DE VERIFICAT pe Supabase:** dacă `postgres` nu are `BYPASSRLS` (pasul 1 dă `permission denied to create role` sau atributul lipsește), varianta de rezervă e dump-ul cu utilizatorul `postgres` al proiectului, într-un fișier de servicii separat (privilegiu mai larg: notează decizia într-un ADR). Nu folosi `--enable-row-security` ca ocolire.

## 4. Secrete (doar pe server, fișiere `1000:1000 0400` în `/srv/finet/secrets`)

| Fișier                                   | Conținut                                                                                                   | Pentru                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| `finet_restic_password`                  | parola repository-ului (`openssl rand -base64 32`); **păstreaz-o și în afara serverului** (manager de parole): fără ea backup-ul e de nerecuperat | toate                      |
| `finet_backup_repository`                | adresa repository-ului (tabelul din 2)                                                                     | toate                      |
| `finet_backup_pg_service`                | fișier de servicii libpq, secțiunea `[finet_backup]` (mai jos)                                             | backup                     |
| `finet_backup_s3_access_key_id`, `finet_backup_s3_secret_access_key` | cheile S3                                                                      | `compose.s3.yml`           |
| `finet_backup_sftp_key`, `finet_backup_sftp_known_hosts` | cheia privată SSH și cheia publică fixată a serverului                                     | `compose.sftp.yml`         |
| `finet_restore_pg_service`               | secțiunea `[finet_restore]`, rolul `finet_migrator` al bazei țintă                                         | doar la restaurare         |

`finet_backup_pg_service`:

```ini
[finet_backup]
host=<gazda-supabase>
port=5432
dbname=postgres
user=finet_backup
password=<parola>
sslmode=verify-full
sslrootcert=/run/finet/ca/prod-ca-2021.crt
```

Conexiune în modul sesiune (directă sau pooler-ul pe 5432), nu pooler-ul tranzacție (6543), ca la `finet-migrate`. Scriptul refuză un fișier fără `sslmode=verify-full`. Fișierul de servicii (în loc de un URL) ține parola în afara argumentelor proceselor; restic citește singur `RESTIC_PASSWORD_FILE`/`RESTIC_REPOSITORY_FILE`, iar cheile S3 (restic nu are `_FILE` pentru ele) sunt citite de `lib.sh` în mediul procesului restic (vizibil doar pentru același uid și root, nu în `config.v2.json`).

Configurația nesecretă: `/srv/finet/env/finet.backup.env` (model `ops/docker/finet.backup.env.example`) și, pe host, `/srv/finet/env/backup-host.env` (model `ops/backup/backup-host.env.example`).

## 5. Instalare (operatorul)

1. **Imaginea**: `sudo sh ops/deploy/pull-images.sh <sha> backup` (devine `finet:backup`; `all` aduce acum și imaginea de backup, deci cere un commit construit după F3-D).
2. **Rolul** `finet_backup` (secțiunea 3).
3. **Destinația**: bucket-ul/contul SFTP; cheile dedicate.
4. **Secretele** (secțiunea 4) și fișierele de mediu:
   ```bash
   sudo install -d -o root -g root -m 700 /srv/finet/backup-state
   sudo install -m 600 ops/docker/finet.backup.env.example /srv/finet/env/finet.backup.env
   sudo install -m 600 ops/backup/backup-host.env.example /srv/finet/env/backup-host.env   # FINET_BACKUP_DEST
   # pentru fiecare secret: sudo install -o 1000 -g 1000 -m 400 <fișier> /srv/finet/secrets/<nume>
   ```
5. **Inițializarea repository-ului** (o singură dată; `backup` nu inițializează singur, ca o adresă greșită să nu creeze în tăcere alt repository):
   ```bash
   C="docker compose -f ops/docker/docker-compose.yml -f ops/backup/compose.s3.yml --env-file /srv/finet/compose/compose.env --profile backup"
   sudo $C run --rm -T finet-backup init
   ```
6. **Primul backup** manual, cu notificarea: `sudo sh ops/backup/run-backup.sh` → cod 0; `sudo $C run --rm -T finet-backup snapshots` arată un instantaneu `finet-db` și unul `finet-storage`. Testul notificării: `sudo sh ops/notify/notify.sh --env-file /srv/finet/env/notify.env --test`.
7. **Programarea** (secțiunea 6).
8. **Restaurarea reală de verificare** (secțiunea 7, varianta „bază de probă”), cu rezultatul notat în `docs/reports/faza-3.md`. Abia după ea se introduc date reale.

## 6. Programare

Cu `sudo crontab -e` (**nu** `crontab -`, care înlocuiește tot crontab-ul root), de exemplu după backup-urile existente ale hostului (02:30, 03:30) și înaintea `dockerai.py` (04:00 la 3 zile):

```cron
40 3 * * *   /srv/finet/repo/ops/backup/run-backup.sh >> /var/log/finet-backup.log 2>&1
```

(Calea checkout-ului e cea folosită de operator pentru deploy.) `run-backup.sh`:

- trimite alertă la orice eșec: etapă (`config`, `repo`, `unlock`, `dump`, `storage`, `forget`, `check`), container oprit (137, OOM), timeout (`FINET_BACKUP_TIMEOUT`, implicit 3h), altă rulare în curs (`lock`), imagine lipsă;
- anti-flood: aceeași eroare cel mult o dată pe oră (`FINET_BACKUP_ALERT_INTERVAL`); o eroare nouă pleacă imediat;
- **decizia mea:** un mesaj de succes săptămânal (duminica, `FINET_BACKUP_WEEKLY_OK_DAY`), ca un cron oprit să nu treacă neobservat;
- scrie `/srv/finet/backup-state/last-success` (epoch), pentru pagina de administrare (6.5) sau o verificare externă.

Rotirea logului: `/var/log/finet-backup.log` e mic (câteva sute de rânduri pe zi); de adăugat în `logrotate` dacă se dorește.

## 7. Restaurare (procedura testată)

Aceeași procedură o rulează `restore-test.sh` în CI. Precondiții: schema `finet` **există și e goală** în baza țintă (migratorul nu are CREATE pe bază), rolurile `finet_migrator`, `finet_app` și `finet_backup` există.

**A. Probă periodică (recomandat lunar și obligatoriu la pasul 8 al instalării)**, pe un PostgreSQL 17 separat, fără să atingi producția:

1. Un container `postgres:17-alpine` efemer (`--memory=256m`) pe rețeaua proiectului, `finet_default` (pe ea rulează și `finet-backup`; nu pe `apps`), cu `ops/postgres/test-bootstrap.sql` (roluri + schema goală) și `backup-role.sql` (pasul `role`, ca superuserul containerului).
2. `finet_restore_pg_service` → secțiunea `[finet_restore]` spre acel Postgres (`user=finet_migrator`; pentru o bază locală de probă fără TLS se adaugă `-e FINET_BACKUP_INSECURE_DB=1` doar la această rulare).
3. `sudo install -d -o 1000 -g 1000 -m 700 /srv/finet/restore`
4. ```bash
   sudo docker compose -f ops/docker/docker-compose.yml -f ops/backup/compose.s3.yml -f ops/backup/compose.restore.yml \
     --env-file /srv/finet/compose/compose.env --profile backup \
     run --rm -T finet-backup restore --yes --storage-target /restore
   ```
5. Verifică: ultimele rânduri ale ieșirii (`tabele=… cu_rls_force=…`), numărul și suma tranzacțiilor pe gospodărie comparate cu producția, fișierele din `/srv/finet/restore/data/storage`. Apoi șterge containerul de probă și `/srv/finet/restore`.

**B. Dezastru (baza de producție pierdută sau coruptă)**, doar cu decizia explicită a operatorului:

1. Oprește `finet-web` (și `finet-worker`).
2. Proiect Supabase nou (sau aceeași bază): rulează `ops/supabase/roles.sql` (roluri + schema goală) și `backup-role.sql` pasul `role`. Pe aceeași bază: `drop schema finet cascade` ca `finet_migrator` (ireversibil) și recrearea schemei din `roles.sql`.
3. Restaurarea ca la A.4, cu `finet_restore_pg_service` spre baza nouă (`sslmode=verify-full`). Opțional `--snapshot <ID>` pentru un instantaneu anume (`entrypoint.sh snapshots`).
4. `backup-role.sql` pasul `grants` (privilegiile implicite revin din dump, dar pasul e idempotent).
5. `finet-migrate`: trebuie să raporteze „aplicate acum 0” (evidența migrațiilor e în dump).
6. Fișierele: mută conținutul din `/srv/finet/restore/data/storage` în `/srv/finet/storage` (păstrând `1000:1000`).
7. Actualizează secretele URL dacă s-a schimbat proiectul, pornește `finet-web`, verifică `/api/health` și valorile de control.

`restore.sh` refuză fără `--yes`, refuză o schemă care nu e goală și refuză un utilizator care nu e proprietarul schemei.

## 8. Testul de restaurare (automat)

`ops/backup/restore-test.sh` (job-ul `backup-restore` din `.github/workflows/ci.yml`, în imaginea construită pe runner, cu `--memory=256m`), pe PostgreSQL 17 efemer: roluri și schemă ca `roles.sql`, rolul `finet_backup`, migrațiile `0000`–`0004` ca `finet_migrator`, date de test în două gospodării (RON și EUR, venituri, cheltuieli, un transfer, sume la plafonul 1e13, etichete, bugete, obiective), un tabel creat după GRANT-uri; backup cu `backup.sh`; negativele (dump ca migrator/app/parolă greșită → eșec fără instantaneu; `--enable-row-security` → dump incomplet); `drop schema finet cascade` + recreare; restaurare cu `restore.sh`; amprenta bazei înainte = după; `finet_app` vede 0 rânduri fără context; parola restic greșită refuzată (cod 12); retenția pe 49 de instantanee simulate păstrează exact cele 20 așteptate. Apoi CI rulează `migrate.mjs` pe baza restaurată: „aplicate acum 0”.

Local (memorie puțină pe host): un container `postgres:17-alpine` și un container `alpine:3.22` cu `restic` și `postgresql17-client`, fiecare cu `--memory=256m`, pe o rețea privată, cu repo-ul montat read-only:

```bash
docker exec -u 1000 -e FINET_RESTORE_TEST=1 -e PGHOST=<pg> -e PGUSER=finet -e PGPASSWORD=finet_ci <runner> \
  sh /work/ops/backup/restore-test.sh
```

## 9. Ce NU acoperă

- Backup-urile planului Supabase (zilnice, pe planul plătit) rămân **în plus**, nu sunt înlocuite.
- Alte servicii de pe host, `/srv/finet/env`, `/srv/finet/secrets` (secretele se păstrează separat, în managerul de parole; **fără parola restic backup-ul nu se poate citi**).
- Schemele Supabase din afara `finet` (`auth`, `storage`): FINET nu le folosește.
- Un atacator cu root pe VPS poate citi cheile destinației și șterge instantaneele, dacă destinația permite ștergerea: folosește Object Lock/versiuni pe bucket sau un cont SFTP cu instantanee pe server (append-only) — decizia operatorului.
- Verificarea completă a datelor (`check --read-data`) se face doar la cerere (`entrypoint.sh check --read-data`); automat se citește un subset (implicit 10% duminica).
