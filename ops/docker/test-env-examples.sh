#!/bin/sh
# Verifică fișierele exemplu de mediu din ops/docker/: fiecare rol conține DOAR URL-ul lui de
# bază de date (F1, src/lib/config.ts). Se uită doar la variabilele active (nu la comentarii).
# Rulare: sh ops/docker/test-env-examples.sh (inclus în `pnpm test:ops`).
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
FAILS=0

# fișier, variabila care TREBUIE să existe, variabilele interzise...
check() {
  name=$1; file="$DIR/$1"; need=$2; shift 2
  if [ ! -r "$file" ]; then
    echo "FAIL: $name lipsește"; FAILS=$((FAILS + 1)); return
  fi
  if grep -Eq "^[[:space:]]*$need=" "$file"; then
    echo "ok: $name conține $need"
  else
    echo "FAIL: $name nu conține $need"; FAILS=$((FAILS + 1))
  fi
  for bad in "$@"; do
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?$bad=" "$file"; then
      echo "FAIL: $name conține $bad (nu e al acestui rol)"; FAILS=$((FAILS + 1))
    else
      echo "ok: $name fără $bad"
    fi
  done
}

check finet.env.example DATABASE_URL MIGRATOR_DATABASE_URL WORKER_DATABASE_URL FINET_ROLE
check finet.worker.env.example WORKER_DATABASE_URL DATABASE_URL MIGRATOR_DATABASE_URL FINET_ROLE
check finet.migrate.env.example MIGRATOR_DATABASE_URL DATABASE_URL WORKER_DATABASE_URL FINET_ROLE

echo
if [ "$FAILS" -eq 0 ]; then echo "env examples: toate verificările au trecut"; else echo "env examples: $FAILS eșecuri"; exit 1; fi
