#!/bin/sh
# FINET — backup-ul zilnic (master prompt 3.5 și Faza 3): dump-ul schemei `finet` + fișierele din
# storage, criptate cu restic, apoi retenția și verificarea repository-ului. Rulează în imaginea
# de backup (serviciul compose `finet-backup`), pornit de ops/backup/run-backup.sh din cron-ul
# root al operatorului. Configurația: lib.sh și docs/BACKUP.md.
#
# Etape (fiecare anunțată cu FINET_BACKUP_STAGE=<etapă>):
#   repo     repository-ul se deschide cu parola dată (nu se inițializează automat: o adresă
#            greșită nu creează în tăcere un repository nou, vezi `entrypoint.sh init`)
#   unlock   șterge doar blocările vechi (ale unor rulări oprite, de exemplu OOM)
#   dump     pg_dump --schema=finet --format=custom, direct în restic (--stdin-from-command):
#            dump-ul nu atinge discul în clar, iar dacă pg_dump iese cu cod ≠ 0 restic NU
#            salvează instantaneul (un dump trunchiat nu devine un backup „reușit”)
#   storage  directorul de fișiere (FINET_BACKUP_STORAGE_DIR), read-only în container
#   forget   retenția 7/4/12, grupată pe gazdă și etichete, cu --prune
#   check    `restic check` structural la fiecare rulare; în ziua FINET_BACKUP_CHECK_DATA_DAY
#            (1-7, implicit 7 = duminică) citește și un subset de date (--read-data-subset)
#
# Cod de ieșire ≠ 0 la orice eroare (set -eu; restic iese cu 3 dacă un fișier nu a putut fi
# citit, adică instantaneu incomplet, tratat tot ca eșec).
#
# Rolul bazei: `finet_backup` (LOGIN, BYPASSRLS, doar SELECT pe schema `finet`), vezi
# ops/backup/backup-role.sql. pg_dump pune row_security=off: cu un rol supus RLS (inclusiv
# proprietarul `finet_migrator`, pentru că tabelele au FORCE) dump-ul EȘUEAZĂ, nu iese incomplet.
# NU adăuga --enable-row-security: ar produce în tăcere un dump fără rândurile filtrate de RLS.

set -eu

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=ops/backup/lib.sh
. "$LIB_DIR/lib.sh"

FINET_STAGE=init
# shellcheck disable=SC2154 # rc e atribuit în trap
trap 'rc=$?; if [ "$rc" -ne 0 ]; then log "backup EȘUAT la etapa $FINET_STAGE (cod $rc)"; fi' EXIT

STORAGE_DIR=${FINET_BACKUP_STORAGE_DIR:-/data/storage}
REQUIRE_STORAGE=${FINET_BACKUP_REQUIRE_STORAGE:-1}
CHECK_DATA_DAY=${FINET_BACKUP_CHECK_DATA_DAY:-7}
CHECK_DATA_SUBSET=${FINET_BACKUP_CHECK_DATA_SUBSET:-10%}
PG_SERVICE=${PGSERVICE:-finet_backup}

stage config
load_restic_config
check_pg_service PGSERVICEFILE "$PG_SERVICE"
export PGSERVICE="$PG_SERVICE"
printf '%s' "$CHECK_DATA_DAY" | grep -Eq '^[0-7]$' || die 2 "FINET_BACKUP_CHECK_DATA_DAY trebuie să fie 0-7 (0 = niciodată)"
printf '%s' "$CHECK_DATA_SUBSET" | grep -Eq '^([0-9]{1,3}(\.[0-9]+)?%|[0-9]+/[0-9]+)$' ||
  die 2 "FINET_BACKUP_CHECK_DATA_SUBSET invalid (ex. 10% sau 1/7)"

stage repo
restic cat config > /dev/null || die 1 "repository-ul nu se deschide (adresă, acces sau parolă greșită; inițializare: entrypoint.sh init)"

stage unlock
restic unlock

stage dump
log "dump-ul schemei finet (serviciul libpq $PG_SERVICE) → restic"
# --compress=0: restic comprimă (zstd) și deduplică; un dump deja comprimat nu s-ar deduplica.
# --lock-wait-timeout: nu așteaptă la nesfârșit după o migrație care ține blocări.
# shellcheck disable=SC2086 # $FINET_BACKUP_RESTIC_ARGS e intenționat o listă de opțiuni
restic backup ${FINET_BACKUP_RESTIC_ARGS-} --host "$FINET_BACKUP_HOST" --tag "$FINET_DB_TAG" \
  --stdin-filename "$FINET_DUMP_NAME" --stdin-from-command -- \
  pg_dump --no-password --schema=finet --format=custom --compress=0 --lock-wait-timeout=120s

stage storage
if [ -d "$STORAGE_DIR" ]; then
  log "fișierele din $STORAGE_DIR → restic"
  # shellcheck disable=SC2086
  restic backup ${FINET_BACKUP_RESTIC_ARGS-} --host "$FINET_BACKUP_HOST" --tag "$FINET_STORAGE_TAG" "$STORAGE_DIR"
elif [ "$REQUIRE_STORAGE" = 1 ]; then
  die 1 "directorul de fișiere $STORAGE_DIR lipsește (FINET_BACKUP_REQUIRE_STORAGE=1)"
else
  log "directorul de fișiere $STORAGE_DIR lipsește; sărit (FINET_BACKUP_REQUIRE_STORAGE=0)"
fi

stage forget
# shellcheck disable=SC2086 # $FINET_RETENTION e o listă de opțiuni
restic forget --host "$FINET_BACKUP_HOST" --tag "$FINET_DB_TAG" --tag "$FINET_STORAGE_TAG" \
  --group-by host,tags $FINET_RETENTION --prune

stage check
if [ "$CHECK_DATA_DAY" != 0 ] && [ "$(date +%u)" = "$CHECK_DATA_DAY" ]; then
  log "verificare cu citirea datelor ($CHECK_DATA_SUBSET)"
  restic check --read-data-subset="$CHECK_DATA_SUBSET"
else
  restic check
fi

stage finalizat
log "backup reușit"
