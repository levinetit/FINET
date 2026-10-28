#!/bin/sh
# FINET — punctul de intrare al imaginii de backup (serviciul compose `finet-backup`).
#
#   backup                  backup-ul complet (backup.sh): dump + fișiere + retenție + verificare
#   restore --yes [...]     restaurarea (restore.sh; docs/BACKUP.md, „Restaurare”)
#   init                    inițializează repository-ul restic (o singură dată, de operator)
#   snapshots               lista instantaneelor FINET
#   check [--read-data]     verificarea repository-ului (cu --read-data: toate datele)
#   restic ARG...           orice altă comandă restic, cu aceeași configurație (secretele din
#                           fișiere); parola și cheile nu se dau niciodată ca argumente
set -eu

LIB_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=ops/backup/lib.sh
. "$LIB_DIR/lib.sh"

# HOME și cache-ul restic stau pe tmpfs (rootfs read-only), gol la fiecare pornire.
[ -z "${HOME-}" ] || mkdir -p "$HOME" 2> /dev/null || true

cmd=${1:-}
[ $# -gt 0 ] && shift

case "$cmd" in
  backup) exec sh "$LIB_DIR/backup.sh" "$@" ;;
  restore) exec sh "$LIB_DIR/restore.sh" "$@" ;;
  init)
    load_restic_config
    exec restic init ;;
  snapshots)
    load_restic_config
    exec restic snapshots --host "$FINET_BACKUP_HOST" "$@" ;;
  check)
    load_restic_config
    if [ "${1:-}" = --read-data ]; then exec restic check --read-data; fi
    exec restic check ;;
  restic)
    load_restic_config
    exec restic "$@" ;;
  *)
    echo "Utilizare: (backup | restore --yes [...] | init | snapshots | check [--read-data] | restic ARG...)" >&2
    exit 2 ;;
esac
