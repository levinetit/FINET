#!/bin/sh
# FINET — încercarea upgrade-ului major PostgreSQL (master prompt 3.5, Faza 9; F9-B, ADR 0021).
# Restaurează un dump propriu (același format ca ops/backup/backup.sh: `pg_dump --format=custom`)
# de pe un PostgreSQL VECHI într-un PostgreSQL NOU (versiunea majoră următoare), ca
# `finet_migrator`, și compară amprenta înainte/după. Doar pe servere EFEMERE de test: refuză să
# ruleze fără FINET_UPGRADE_TEST=1. Nu atinge producția și nu schimbă ops/postgres/VERSION.
#
# Rulează într-un mediu cu psql/pg_dump/pg_restore de versiunea NOUĂ (de exemplu imaginea
# `postgres:<nou>-alpine`): pg_dump trebuie să fie cel puțin de versiunea serverului vechi.
#
# Mediu (parole FICTIVE, din ops/postgres/test-bootstrap.sql):
#   FINET_UPGRADE_TEST=1   confirmarea
#   OLD_URL                superuserul serverului VECHI, cu baza deja migrată și cu datele de
#                          control (ops/postgres/upgrade-seed.sql), ex. postgres://finet:x@pg17:5432/finet_upgrade
#   NEW_URL                superuserul serverului NOU, cu o bază GOALĂ (o creează scriptul dacă lipsește)
#   NEW_MIGRATOR_URL       același server/bază NOU, ca finet_migrator
#
# Pașii:
#   1. amprenta pe VECHI (rânduri + conținut pe fiecare tabel din `finet` și `pgboss`, valorile de
#      control „numărul și suma tranzacțiilor pe gospodărie și monedă”, RLS ENABLE+FORCE, politici,
#      funcții, triggere, constrângeri, ACL);
#   2. pg_dump (finet + pgboss) de pe VECHI;
#   3. pe NOU: rolurile și schemele goale (test-bootstrap.sql), pg_restore ca finet_migrator
#      (fără intrările SCHEMA, ca ops/backup/restore.sh), într-o singură tranzacție;
#   4. amprenta pe NOU = amprenta pe VECHI (altfel FAIL);
#   5. finet_app rămâne supus RLS pe NOU (fără context nu vede nicio tranzacție).
# Apoi (în afara scriptului, documentat în docs/INFRA.md §7): runner-ul de migrații pe NOU
# („aplicate acum 0”) și testele Vitest cu DATABASE_URL spre serverul NOU.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
FAILS=0
ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

[ "${FINET_UPGRADE_TEST:-}" = 1 ] || { echo "upgrade-test: setează FINET_UPGRADE_TEST=1 (doar servere efemere)" >&2; exit 2; }
: "${OLD_URL:?OLD_URL lipsește}" "${NEW_URL:?NEW_URL lipsește}" "${NEW_MIGRATOR_URL:?NEW_MIGRATOR_URL lipsește}"
for tool in psql pg_dump pg_restore; do
  command -v "$tool" > /dev/null || { echo "upgrade-test: lipsește $tool" >&2; exit 2; }
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
export TZ=UTC PGCONNECT_TIMEOUT=10

q() { psql "$1" -X -At -v ON_ERROR_STOP=1 -c "$2"; }

echo "== versiuni"
OLD_V=$(q "$OLD_URL" "show server_version_num")
NEW_V=$(q "$NEW_URL" "show server_version_num")
echo "vechi=$OLD_V nou=$NEW_V pg_dump=$(pg_dump --version)"
[ "$((NEW_V / 10000))" -gt "$((OLD_V / 10000))" ] && ok "serverul nou e o versiune majoră mai mare" ||
  fail "serverul nou nu e o versiune majoră mai mare"

# Amprenta: o linie pe element, sortată (aceeași pe ambele servere dacă restaurarea e fidelă).
FINGERPRINT_SQL=$(cat <<'SQL'
with t as (
  select c.oid, n.nspname || '.' || c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('finet', 'pgboss') and c.relkind in ('r', 'p')
)
select 'rls ' || name || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity
  from t join pg_class c on c.oid = t.oid
union all
-- ACL efectiv: NULL = implicitul proprietarului (pg_dump omite un ACL egal cu implicitul).
select 'acl ' || name || ' ' || coalesce(c.relacl, acldefault('r', c.relowner))::text
  from t join pg_class c on c.oid = t.oid
union all
select 'policy ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || cmd || ' '
       || array_to_string(roles, ',') || ' ' || coalesce(qual, '-') || ' ' || coalesce(with_check, '-')
  from pg_policies where schemaname in ('finet', 'pgboss')
union all
select 'function ' || p.oid::regprocedure::text || ' ' || p.prosecdef || ' '
       || coalesce(array_to_string(p.proconfig, ','), '-') || ' ' || md5(p.prosrc) || ' '
       || coalesce(p.proacl, acldefault('f', p.proowner))::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('finet', 'pgboss')
union all
-- PostgreSQL 18 păstrează și NOT NULL în pg_constraint (contype 'n'); pe 17 nu. Ele se compară
-- prin coloane (tip + NOT NULL + implicit), identic pe ambele versiuni.
select 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid)
  from pg_constraint where connamespace in ('finet'::regnamespace, 'pgboss'::regnamespace)
   and contype <> 'n'
union all
select 'column ' || name || ' ' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' '
       || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
  from t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
union all
select 'trigger ' || tgrelid::regclass::text || ' ' || tgname || ' ' || pg_get_triggerdef(oid)
  from pg_trigger t where not tgisinternal
   and tgrelid in (select oid from pg_class where relnamespace in ('finet'::regnamespace, 'pgboss'::regnamespace))
union all
select 'control ' || household_id || ' ' || currency || ' n=' || count(*) || ' sum=' || sum(amount_minor)
  from finet.transactions group by household_id, currency
order by 1
SQL
)

# Rândurile și conținutul fiecărui tabel (ca superuser: RLS nu se aplică).
rows_fingerprint() {
  for tbl in $(q "$1" "select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('finet','pgboss') and c.relkind in ('r','p') order by 1"); do
    printf '%s %s\n' "$tbl" "$(q "$1" "select count(*) || ' ' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '-') from $tbl x")"
  done
}

echo "== amprenta pe serverul vechi"
q "$OLD_URL" "$FINGERPRINT_SQL" > "$WORK/before.txt"
rows_fingerprint "$OLD_URL" >> "$WORK/before.txt"
N_TX=$(q "$OLD_URL" "select count(*) from finet.transactions")
[ "$N_TX" -gt 0 ] && ok "date de control: $N_TX tranzacții" || fail "baza veche nu are date de control (upgrade-seed.sql)"
grep '^control ' "$WORK/before.txt"

echo "== dump (format custom, finet + pgboss)"
pg_dump --dbname="$OLD_URL" --no-password --schema=finet --schema=pgboss --format=custom --compress=0 \
  --file="$WORK/finet.dump"
ok "dump: $(wc -c < "$WORK/finet.dump") octeți"

echo "== serverul nou: roluri, scheme goale, restaurare ca finet_migrator"
NEW_DB=$(q "$NEW_URL" "select current_database()")
q "$NEW_URL" "select 1" > /dev/null
psql "$NEW_URL" -X -q -v ON_ERROR_STOP=1 -f "$DIR/test-bootstrap.sql" > /dev/null
EMPTY=$(q "$NEW_URL" "select count(*) from pg_class where relnamespace in ('finet'::regnamespace, 'pgboss'::regnamespace)")
[ "$EMPTY" = 0 ] || { fail "baza nouă ($NEW_DB) nu e goală"; exit 1; }
pg_restore --list "$WORK/finet.dump" > "$WORK/toc"
grep -Ev '^[0-9]+; [0-9]+ [0-9]+ SCHEMA - (finet|pgboss)( |$)' "$WORK/toc" > "$WORK/toc.filtered"
pg_restore --no-password --single-transaction --exit-on-error --use-list="$WORK/toc.filtered" \
  --dbname="$NEW_MIGRATOR_URL" "$WORK/finet.dump"
ok "restaurare ca finet_migrator (o singură tranzacție)"

echo "== amprenta pe serverul nou"
q "$NEW_URL" "$FINGERPRINT_SQL" > "$WORK/after.txt"
rows_fingerprint "$NEW_URL" >> "$WORK/after.txt"
if cmp -s "$WORK/before.txt" "$WORK/after.txt"; then
  ok "amprenta identică ($(wc -l < "$WORK/before.txt") linii: tabele, rânduri, RLS, politici, funcții, triggere, constrângeri, ACL, valori de control)"
else
  fail "amprenta diferă"
  diff "$WORK/before.txt" "$WORK/after.txt" | head -40 || true
  [ -n "${UPGRADE_DIFF_DIR:-}" ] && cp "$WORK/before.txt" "$WORK/after.txt" "$UPGRADE_DIFF_DIR/" || true
fi

echo "== finet_app pe serverul nou: tot supus RLS"
APP_URL=$(printf '%s' "$NEW_MIGRATOR_URL" | sed 's#//finet_migrator:finet_migrator_ci@#//finet_app:finet_app_ci@#')
SEEN=$(q "$APP_URL" "select count(*) from finet.transactions")
[ "$SEEN" = 0 ] && ok "fără context RLS, finet_app nu vede nicio tranzacție" || fail "finet_app vede $SEEN tranzacții fără context"

echo
if [ "$FAILS" -gt 0 ]; then echo "upgrade-test: $FAILS verificări eșuate"; exit 1; fi
echo "upgrade-test: OK"
