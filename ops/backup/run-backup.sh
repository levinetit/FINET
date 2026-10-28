#!/bin/sh
# FINET — rularea zilnică a backup-ului, pe HOST, din cron-ul root (docs/BACKUP.md, „Programare”):
#   sudo crontab -e      (NU `crontab -`: suprascrie tot crontab-ul)
#   40 3 * * * /bin/sh /srv/finet/src/ops/backup/run-backup.sh >> /var/log/finet-backup.log 2>&1
# Checkout-ul (/srv/finet/src, docs/INFRA.md) trebuie să fie root:root, fără drept de scriere
# pentru grup/alții; scriptul verifică asta la fiecare rulare și refuză altfel (LOW-1).
#
# Pornește containerul one-shot `finet-backup` (docker compose run --rm) și, la ORICE eșec
# (backup eșuat, imagine lipsă, container oprit de OOM = 137, timeout, altă rulare în curs),
# trimite o alertă prin ops/notify/notify.sh (Telegram sau email, master prompt 3.1). Alerta
# pleacă de pe host, deci prinde și eșecurile pe care containerul nu le-ar putea raporta, iar
# tokenul botului nu intră în niciun container.
#
# Anti-flood: aceeași eroare (etapă + cod) cel mult o alertă pe oră (FINET_BACKUP_ALERT_INTERVAL);
# o eroare diferită pleacă imediat. Opțional, un mesaj de succes săptămânal (implicit duminica),
# ca o tăcere lungă să nu ascundă un cron oprit.
#
# Configurația: fișierul opțional FINET_BACKUP_HOST_ENV (implicit /srv/finet/env/backup-host.env,
# root 600; model ops/backup/backup-host.env.example). Se citesc DOAR cheile cunoscute, fără
# `source`. Nu conține secrete (secretele stau în /srv/finet/secrets și în notify.env).
#
# Coduri de ieșire: codul backup-ului (0 = reușit); 2 = configurație invalidă.

set -u

PROG=run-backup.sh
DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$DIR/../.." && pwd)

HOST_ENV=${FINET_BACKUP_HOST_ENV:-/srv/finet/env/backup-host.env}

load_host_env() {
  [ -r "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      FINET_BACKUP_DEST=*|FINET_COMPOSE_ENV=*|FINET_NOTIFY_ENV=*|FINET_BACKUP_STATE_DIR=*|\
      FINET_BACKUP_ALERT_INTERVAL=*|FINET_BACKUP_WEEKLY_OK_DAY=*|FINET_BACKUP_TIMEOUT=*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    # Mediul are prioritate (testele și rulările manuale).
    eval "current=\${$key-}"
    if [ -z "$current" ]; then
      eval "$key=\$value"
    fi
  done < "$1"
}
load_host_env "$HOST_ENV"

DEST=${FINET_BACKUP_DEST:-s3}
COMPOSE_ENV=${FINET_COMPOSE_ENV:-/srv/finet/compose/compose.env}
NOTIFY_ENV=${FINET_NOTIFY_ENV:-/srv/finet/env/notify.env}
STATE_DIR=${FINET_BACKUP_STATE_DIR:-/srv/finet/backup-state}
ALERT_INTERVAL=${FINET_BACKUP_ALERT_INTERVAL:-3600}
WEEKLY_OK_DAY=${FINET_BACKUP_WEEKLY_OK_DAY:-7}
TIMEOUT=${FINET_BACKUP_TIMEOUT:-3h}
# Pentru teste: comanda docker, comanda de notificare și „acum” (epoch) pot fi înlocuite.
DOCKER=${FINET_BACKUP_DOCKER:-docker}
NOTIFY=${FINET_BACKUP_NOTIFY_CMD:-$REPO_ROOT/ops/notify/notify.sh}
NOW=${FINET_BACKUP_NOW:-$(date +%s)}
TODAY_DOW=${FINET_BACKUP_DOW:-$(date +%u)}
HOSTNAME_V=$(hostname 2> /dev/null || echo necunoscut)

log() { printf '%s %s: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$PROG" "$*"; }

case "$DEST" in s3|sftp|local) ;; *) log "FINET_BACKUP_DEST trebuie să fie s3, sftp sau local"; exit 2 ;; esac
for v in "$ALERT_INTERVAL" "$NOW"; do
  printf '%s' "$v" | grep -Eq '^[0-9]+$' || { log "FINET_BACKUP_ALERT_INTERVAL/NOW invalid"; exit 2; }
done
printf '%s' "$WEEKLY_OK_DAY" | grep -Eq '^[0-7]$' || { log "FINET_BACKUP_WEEKLY_OK_DAY trebuie să fie 0-7"; exit 2; }
printf '%s' "$TIMEOUT" | grep -Eq '^[0-9]+[smh]?$' || { log "FINET_BACKUP_TIMEOUT invalid"; exit 2; }

umask 077
mkdir -p "$STATE_DIR" || { log "nu pot crea $STATE_DIR"; exit 2; }

# `sh` explicit: alerta nu depinde de bitul de execuție al fișierelor din checkout.
send() { # mesaj
  if [ -r "$NOTIFY_ENV" ]; then
    sh "$NOTIFY" --env-file "$NOTIFY_ENV" "$1" || log "notificarea a eșuat (mesajul rămâne doar în log)"
  else
    sh "$NOTIFY" "$1" || log "notificarea a eșuat (fișierul $NOTIFY_ENV lipsește?)"
  fi
}

alert_failure() { # etapă, cod
  key="$1:$2"
  last_key=
  last_time=0
  if [ -r "$STATE_DIR/last-alert" ]; then
    read -r last_key last_time < "$STATE_DIR/last-alert" || true
    printf '%s' "$last_time" | grep -Eq '^[0-9]+$' || last_time=0
  fi
  if [ "$key" = "$last_key" ] && [ $((NOW - last_time)) -lt "$ALERT_INTERVAL" ]; then
    log "alertă suprimată (aceeași eroare $key în ultimele ${ALERT_INTERVAL}s)"
    return 0
  fi
  printf '%s %s\n' "$key" "$NOW" > "$STATE_DIR/last-alert"
  send "FINET: backup-ul a EȘUAT pe $HOSTNAME_V (etapa $1, cod $2). Detalii: /var/log/finet-backup.log. Fără backup reușit nu se introduc date noi importante."
}

# Lanțul de încredere (revizuirea Fazei 3, LOW-1): scriptul rulează ca root din cron, iar
# fișierele pe care le execută sau citește (el însuși, notify.sh, compose-ul și suprapunerea,
# compose.env, care alege imaginea pornită de root, backup-host.env, notify.env) și directoarele
# care le conțin, până la /, trebuie să aparțină lui root (sau utilizatorului care rulează) și să
# NU poată fi scrise de grup/alții (un director cu sticky bit, ca /tmp, e acceptat). Altfel
# oricine poate scrie în checkout ar executa cod ca root. Nimic nu se `source`-ază: fișierele de
# mediu se citesc doar pe chei cunoscute.
ME_UID=$(id -u)
untrusted() { # cale; 0 = nesigur
  [ -e "$1" ] || return 1
  set -- "$1" "$(stat -c '%u' "$1")" "$(stat -c '%a' "$1")"
  [ "$2" = 0 ] || [ "$2" = "$ME_UID" ] || return 0
  _mode=$3
  [ "${#_mode}" -eq 4 ] && _sticky=$(( ${_mode%???} & 1 )) && _mode=${_mode#?} || _sticky=0
  _go=${_mode#?}
  _g=${_go%?}
  _o=${_go#?}
  if [ $(( _g & 2 )) -ne 0 ] || [ $(( _o & 2 )) -ne 0 ]; then
    [ -d "$1" ] && [ "$_sticky" = 1 ] && return 1
    return 0
  fi
  return 1
}
check_trust() {
  _bad=
  for f in "$DIR/run-backup.sh" "$NOTIFY" "$REPO_ROOT/ops/docker/docker-compose.yml" \
    "$DIR/compose.$DEST.yml" "$COMPOSE_ENV" "$HOST_ENV" "$NOTIFY_ENV"; do
    untrusted "$f" && _bad="$_bad $f"
    _d=$(dirname "$f")
    while :; do
      untrusted "$_d" && _bad="$_bad $_d/"
      [ "$_d" = / ] && break
      _d=$(dirname "$_d")
    done
  done
  [ -z "$_bad" ] && return 0
  # shellcheck disable=SC2086 # $_bad e o listă de căi separate prin spațiu
  log "refuz: fișiere sau directoare care pot fi scrise de alți utilizatori:$(printf '%s\n' $_bad | sort -u | tr '\n' ' ')"
  return 1
}
if ! check_trust; then
  # Alerta pleacă doar dacă notify.sh însuși e sigur.
  if ! untrusted "$NOTIFY" && ! untrusted "$(dirname "$NOTIFY")"; then
    alert_failure permisiuni 2
  fi
  exit 2
fi

# O singură rulare o dată: blocare pe descriptorul 9, ținută până la ieșire (fără flock pe
# host, rularea continuă fără blocare).
if command -v flock > /dev/null 2>&1; then
  exec 9> "$STATE_DIR/run.lock"
  if ! flock -n 9; then
    log "altă rulare a backup-ului e încă în curs"
    alert_failure lock 75
    exit 75
  fi
fi

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT INT TERM

set -- -f "$REPO_ROOT/ops/docker/docker-compose.yml" -f "$DIR/compose.$DEST.yml" \
  --env-file "$COMPOSE_ENV" --profile backup run --rm -T finet-backup backup

log "pornesc backup-ul (destinația $DEST)"
rc=0
if command -v timeout > /dev/null 2>&1 && [ "$DOCKER" = docker ]; then
  timeout "$TIMEOUT" "$DOCKER" compose "$@" > "$OUT" 2>&1 || rc=$?
else
  "$DOCKER" compose "$@" > "$OUT" 2>&1 || rc=$?
fi
cat "$OUT"

if [ "$rc" -eq 0 ]; then
  printf '%s\n' "$NOW" > "$STATE_DIR/last-success"
  rm -f "$STATE_DIR/last-alert"
  log "backup reușit"
  if [ "$WEEKLY_OK_DAY" != 0 ] && [ "$TODAY_DOW" = "$WEEKLY_OK_DAY" ]; then
    send "FINET: backup-ul săptămânal e în regulă pe $HOSTNAME_V (ultimul reușit: $(date -d "@$NOW" '+%Y-%m-%d %H:%M' 2> /dev/null || echo "$NOW"))."
  fi
  exit 0
fi

# Etapa: ultima linie FINET_BACKUP_STAGE=... din container; altfel cauza după cod.
stage=$(sed -n 's/^FINET_BACKUP_STAGE=\([a-z]*\)$/\1/p' "$OUT" | tail -n 1)
case "$rc" in
  124) stage=timeout ;;
  137) stage=${stage:-container}-oom-sau-kill ;;
esac
[ -n "$stage" ] || stage=container
log "backup EȘUAT (etapa $stage, cod $rc)"
alert_failure "$stage" "$rc"
exit "$rc"
