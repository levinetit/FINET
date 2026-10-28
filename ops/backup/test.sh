#!/bin/sh
# Teste pentru scripturile de backup, FĂRĂ rețea, docker, restic sau Postgres (inclus în
# `pnpm test:ops`). Testul complet de backup + restaurare e ops/backup/restore-test.sh (job-ul CI
# `backup-restore`). Rulare: sh ops/backup/test.sh
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILS=0

ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
check() { # descriere, cod așteptat, cod primit, text așteptat, ieșire
  if [ "$2" != "$3" ]; then fail "$1 (cod $3, așteptat $2)"; printf '%s\n' "$5" | tail -3 | sed 's/^/    /'; return; fi
  if [ -n "$4" ] && ! printf '%s' "$5" | grep -Fq -- "$4"; then fail "$1 (lipsește „$4”)"; return; fi
  ok "$1"
}
clean_env() { env -i PATH="$PATH" HOME="$TMP/home" "$@"; }
mkdir -p "$TMP/home"

# --- sintaxă și shellcheck -------------------------------------------------------------------
for f in "$DIR"/*.sh; do
  if sh -n "$f"; then ok "sintaxă $(basename "$f")"; else fail "sintaxă $(basename "$f")"; fi
done
if command -v shellcheck > /dev/null 2>&1; then
  if shellcheck -s sh -x "$DIR"/*.sh; then ok "shellcheck ops/backup/*.sh"; else fail "shellcheck ops/backup/*.sh"; fi
else
  echo "skip: shellcheck lipsește (rulează în CI)"
fi

# --- reguli statice pe backup.sh -------------------------------------------------------------
active() { grep -Ev '^[[:space:]]*#' "$1"; }
active "$DIR/backup.sh" | grep -q -- '--stdin-from-command' && ok "backup.sh: dump prin --stdin-from-command (fără pipe fără pipefail)" ||
  fail "backup.sh nu folosește --stdin-from-command"
active "$DIR/backup.sh" | grep -q -- '--enable-row-security' && fail "backup.sh folosește --enable-row-security (dump incomplet)" ||
  ok "backup.sh fără --enable-row-security"
if active "$DIR/backup.sh" "$DIR/restore.sh" 2> /dev/null | grep -Eq 'postgres(ql)?://|--password|PGPASSWORD='; then
  fail "un script pune URL-ul/parola bazei în argumente"
else
  ok "backup.sh/restore.sh fără URL sau parolă în argumente (doar fișier de servicii libpq)"
fi
grep -Eq '^[[:space:]]*set[[:space:]]+-[a-z]*x' "$DIR"/*.sh && fail "un script folosește set -x" || ok "fără set -x"
for opt in --no-owner --no-acl --no-privileges -O -x; do
  if active "$DIR/restore.sh" | grep -Eq "pg_restore[^|]*[[:space:]]$opt([[:space:]]|$)"; then fail "restore.sh folosește $opt"; fi
done
ok "restore.sh păstrează proprietarul și ACL-urile"
grep -q -- '--keep-daily 7 --keep-weekly 4 --keep-monthly 12' "$DIR/lib.sh" && ok "retenția 7/4/12 în lib.sh" || fail "retenția din lib.sh nu e 7/4/12"

# --- configurația backup.sh (oprire înainte de restic) ----------------------------------------
printf 'parola-de-test-fictiva\n' > "$TMP/pw"
printf '/tmp/repo-inexistent\n' > "$TMP/repo"
printf '[finet_backup]\nhost=db.exemplu.invalid\nuser=finet_backup\npassword=fictiva-secreta-123\nsslmode=require\n' > "$TMP/svc-insecure"
printf '[alta]\nhost=x\n[finet_backup]\nhost=db.exemplu.invalid\nsslmode=verify-full\nsslrootcert=/run/finet/ca/ca.crt\n' > "$TMP/svc-ok"

out=$(clean_env sh "$DIR/backup.sh" 2>&1); check "backup.sh fără configurație → 2" 2 $? "RESTIC_PASSWORD_FILE nu e setat" "$out"
out=$(clean_env RESTIC_PASSWORD=x sh "$DIR/backup.sh" 2>&1); check "RESTIC_PASSWORD direct → 2" 2 $? "folosește RESTIC_PASSWORD_FILE" "$out"
out=$(clean_env RESTIC_PASSWORD_FILE="$TMP/pw" RESTIC_REPOSITORY_FILE="$TMP/repo" AWS_ACCESS_KEY_ID=x sh "$DIR/backup.sh" 2>&1)
check "cheie S3 directă în mediu → 2" 2 $? "folosește AWS_ACCESS_KEY_ID_FILE" "$out"
out=$(clean_env RESTIC_PASSWORD_FILE="$TMP/pw" RESTIC_REPOSITORY_FILE="$TMP/repo" AWS_ACCESS_KEY_ID_FILE="$TMP/pw" sh "$DIR/backup.sh" 2>&1)
check "doar una dintre cheile S3 → 2" 2 $? "AWS_SECRET_ACCESS_KEY_FILE nu e setat" "$out"
: > "$TMP/empty"
out=$(clean_env RESTIC_PASSWORD_FILE="$TMP/empty" RESTIC_REPOSITORY_FILE="$TMP/repo" sh "$DIR/backup.sh" 2>&1)
check "parola restic goală → 2" 2 $? "fișierul e gol" "$out"
out=$(clean_env RESTIC_PASSWORD_FILE="$TMP/pw" RESTIC_REPOSITORY_FILE="$TMP/repo" PGSERVICEFILE="$TMP/svc-insecure" sh "$DIR/backup.sh" 2>&1)
check "fișier de servicii fără sslmode=verify-full → 2" 2 $? "sslmode=verify-full" "$out"
case "$out" in *fictiva-secreta-123*|*parola-de-test-fictiva*) fail "un secret apare în mesajul de eroare" ;; *) ok "mesajele de eroare fără secrete" ;; esac
out=$(clean_env RESTIC_PASSWORD_FILE="$TMP/pw" RESTIC_REPOSITORY_FILE="$TMP/repo" PGSERVICEFILE="$TMP/svc-ok" PGSERVICE=lipsa sh "$DIR/backup.sh" 2>&1)
check "secțiune libpq lipsă → 2" 2 $? "secțiunea [lipsa] lipsește" "$out"
out=$(clean_env RESTIC_PASSWORD_FILE="$TMP/pw" RESTIC_REPOSITORY_FILE="$TMP/repo" PGSERVICEFILE="$TMP/svc-ok" FINET_BACKUP_CHECK_DATA_DAY=9 sh "$DIR/backup.sh" 2>&1)
check "FINET_BACKUP_CHECK_DATA_DAY invalid → 2" 2 $? "0-7" "$out"
check "etapa anunțată pentru run-backup.sh" 0 0 "FINET_BACKUP_STAGE=config" "$out"
out=$(clean_env RESTIC_PASSWORD_FILE="$TMP/pw" RESTIC_REPOSITORY_FILE="$TMP/repo" FINET_BACKUP_SFTP_KEY_FILE="$TMP/pw" sh "$DIR/backup.sh" 2>&1)
check "SFTP fără known_hosts → 2 (nu se acceptă chei de server nefixate)" 2 $? "FINET_BACKUP_SFTP_KNOWN_HOSTS_FILE" "$out"

# --- restore.sh și entrypoint.sh ---------------------------------------------------------------
out=$(clean_env sh "$DIR/restore.sh" 2>&1); check "restore.sh fără --yes → 2" 2 $? "cere --yes" "$out"
out=$(clean_env sh "$DIR/restore.sh" --yes --snapshot 'latest;rm' 2>&1); check "restore.sh cu ID invalid → 2" 2 $? "ID invalid" "$out"
out=$(clean_env sh "$DIR/restore.sh" --yes 2>&1); check "restore.sh --yes fără configurație → 2" 2 $? "RESTIC_PASSWORD_FILE" "$out"
out=$(clean_env sh "$DIR/entrypoint.sh" necunoscut 2>&1); check "entrypoint: comandă necunoscută → 2" 2 $? "Utilizare" "$out"

# --- run-backup.sh: notificare la eșec, anti-flood, succes săptămânal -------------------------
STATE="$TMP/state"
NOTES="$TMP/notes"
cat > "$TMP/fake-docker" << 'EOF'
#!/bin/sh
# docker fals: imită `docker compose run`; FAKE_RC = codul, FAKE_STAGE = ultima etapă.
echo "argumente: $*"
[ -n "${FAKE_STAGE-}" ] && echo "FINET_BACKUP_STAGE=$FAKE_STAGE"
[ -n "${FAKE_SLEEP-}" ] && sleep "$FAKE_SLEEP"
exit "${FAKE_RC:-0}"
EOF
cat > "$TMP/fake-notify" << EOF
#!/bin/sh
# notify.sh fals: notează mesajul.
[ "\$1" = --env-file ] && shift 2
printf '%s\n' "\$*" >> "$NOTES"
EOF
chmod +x "$TMP/fake-docker" "$TMP/fake-notify"
: > "$NOTES"
rb() { # epoch, ziua, apoi variabile FAKE_*
  _now=$1; _dow=$2; shift 2
  env -i PATH="$PATH" FINET_BACKUP_HOST_ENV=/nu/exista FINET_BACKUP_STATE_DIR="$STATE" \
    FINET_BACKUP_DOCKER="$TMP/fake-docker" FINET_BACKUP_NOTIFY_CMD="$TMP/fake-notify" \
    FINET_NOTIFY_ENV="$TMP/notify.env" FINET_BACKUP_NOW="$_now" FINET_BACKUP_DOW="$_dow" "$@" \
    sh "$DIR/run-backup.sh"
}
notes() { wc -l < "$NOTES" | tr -d ' '; }

out=$(rb 1000000 3 FAKE_RC=1 FAKE_STAGE=dump 2>&1); check "eșec → codul backup-ului" 1 $? "etapa dump, cod 1" "$out"
[ "$(notes)" = 1 ] && grep -q "EȘUAT.*etapa dump, cod 1" "$NOTES" && ok "eșec → o alertă cu etapa" || fail "alerta la eșec ($(notes))"
printf '%s' "$out" | grep -q -- "-f .*ops/backup/compose.s3.yml" && ok "destinația implicită s3 (compose.s3.yml)" || fail "suprapunerea s3 lipsește din comandă"
out=$(rb 1001800 3 FAKE_RC=1 FAKE_STAGE=dump 2>&1); check "aceeași eroare după 30 min" 1 $? "alertă suprimată" "$out"
[ "$(notes)" = 1 ] && ok "anti-flood: fără a doua alertă în aceeași oră" || fail "anti-flood: $(notes) alerte"
out=$(rb 1002000 3 FAKE_RC=3 FAKE_STAGE=storage 2>&1); check "altă eroare" 3 $? "etapa storage" "$out"
[ "$(notes)" = 2 ] && ok "eroare diferită → alertă imediată" || fail "eroare diferită: $(notes) alerte"
out=$(rb 1002100 3 FAKE_RC=1 FAKE_STAGE=dump 2>&1); check "prima eroare revine" 1 $? "" "$out"
out=$(rb 1005700 3 FAKE_RC=1 FAKE_STAGE=dump 2>&1); check "aceeași eroare după > 1 h" 1 $? "" "$out"
[ "$(notes)" = 4 ] && ok "după interval, aceeași eroare alertează din nou" || fail "după interval: $(notes) alerte"
out=$(rb 1006000 3 FAKE_RC=137 2>&1); check "container oprit (137)" 137 $? "container-oom-sau-kill" "$out"
[ "$(notes)" = 5 ] && ok "OOM/kill → alertă" || fail "OOM: $(notes) alerte"
out=$(rb 1007000 3 FAKE_RC=0 2>&1); check "succes în timpul săptămânii" 0 $? "backup reușit" "$out"
[ "$(notes)" = 5 ] && ok "succes în timpul săptămânii: fără mesaj" || fail "succes: $(notes) mesaje"
[ -s "$STATE/last-success" ] && [ ! -e "$STATE/last-alert" ] && ok "succes: last-success scris, anti-flood resetat" || fail "starea după succes"
out=$(rb 1008000 7 FAKE_RC=0 2>&1); check "succes duminica" 0 $? "" "$out"
[ "$(notes)" = 6 ] && grep -q "săptămânal e în regulă" "$NOTES" && ok "succes duminica → mesajul săptămânal" || fail "mesajul săptămânal: $(notes)"
out=$(rb 1009000 3 FINET_BACKUP_DEST=ftp 2>&1); check "destinație invalidă → 2" 2 $? "s3, sftp sau local" "$out"
out=$(rb 1009000 3 FINET_BACKUP_DEST=local FAKE_RC=0 2>&1); check "destinația local" 0 $? "compose.local.yml" "$out"
perm=$(stat -c %a "$STATE" 2> /dev/null || echo necunoscut)
[ "$perm" = 700 ] && ok "directorul de stare e 700" || fail "directorul de stare are $perm"
if command -v flock > /dev/null 2>&1; then
  out=$( (rb 1010000 3 FAKE_RC=0 FAKE_SLEEP=3 > /dev/null 2>&1 &) ; sleep 1; rb 1010001 3 FAKE_RC=0 2>&1)
  check "a doua rulare simultană → 75" 75 $? "încă în curs" "$out"
  grep -q "etapa lock, cod 75" "$NOTES" && ok "rulare simultană → alertă" || fail "rulare simultană fără alertă"
  sleep 3
else
  echo "skip: flock lipsește"
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "backup: toate verificările au trecut"; else echo "backup: $FAILS eșecuri"; exit 1; fi
