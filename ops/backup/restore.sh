#!/bin/sh
# FINET — restaurarea din backup-ul restic (docs/BACKUP.md, „Restaurare”). Aceeași procedură o
# rulează testul automat (ops/backup/restore-test.sh), deci ce e documentat e ce e testat.
#
# Utilizare (în imaginea de backup):
#   restore.sh --yes [--snapshot ID] [--storage-target DIR] [--no-db]
#
#   --snapshot ID         instantaneul bazei (implicit cel mai recent cu eticheta finet-db)
#   --storage-target DIR  restaurează și fișierele (cel mai recent instantaneu finet-storage)
#                         în DIR (apar sub DIR/data/storage); nu suprascrie storage-ul viu
#   --no-db               doar fișierele
#   --yes                 confirmarea explicită (fără ea, scriptul nu face nimic)
#
# Baza țintă vine din FINET_RESTORE_PGSERVICEFILE, secțiunea FINET_RESTORE_PGSERVICE (implicit
# finet_restore), cu rolul `finet_migrator` (proprietarul schemei). Precondiții (le verifică):
#   - schema `finet` EXISTĂ și e GOALĂ: o creează operatorul cu ops/supabase/roles.sql (pe un
#     proiect nou) sau cu `drop schema finet cascade` + recrearea din roles.sql (decizia lui);
#     migratorul nu are CREATE pe bază, deci nu o poate crea singur;
#   - rolurile `finet_app` și `finet_backup` există (GRANT-urile din dump le numesc).
# Restaurarea: intrarea `SCHEMA finet` e scoasă din lista dump-ului (schema există deja), restul
# (tabele, date, secvențe, funcții, RLS ENABLE+FORCE, politici, GRANT-uri, privilegii implicite)
# se aplică într-o singură tranzacție, cu oprire la prima eroare. Fără --no-owner/--no-acl:
# proprietarul și drepturile lui `finet_app` trebuie să revină exact.

set -eu

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=ops/backup/lib.sh
. "$LIB_DIR/lib.sh"

SNAPSHOT=latest
STORAGE_TARGET=
DO_DB=1
CONFIRMED=0

usage() {
  echo "Utilizare: restore.sh --yes [--snapshot ID] [--storage-target DIR] [--no-db]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRMED=1; shift ;;
    --snapshot) [ $# -ge 2 ] || usage; SNAPSHOT=$2; shift 2 ;;
    --storage-target) [ $# -ge 2 ] || usage; STORAGE_TARGET=$2; shift 2 ;;
    --no-db) DO_DB=0; shift ;;
    *) usage ;;
  esac
done

[ "$CONFIRMED" = 1 ] || die 2 "restaurarea cere --yes (citește întâi docs/BACKUP.md, „Restaurare”)"
printf '%s' "$SNAPSHOT" | grep -Eq '^(latest|[0-9a-f]{8,64})$' || die 2 "--snapshot: ID invalid"
[ "$DO_DB" = 1 ] || [ -n "$STORAGE_TARGET" ] || die 2 "nimic de restaurat (--no-db fără --storage-target)"

load_restic_config
restic cat config > /dev/null || die 1 "repository-ul nu se deschide (adresă, acces sau parolă greșită)"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# `restic dump` într-un pipeline: codul lui se păstrează într-un fișier (sh nu are pipefail).
dump_db() {
  _rc=0
  { restic dump --host "$FINET_BACKUP_HOST" --tag "$FINET_DB_TAG" "$SNAPSHOT" "/$FINET_DUMP_NAME"; echo $? > "$WORK/dump.rc"; } |
    "$@" || _rc=$?
  [ "$(cat "$WORK/dump.rc")" = 0 ] || die 1 "restic dump a eșuat (instantaneu inexistent?)"
  [ "$_rc" = 0 ] || die 1 "$1 a eșuat (cod $_rc)"
}

if [ "$DO_DB" = 1 ]; then
  RESTORE_SERVICE=${FINET_RESTORE_PGSERVICE:-finet_restore}
  check_pg_service FINET_RESTORE_PGSERVICEFILE "$RESTORE_SERVICE"
  # Conexiunea țintă doar prin fișierul de servicii (fără parolă în argumente). Variabilele
  # libpq ale backup-ului nu trebuie să ajungă la psql/pg_restore.
  unset PGSERVICE PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE
  export PGSERVICEFILE="$FINET_RESTORE_PGSERVICEFILE"
  TARGET="service=$RESTORE_SERVICE"

  log "verific baza țintă"
  state=$(psql "$TARGET" -X -w -At -v ON_ERROR_STOP=1 -c "
    select case when n.oid is null then 'lipsă'
           else ((select count(*) from pg_class where relnamespace = n.oid)
                 + (select count(*) from pg_proc where pronamespace = n.oid))::text
                || ':' || pg_get_userbyid(n.nspowner) || ':' || current_user end
      from (select 1) x left join pg_namespace n on n.nspname = 'finet'") ||
    die 1 "nu mă pot conecta la baza țintă"
  [ "$state" != lipsă ] || die 1 "schema finet lipsește în baza țintă: creeaz-o întâi (ops/supabase/roles.sql)"
  objects=${state%%:*}
  rest=${state#*:}
  owner=${rest%%:*}
  me=${rest#*:}
  [ "$objects" = 0 ] || die 1 "schema finet nu e goală în baza țintă ($objects obiecte); refuz să suprascriu"
  [ "$owner" = "$me" ] || die 1 "restaurarea se face ca proprietarul schemei ($owner), nu ca $me"

  log "citesc lista dump-ului (instantaneu $SNAPSHOT)"
  dump_db pg_restore --list > "$WORK/toc"
  # Intrarea `SCHEMA - finet` (schema există deja); restul listei, în ordinea originală.
  grep -Ev '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - finet( |$)' "$WORK/toc" > "$WORK/toc.filtered"
  [ "$(wc -l < "$WORK/toc")" -gt "$(wc -l < "$WORK/toc.filtered")" ] ||
    die 1 "lista dump-ului nu conține schema finet (dump greșit?)"

  log "restaurez schema finet (o singură tranzacție)"
  dump_db pg_restore --no-password --single-transaction --exit-on-error \
    --use-list="$WORK/toc.filtered" --dbname="$TARGET"

  log "verificare: tabele, rânduri și RLS după restaurare"
  psql "$TARGET" -X -w -At -v ON_ERROR_STOP=1 -c "
    select 'tabele=' || count(*)
           || ' cu_rls_force=' || count(*) filter (where c.relrowsecurity and c.relforcerowsecurity)
      from pg_class c where c.relnamespace = 'finet'::regnamespace and c.relkind in ('r', 'p')" >&2
fi

if [ -n "$STORAGE_TARGET" ]; then
  [ -d "$STORAGE_TARGET" ] && [ -w "$STORAGE_TARGET" ] || die 2 "--storage-target: directorul nu există sau nu se poate scrie"
  log "restaurez fișierele în $STORAGE_TARGET"
  restic restore --host "$FINET_BACKUP_HOST" --tag "$FINET_STORAGE_TAG" latest --target "$STORAGE_TARGET"
fi

log "restaurare încheiată"
