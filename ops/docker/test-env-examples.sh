#!/bin/sh
# Verifică fișierele de deploy din ops/docker/ (rulare: sh ops/docker/test-env-examples.sh,
# inclus în `pnpm test:ops`; nu cere docker):
#  1. Fișierele exemplu de mediu (*.env.example din ops/docker/) NU conțin nicio variabilă
#     secretă activă (constatarea N1). Lista secretelor vine din marcajele `# secret` din
#     .env.example de la rădăcină, deci nu se desincronizează.
#  2. docker-compose.yml nu pune niciun secret în `environment` (nici `NUME:`, nici `NUME=`),
#     doar variabilele `NUME_FILE`.
#  3. Regula pe rol (F1, src/lib/config.ts), verificată pe compose: fiecare serviciu primește
#     DOAR `_FILE`-ul și secretul (`secrets:`) URL-ului său de bază de date; tokenul de
#     sănătate și secretul Better Auth sunt doar ale lui finet-web.
# Se uită doar la liniile active (nu la comentarii).
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/../.." && pwd)
COMPOSE="$DIR/docker-compose.yml"
FAILS=0

fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
ok() { echo "ok: $1"; }

# --- lista secretelor din .env.example (aceeași regulă ca scripts/scan-client-secrets.mjs:
# rândul `# secret`, urmat de `NUME=` sau `# NUME=`) ---------------------------------------
SECRETS=$(awk '
  /^[[:space:]]*#[[:space:]]*secret[[:space:]]*$/ { marked = 1; next }
  {
    line = $0; sub(/^[[:space:]]+/, "", line)
    if (marked) {
      sub(/^#[[:space:]]*/, "", line)
      if (match(line, /^[A-Z][A-Z0-9_]*=/)) print substr(line, 1, RLENGTH - 1)
    }
    marked = 0
  }' "$ROOT/.env.example" | sort -u)

if [ -z "$SECRETS" ]; then
  fail ".env.example nu are nicio variabilă marcată # secret"
else
  for required in DATABASE_URL WORKER_DATABASE_URL MIGRATOR_DATABASE_URL HEALTH_TOKEN BETTER_AUTH_SECRET; do
    if echo "$SECRETS" | grep -qx "$required"; then ok "$required e marcată secret"; else fail "$required nu e marcată # secret în .env.example"; fi
  done
fi

# --- 1. fișierele exemplu fără secrete active ------------------------------------------------
for file in "$DIR"/*.env.example; do
  name=$(basename "$file")
  found=0
  for secret in $SECRETS; do
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?$secret[[:space:]]*=" "$file"; then
      fail "$name conține secretul $secret în clar (se dă ca fișier, prin secrets:)"
      found=1
    fi
  done
  if grep -Eq "^[[:space:]]*(export[[:space:]]+)?FINET_ROLE[[:space:]]*=" "$file"; then
    fail "$name setează FINET_ROLE (îl fixează compose-ul)"; found=1
  fi
  [ "$found" -eq 0 ] && ok "$name fără secrete active și fără FINET_ROLE"
done

# --- 2. compose: niciun secret în environment ------------------------------------------------
if [ ! -r "$COMPOSE" ]; then
  fail "docker-compose.yml lipsește"
else
  found=0
  for secret in $SECRETS; do
    # `NUME: valoare` (map) sau `- NUME=valoare` (listă); `NUME_FILE` e permis.
    if grep -Eq "^[[:space:]]+(-[[:space:]]+)?$secret[[:space:]]*[:=]" "$COMPOSE"; then
      fail "docker-compose.yml pune $secret direct (doar ${secret}_FILE e permis)"; found=1
    fi
  done
  [ "$found" -eq 0 ] && ok "docker-compose.yml fără secrete în environment"
fi

# --- 3. compose: regula pe rol ---------------------------------------------------------------
# Liniile active ale unui serviciu (de la `  <nume>:` sub `services:` până la următorul).
service_block() {
  awk -v svc="$1" '
    /^[^[:space:]#]/ { in_services = ($0 ~ /^services:/); current = ""; next }
    in_services && /^  [a-z][a-z0-9-]*:[[:space:]]*$/ { current = $1; sub(/:$/, "", current); next }
    in_services && current == svc && $0 !~ /^[[:space:]]*#/ { print }
  ' "$COMPOSE"
}

# serviciu, variabila _FILE proprie, secretul propriu
check_role() {
  svc=$1; own_var=$2; own_secret=$3
  block=$(service_block "$svc")
  if [ -z "$block" ]; then fail "serviciul $svc lipsește din compose"; return; fi
  for pair in DATABASE_URL_FILE:finet_database_url \
    WORKER_DATABASE_URL_FILE:finet_worker_database_url \
    MIGRATOR_DATABASE_URL_FILE:finet_migrate_database_url; do
    var=${pair%%:*}; secret=${pair#*:}
    has_var=0; has_secret=0
    echo "$block" | grep -Eq "^[[:space:]]+(-[[:space:]]+)?$var[[:space:]]*[:=]" && has_var=1
    echo "$block" | grep -Eq "^[[:space:]]+-[[:space:]]+$secret[[:space:]]*$|source:[[:space:]]*$secret[[:space:]]*$" && has_secret=1
    if [ "$var" = "$own_var" ]; then
      [ "$has_var" -eq 1 ] && ok "$svc are $var" || fail "$svc nu are $var"
      [ "$has_secret" -eq 1 ] && ok "$svc montează $secret" || fail "$svc nu montează $secret"
    else
      [ "$has_var" -eq 0 ] && ok "$svc fără $var" || fail "$svc are $var (nu e al rolului său)"
      [ "$has_secret" -eq 0 ] && ok "$svc fără secretul $secret" || fail "$svc montează $secret (nu e al rolului său)"
    fi
  done
  echo "$block" | grep -Eq "^[[:space:]]+FINET_ROLE:[[:space:]]*$4[[:space:]]*$" \
    && ok "$svc are FINET_ROLE=$4" || fail "$svc nu are FINET_ROLE=$4"
}

check_role finet-web DATABASE_URL_FILE finet_database_url web
check_role finet-worker WORKER_DATABASE_URL_FILE finet_worker_database_url worker
check_role finet-migrate MIGRATOR_DATABASE_URL_FILE finet_migrate_database_url migrate
# CLI-ul de administrare (F1-B): drepturile aplicației (DATABASE_URL, finet_app).
check_role finet-admin DATABASE_URL_FILE finet_database_url admin

# Tokenul de sănătate e doar al serverului web.
for svc in finet-worker finet-migrate finet-admin; do
  if service_block "$svc" | grep -Eq "finet_health_token|HEALTH_TOKEN_FILE"; then
    fail "$svc primește tokenul de sănătate"
  else
    ok "$svc fără tokenul de sănătate"
  fi
done

# Secretul Better Auth (F1-B): doar serverul web (cookie-uri și tokenuri bearer).
if service_block finet-web | grep -Eq "^[[:space:]]+-[[:space:]]+finet_better_auth_secret[[:space:]]*$" \
  && service_block finet-web | grep -Eq "^[[:space:]]+BETTER_AUTH_SECRET_FILE:"; then
  ok "finet-web primește secretul Better Auth"
else
  fail "finet-web nu primește secretul Better Auth (finet_better_auth_secret + BETTER_AUTH_SECRET_FILE)"
fi
for svc in finet-worker finet-migrate finet-admin; do
  if service_block "$svc" | grep -Eq "finet_better_auth_secret|BETTER_AUTH_SECRET"; then
    fail "$svc primește secretul Better Auth"
  else
    ok "$svc fără secretul Better Auth"
  fi
done

echo
if [ "$FAILS" -eq 0 ]; then echo "env examples: toate verificările au trecut"; else echo "env examples: $FAILS eșecuri"; exit 1; fi
