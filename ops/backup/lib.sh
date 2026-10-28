# shellcheck shell=sh
# SC2034: variabilele sunt folosite de scripturile care încarcă fișierul; SC2154: _path și
# _svc_file sunt atribuite prin eval.
# shellcheck disable=SC2034,SC2154
# FINET — funcții comune ale imaginii de backup (ops/backup/Dockerfile). Se încarcă cu `.` din
# entrypoint.sh, backup.sh și restore.sh; nu se rulează direct.
#
# Secretele vin DOAR ca fișiere (docs/BACKUP.md, „Secrete”), niciodată ca argumente:
#   RESTIC_PASSWORD_FILE    parola repository-ului restic (restic o citește singur)
#   RESTIC_REPOSITORY_FILE  adresa repository-ului: s3:..., sftp:..., sau o cale locală
#                           (restic o citește singur; se poate da și RESTIC_REPOSITORY)
#   PGSERVICEFILE + PGSERVICE  fișierul de servicii libpq (gazdă, utilizator, parolă, TLS) și
#                           secțiunea folosită; pg_dump/psql le citesc singure, deci parola nu
#                           apare în `ps` și nici în `docker inspect`
#   AWS_ACCESS_KEY_ID_FILE / AWS_SECRET_ACCESS_KEY_FILE  cheile S3; restic nu are variabile
#                           `_FILE` pentru ele, deci le citim aici în mediul procesului (vizibil
#                           doar pentru același uid și root, nu în argumente sau în config.v2.json)
#   FINET_BACKUP_SFTP_KEY_FILE / FINET_BACKUP_SFTP_KNOWN_HOSTS_FILE  cheia SSH și cheia publică
#                           fixată a serverului SFTP (StrictHostKeyChecking=yes, niciodată `no`)
#
# Scripturile nu folosesc `set -x` și nu afișează conținutul fișierelor-secret.

FINET_BACKUP_HOST=${FINET_BACKUP_HOST:-finet}
FINET_DB_TAG=finet-db
FINET_STORAGE_TAG=finet-storage
FINET_DUMP_NAME=finet.dump

# Retenția (master prompt, Faza 3): 7 zilnice, 4 săptămânale, 12 lunare. Grupare pe gazdă și
# etichete (baza și fișierele separat); gazda e fixă (`--host`), pentru că `docker compose run`
# dă containerului un hostname diferit la fiecare rulare, iar gruparea implicită (host, paths)
# n-ar mai aplica retenția. restore-test.sh verifică exact politica de aici.
FINET_RETENTION="--keep-daily 7 --keep-weekly 4 --keep-monthly 12"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2
}

die() { # cod, mesaj
  _code=$1
  shift
  log "EROARE: $*"
  exit "$_code"
}

# Etapa curentă: o linie FINET_BACKUP_STAGE=<etapă> pe care o citește run-backup.sh (gazda)
# ca să numească etapa eșuată în notificare și să grupeze alertele identice (anti-flood).
stage() {
  FINET_STAGE=$1
  printf 'FINET_BACKUP_STAGE=%s\n' "$1" >&2
}

# Fișier-secret: trebuie să existe, să poată fi citit și să nu fie gol. Mesajul numește
# variabila, nu conținutul.
require_file() { # numele variabilei, valoarea (calea)
  [ -n "$2" ] || die 2 "$1 nu e setat"
  [ -r "$2" ] || die 2 "$1: fișierul nu poate fi citit"
  [ -s "$2" ] || die 2 "$1: fișierul e gol"
}

# Citește un fișier-secret pe o singură linie (fără LF/CR final) într-o variabilă exportată.
export_from_file() { # variabila țintă, variabila _FILE
  eval "_path=\${$2-}"
  require_file "$2" "$_path"
  _value=$(tr -d '\r\n' < "$_path")
  [ -n "$_value" ] || die 2 "$2: fișierul e gol"
  eval "$1=\$_value"
  export "${1?}"
  unset _value _path
}

# Configurația comună pentru orice comandă restic.
load_restic_config() {
  if [ -n "${RESTIC_PASSWORD-}" ]; then
    die 2 "RESTIC_PASSWORD e setat direct în mediu; folosește RESTIC_PASSWORD_FILE"
  fi
  require_file RESTIC_PASSWORD_FILE "${RESTIC_PASSWORD_FILE-}"
  if [ -z "${RESTIC_REPOSITORY-}" ]; then
    require_file RESTIC_REPOSITORY_FILE "${RESTIC_REPOSITORY_FILE-}"
  fi
  check_rclone_config

  # S3: cheile din fișiere, ambele sau niciuna.
  if [ -n "${AWS_ACCESS_KEY_ID-}" ] || [ -n "${AWS_SECRET_ACCESS_KEY-}" ]; then
    die 2 "cheile S3 sunt setate direct în mediu; folosește AWS_ACCESS_KEY_ID_FILE și AWS_SECRET_ACCESS_KEY_FILE"
  fi
  if [ -n "${AWS_ACCESS_KEY_ID_FILE-}" ] || [ -n "${AWS_SECRET_ACCESS_KEY_FILE-}" ]; then
    export_from_file AWS_ACCESS_KEY_ID AWS_ACCESS_KEY_ID_FILE
    export_from_file AWS_SECRET_ACCESS_KEY AWS_SECRET_ACCESS_KEY_FILE
  fi

  # SFTP: configurația ssh în HOME (tmpfs), cu cheia și known_hosts fixate.
  if [ -n "${FINET_BACKUP_SFTP_KEY_FILE-}" ] || [ -n "${FINET_BACKUP_SFTP_KNOWN_HOSTS_FILE-}" ]; then
    require_file FINET_BACKUP_SFTP_KEY_FILE "${FINET_BACKUP_SFTP_KEY_FILE-}"
    require_file FINET_BACKUP_SFTP_KNOWN_HOSTS_FILE "${FINET_BACKUP_SFTP_KNOWN_HOSTS_FILE-}"
    [ -n "${HOME-}" ] && [ -d "$HOME" ] && [ -w "$HOME" ] || die 2 "HOME trebuie să fie un director în care se poate scrie (tmpfs)"
    umask 077
    mkdir -p "$HOME/.ssh"
    {
      echo "Host *"
      echo "  IdentityFile $FINET_BACKUP_SFTP_KEY_FILE"
      echo "  IdentitiesOnly yes"
      echo "  UserKnownHostsFile $FINET_BACKUP_SFTP_KNOWN_HOSTS_FILE"
      echo "  StrictHostKeyChecking yes"
      echo "  BatchMode yes"
      echo "  ServerAliveInterval 60"
    } > "$HOME/.ssh/config"
  fi
}

# Destinația `rclone:<remote>:<cale>` (Google Drive pe acest VPS, docs/BACKUP.md): restic pornește
# `rclone serve restic --stdio` cu configurația din RCLONE_CONFIG. Fișierul conține tokenul OAuth
# al remote-ului: trebuie să existe, să nu fie gol și să NU poată fi citit de grup/alții (0400 sau
# 0600). Conținutul nu se afișează. RCLONE_CONFIG fără repository rclone e refuzat (configurație
# amestecată din greșeală).
check_rclone_config() {
  _repo=${RESTIC_REPOSITORY-}
  if [ -z "$_repo" ] && [ -n "${RESTIC_REPOSITORY_FILE-}" ]; then
    _repo=$(head -n 1 "$RESTIC_REPOSITORY_FILE" | tr -d '\r')
  fi
  case "$_repo" in
    rclone:*)
      printf '%s' "$_repo" | grep -Eq '^rclone:[A-Za-z0-9_-][A-Za-z0-9_. -]*:[^[:space:]]*$' ||
        die 2 "repository-ul rclone trebuie să fie rclone:<remote>:<cale>"
      require_file RCLONE_CONFIG "${RCLONE_CONFIG-}"
      _mode=$(stat -L -c '%a' "$RCLONE_CONFIG")
      _mode=$(printf '%04d' "$_mode")
      _go=${_mode#??}
      [ "$_go" = 00 ] || die 2 "RCLONE_CONFIG: fișierul poate fi citit de grup/alții (mod $_mode; cere 0400 sau 0600)"
      command -v rclone > /dev/null 2>&1 || die 2 "rclone lipsește din imagine"
      ;;
    *)
      [ -z "${RCLONE_CONFIG-}" ] || die 2 "RCLONE_CONFIG e setat, dar repository-ul nu e rclone:"
      ;;
  esac
  unset _repo _mode _go
}

# Configurația libpq pentru o secțiune dintr-un fișier de servicii: verifică fișierul și, în
# producție, TLS-ul (sslmode=verify-full, ca src/lib/config.ts). FINET_BACKUP_INSECURE_DB=1
# dezactivează DOAR verificarea TLS, pentru Postgres-ul efemer din teste.
check_pg_service() { # variabila cu calea, secțiunea
  eval "_svc_file=\${$1-}"
  require_file "$1" "$_svc_file"
  printf '%s' "$2" | grep -Eq '^[a-z][a-z0-9_]{0,62}$' || die 2 "numele serviciului libpq e invalid"
  # Liniile secțiunii [nume], până la următoarea secțiune.
  _section=$(awk -v s="$2" '
    /^[[:space:]]*\[/ { line = $0; gsub(/[[:space:]]/, "", line); inside = (line == "[" s "]"); next }
    inside { print }' "$_svc_file")
  [ -n "$_section" ] || die 2 "$1: secțiunea [$2] lipsește"
  if [ "${FINET_BACKUP_INSECURE_DB:-0}" != 1 ]; then
    printf '%s\n' "$_section" | grep -Eq '^[[:space:]]*sslmode[[:space:]]*=[[:space:]]*verify-full[[:space:]]*$' ||
      die 2 "$1: secțiunea [$2] trebuie să aibă sslmode=verify-full (și sslrootcert)"
  fi
  unset _section _svc_file
}
