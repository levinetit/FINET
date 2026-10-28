#!/bin/sh
# FINET — rularea zilnică a backup-ului, pe HOST, din cron-ul root (docs/BACKUP.md, „Programare”):
#   sudo crontab -e      (NU `crontab -`: suprascrie tot crontab-ul)
#   40 3 * * * /bin/sh /srv/finet/repo/ops/backup/run-backup.sh >> /var/log/finet-backup.log 2>&1
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
