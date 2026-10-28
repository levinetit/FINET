#!/bin/sh
# FINET — testul de restaurare (Faza 3, „restaurarea testată efectiv”), pe un PostgreSQL 17
# EFEMER. Nu atinge producția: refuză să ruleze fără FINET_RESTORE_TEST=1.
#
# Rulează scripturile REALE (backup.sh, restore.sh) dintr-un mediu cu restic, psql, pg_dump și
# pg_restore: în CI, în imaginea de backup construită de job-ul `backup-restore`; local, într-un
# container efemer (docs/BACKUP.md, „Testul de restaurare”).
#
# Mediu:
#   FINET_RESTORE_TEST=1          confirmarea că baza e de test
#   PGHOST, PGPORT, PGUSER, PGPASSWORD  superuserul Postgres-ului EFEMER (parole fictive)
#   FINET_BACKUP_BIN_DIR          unde sunt backup.sh/restore.sh (implicit lângă acest fișier;
#                                 în CI: /opt/finet-backup, adică scripturile din imagine)
#   FINET_TEST_BACKEND            `local` (implicit: repository într-un director) sau `rclone`
#                                 (repository `rclone:finettest:<director>` printr-un remote
#                                 rclone de tip `local`, fără rețea: același drum ca Google Drive,
#                                 `restic` → `rclone serve restic --stdio`)
#   FINET_TEST_DB                 baza de test (implicit finet_restore_test; rămâne la final,
#                                 restaurată, ca CI să ruleze migrate.mjs pe ea)
#
# Pașii (brief F3-D, 5a–5g):
#   a) roluri + schemă (ops/postgres/test-bootstrap.sql, ca roles.sql), rolul finet_backup
#      (ops/backup/backup-role.sql, ambii pași), migrațiile 0000–0004 ca finet_migrator, date
#      de test în două gospodării, un tabel „viitor” creat după GRANT-uri (privilegii implicite)
#   b) backup cu backup.sh într-un repository restic local temporar
#      + negative: dump ca finet_migrator / finet_app / parolă greșită → backup.sh eșuează și
#        NU apare niciun instantaneu nou; --enable-row-security ca finet_app → dump incomplet
#   c) `drop schema finet cascade` și recrearea schemei goale (ca roles.sql)
#   d) restaurare cu restore.sh ca finet_migrator (+ fișierele)
#   e) amprenta bazei înainte = după: rânduri și conținut pe FIECARE tabel, secvențe, solduri pe
#      cont și monedă, RLS ENABLE+FORCE, politici, ACL pe tabele/coloane/funcții, privilegii
#      implicite, constrângeri, triggere, proprietari; finet_app tot supus RLS
#   f) parola restic greșită nu deschide repository-ul
#   g) retenția 7/4/12 pe instantanee cu date simulate: exact 20 păstrate din 49
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/../.." && pwd)
BIN=${FINET_BACKUP_BIN_DIR:-$DIR}
DB=${FINET_TEST_DB:-finet_restore_test}
FAILS=0

[ "${FINET_RESTORE_TEST:-}" = 1 ] || { echo "restore-test: setează FINET_RESTORE_TEST=1 (doar pe un Postgres efemer)" >&2; exit 2; }
printf '%s' "$DB" | grep -Eq '^[a-z][a-z0-9_]{0,40}$' || { echo "restore-test: FINET_TEST_DB invalid" >&2; exit 2; }
for tool in restic psql pg_dump pg_restore sha256sum; do
  command -v "$tool" > /dev/null || { echo "restore-test: lipsește $tool" >&2; exit 2; }
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM
export TZ=UTC

ok() { echo "ok: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
section() { echo; echo "== $1"; }

SU="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
su_val() { psql -X -At -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

# Fișiere de servicii libpq pentru rolurile de test (parole FICTIVE din test-bootstrap.sql).
PGH=${PGHOST:-localhost}
PGP=${PGPORT:-5432}
service_file() { # fișier, secțiune, utilizator, parolă
  umask 077
  printf '[%s]\nhost=%s\nport=%s\ndbname=%s\nuser=%s\npassword=%s\n' "$2" "$PGH" "$PGP" "$DB" "$3" "$4" > "$1"
}
BACKUP_PW=finet_backup_ci_parola_fictiva_0123456789
service_file "$WORK/svc-backup" finet_backup finet_backup "$BACKUP_PW"
service_file "$WORK/svc-migrator" finet_backup finet_migrator finet_migrator_ci
service_file "$WORK/svc-app" finet_backup finet_app finet_app_ci
service_file "$WORK/svc-wrongpw" finet_backup finet_backup parola-gresita-0000000000
service_file "$WORK/svc-restore" finet_restore finet_migrator finet_migrator_ci

# Repository-ul restic local temporar.
printf '%s\n' "parola-restic-de-test-fictiva-1" > "$WORK/restic.pw"
BACKEND=${FINET_TEST_BACKEND:-local}
case "$BACKEND" in
  local) repo_url() { printf '%s\n' "$WORK/$1"; } ;;
  rclone)
    command -v rclone > /dev/null || { echo "restore-test: lipsește rclone" >&2; exit 2; }
    # Config rclone de test, cu permisiunile cerute de lib.sh (0600); remote local, fără rețea.
    (umask 077 && printf '[finettest]\ntype = local\n' > "$WORK/rclone.conf")
    export RCLONE_CONFIG="$WORK/rclone.conf"
    repo_url() { printf 'rclone:finettest:%s\n' "$WORK/$1"; } ;;
  *) echo "restore-test: FINET_TEST_BACKEND trebuie să fie local sau rclone" >&2; exit 2 ;;
esac
echo "backend: $BACKEND"
repo_url repo > "$WORK/restic.repo"
mkdir -p "$WORK/storage/docs/2026" "$WORK/home"
printf 'bon fictiv\n' > "$WORK/storage/docs/2026/bon-1.txt"
printf 'extras fictiv\n' > "$WORK/storage/extras.csv"

# Mediul comun pentru scripturile din imagine (fără PG* de superuser: rolurile vin din fișiere).
run_backup_env() { # fișier de servicii, apoi comanda
  _svc=$1
  shift
  env -u PGHOST -u PGPORT -u PGUSER -u PGPASSWORD -u PGDATABASE \
    HOME="$WORK/home" RESTIC_CACHE_DIR="$WORK/cache" \
    RESTIC_PASSWORD_FILE="$WORK/restic.pw" RESTIC_REPOSITORY_FILE="$WORK/restic.repo" \
    PGSERVICEFILE="$_svc" PGSERVICE=finet_backup FINET_BACKUP_INSECURE_DB=1 \
    FINET_BACKUP_STORAGE_DIR="$WORK/storage" FINET_BACKUP_CHECK_DATA_DAY="$(date +%u)" \
    FINET_RESTORE_PGSERVICEFILE="$WORK/svc-restore" "$@"
}
restic_t() {
  env HOME="$WORK/home" RESTIC_CACHE_DIR="$WORK/cache" RESTIC_PASSWORD_FILE="$WORK/restic.pw" \
    RESTIC_REPOSITORY_FILE="$WORK/restic.repo" restic "$@"
}
snap_count() { restic_t snapshots --json | grep -o '"id"' | wc -l | tr -d ' '; }

# =============================================================================================
section "a) baza de test: roluri, migrații, date"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "set client_min_messages = warning" -c "drop database if exists $DB" -c "create database $DB"
$SU -f "$ROOT/ops/postgres/test-bootstrap.sql"
# Rolul finet_backup e global în cluster: îl recreez ca testul să pornească de la zero (baza
# veche, cu drepturile lui, a fost ștearsă mai sus).
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "set client_min_messages = warning" -c "drop role if exists finet_backup"
FINET_BACKUP_PASSWORD=$BACKUP_PW $SU -v step=role -f "$DIR/backup-role.sql" > /dev/null
ok "rolul finet_backup creat (backup-role.sql, pasul role)"

# Migrațiile, ca finet_migrator, fiecare într-o tranzacție, plus tabelul de evidență al
# runner-ului (src/db/migrate.ts: hash = sha256 al fișierului, created_at = `when` din jurnal),
# ca migrate.mjs să găsească după restaurare „aplicate acum 0”.
mig() { env PGSERVICEFILE="$WORK/svc-migrator" psql -X -q -v ON_ERROR_STOP=1 service=finet_backup "$@"; }
mig -c "create table if not exists finet.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)"
JOURNAL="$ROOT/src/db/migrations/meta/_journal.json"
for file in "$ROOT"/src/db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  tag=$(basename "$file" .sql)
  when=$(awk -v tag="\"$tag\"" '/"when"/ { gsub(/[^0-9]/, ""); w = $0 } $0 ~ "\"tag\": " tag { print w; exit }' "$JOURNAL")
  [ -n "$when" ] || { fail "migrația $tag lipsește din jurnal"; continue; }
  hash=$(sha256sum "$file" | cut -d' ' -f1)
  mig -1 -f "$file" -c "insert into finet.__drizzle_migrations (hash, created_at) values ('$hash', $when)"
done
ok "migrațiile aplicate ca finet_migrator: $(su_val "select count(*) from finet.__drizzle_migrations")"

mig -v step=grants -f "$DIR/backup-role.sql" > /dev/null
ok "GRANT-urile finet_backup (backup-role.sql, pasul grants)"

# Un tabel „viitor”, creat DUPĂ GRANT-uri (ca o migrație nouă), cu FORCE RLS: backup-ul trebuie
# să-l includă prin privilegiile implicite, fără alt GRANT.
mig -c "create table finet.backup_probe (id bigserial primary key, note text not null);
  alter table finet.backup_probe enable row level security;
  alter table finet.backup_probe force row level security;"
$SU -c "insert into finet.backup_probe (note) values ('rând 1'), ('rând 2'), ('rând 3')"

# Date de test (superuser; RLS nu i se aplică): două gospodării, conturi în RON și EUR,
# venituri, cheltuieli, un transfer, etichete, bugete, obiective.
$SU <<'SQL'
insert into finet.users (id, name, email) values
  ('00000000-0000-4000-8000-000000000001', 'Ana Test', 'ana@finet.test'),
  ('00000000-0000-4000-8000-000000000002', 'Bogdan Test', 'bogdan@finet.test');
insert into finet.households (id, name, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Gospodăria A', '00000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002', 'Gospodăria B', '00000000-0000-4000-8000-000000000002');
insert into finet.household_members (household_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'owner'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'owner');
insert into finet.accounts (id, household_id, owner_user_id, name, type, currency, opening_balance_minor) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', null, 'Numerar', 'cash', 'RON', 150000),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', null, 'Banca', 'bank', 'RON', 9999999999999),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', null, 'Euro', 'savings', 'EUR', -250),
  ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000002', null, 'Cont B', 'bank', 'RON', 0);
insert into finet.transactions (household_id, account_id, category_id, type, amount_minor, currency, occurred_on, description)
select '10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
       (select id from finet.categories where household_id is null and kind = 'expense' order by system_key limit 1),
       'expense', 1000 + g * 7, 'RON', date '2026-01-01' + g, 'cheltuială ' || g || ' =1+1'
  from generate_series(1, 120) g;
insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on, merchant)
values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'income', 10000000000000, 'RON', '2026-10-01', 'Salariu'),
       ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000003', 'income', 12345, 'EUR', '2026-10-02', 'Dobândă'),
       ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000004', 'expense', 999, 'RON', '2026-10-03', 'Gospodăria B');
insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on, transfer_group_id, transfer_direction)
values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 'transfer', 50000, 'RON', '2026-10-05', '30000000-0000-4000-8000-000000000001', 'out'),
       ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'transfer', 50000, 'RON', '2026-10-05', '30000000-0000-4000-8000-000000000001', 'in');
insert into finet.tags (id, household_id, name, color) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Vacanță', '#12ab34');
insert into finet.transaction_tags (transaction_id, tag_id, household_id)
select id, '40000000-0000-4000-8000-000000000001', household_id
  from finet.transactions where household_id = '10000000-0000-4000-8000-000000000001' and type = 'expense'
 order by occurred_on limit 10;
insert into finet.budgets (household_id, category_id, amount_minor, currency) values
  ('10000000-0000-4000-8000-000000000001',
   (select id from finet.categories where household_id is null and kind = 'expense' order by system_key limit 1), 500000, 'RON');
insert into finet.goals (household_id, name, target_minor, currency, saved_minor, status) values
  ('10000000-0000-4000-8000-000000000001', 'Fond de urgență', 3000000, 'RON', 125000, 'active'),
  ('10000000-0000-4000-8000-000000000002', 'Concediu', 500000, 'EUR', 500000, 'achieved');
SQL
ok "date de test: $(su_val "select count(*) from finet.transactions") tranzacții, $(su_val "select count(*) from finet.households") gospodării"

# Amprenta bazei: tot ce trebuie să revină identic după restaurare.
fingerprint() { # fișier
  psql -X -At -v ON_ERROR_STOP=1 -d "$DB" > "$1" <<'SQL'
\echo -- rânduri și conținut pe fiecare tabel
select format('select %L, count(*), md5(coalesce(string_agg(t::text, %L order by t::text), %L)) from finet.%I t',
              c.relname, '|', '', c.relname)
  from pg_class c where c.relnamespace = 'finet'::regnamespace and c.relkind in ('r', 'p')
 order by c.relname \gexec
\echo -- secvențe
select sequencename, last_value from pg_sequences where schemaname = 'finet' order by 1;
\echo -- solduri pe cont (sold inițial + venituri - cheltuieli ± transferuri) și moneda
select a.name, a.currency, a.opening_balance_minor + coalesce(sum(case
         when t.type = 'income' then t.amount_minor
         when t.type = 'expense' then -t.amount_minor
         when t.transfer_direction = 'in' then t.amount_minor
         when t.transfer_direction = 'out' then -t.amount_minor end), 0)
  from finet.accounts a left join finet.transactions t on t.account_id = a.id
 group by a.id, a.name, a.currency, a.opening_balance_minor order by a.name;
\echo -- totaluri pe monedă și tip
select currency, type, count(*), sum(amount_minor) from finet.transactions group by 1, 2 order by 1, 2;
\echo -- RLS, proprietari, ACL pe tabele
select c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner), coalesce(c.relacl::text, '')
  from pg_class c where c.relnamespace = 'finet'::regnamespace order by c.relname;
\echo -- ACL pe coloane
select c.relname, a.attname, a.attacl::text from pg_attribute a join pg_class c on c.oid = a.attrelid
 where c.relnamespace = 'finet'::regnamespace and a.attacl is not null order by 1, 2;
\echo -- politici
select tablename, policyname, permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, '')
  from pg_policies where schemaname = 'finet' order by 1, 2;
\echo -- funcții
select p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef, pg_get_userbyid(p.proowner),
       coalesce(p.proacl::text, ''), md5(pg_get_functiondef(p.oid))
  from pg_proc p where p.pronamespace = 'finet'::regnamespace order by 1, 2;
\echo -- constrângeri
select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint
 where connamespace = 'finet'::regnamespace order by 1, 2;
\echo -- triggere
select tgrelid::regclass::text, tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger
 where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'finet'::regnamespace) order by 1, 2;
\echo -- indecși
select indexrelid::regclass::text, pg_get_indexdef(indexrelid) from pg_index
 where indrelid in (select oid from pg_class where relnamespace = 'finet'::regnamespace) order by 1;
\echo -- privilegii implicite
select pg_get_userbyid(defaclrole), defaclobjtype, defaclacl::text from pg_default_acl
 where defaclnamespace = 'finet'::regnamespace order by 1, 2;
\echo -- schema
select pg_get_userbyid(nspowner), coalesce(nspacl::text, '') from pg_namespace where nspname = 'finet';
SQL
}
fingerprint "$WORK/before.txt"
tables=$(su_val "select count(*) from pg_class where relnamespace = 'finet'::regnamespace and relkind = 'r'")
forced=$(su_val "select count(*) from pg_class where relnamespace = 'finet'::regnamespace and relkind = 'r' and relrowsecurity and relforcerowsecurity")
ok "amprenta înainte: $(wc -l < "$WORK/before.txt") linii; $tables tabele, $forced cu RLS ENABLE+FORCE"

# =============================================================================================
section "b) backup în repository-ul restic local"
run_backup_env "$WORK/svc-backup" restic init > /dev/null 2>&1 && ok "restic init" || fail "restic init"

# Negative ÎNAINTE de primul backup reușit: niciun instantaneu nu trebuie să apară.
expect_backup_fail() { # descriere, fișier de servicii, text așteptat în ieșire
  before=$(snap_count)
  if run_backup_env "$2" sh "$BIN/backup.sh" > "$WORK/neg.log" 2>&1; then
    fail "$1: backup.sh a reușit (trebuia să eșueze)"
  else
    if grep -q "$3" "$WORK/neg.log"; then ok "$1: backup.sh eșuează („$3”)"; else fail "$1: eroare neașteptată"; sed 's/^/    /' "$WORK/neg.log" | tail -5; fi
  fi
  after=$(snap_count)
  [ "$before" = "$after" ] && ok "$1: niciun instantaneu nou ($after)" || fail "$1: au apărut instantanee ($before → $after)"
}
expect_backup_fail "dump ca finet_migrator (proprietar, FORCE RLS)" "$WORK/svc-migrator" "row-level security"
expect_backup_fail "dump ca finet_app (NOBYPASSRLS)" "$WORK/svc-app" "FINET_BACKUP_STAGE=dump"
expect_backup_fail "parola bazei greșită" "$WORK/svc-wrongpw" "password authentication failed"

# --enable-row-security ca finet_app: „reușește”, dar fără rânduri (de aceea nu se folosește).
real_tx=$(su_val "select count(*) from finet.transactions")
if env PGSERVICEFILE="$WORK/svc-app" PGSERVICE=finet_backup pg_dump --no-password --enable-row-security \
  --data-only --table=finet.transactions --format=plain > "$WORK/rls.sql" 2> "$WORK/rls.err"; then
  rows=$(awk '/^COPY finet.transactions /{on=1; next} /^\\\.$/{on=0} on' "$WORK/rls.sql" | wc -l | tr -d ' ')
  [ "$rows" -lt "$real_tx" ] && ok "--enable-row-security ca finet_app: dump INCOMPLET ($rows din $real_tx rânduri) — de aceea rolul are BYPASSRLS" ||
    fail "--enable-row-security ca finet_app a scris toate rândurile ($rows)"
else
  ok "--enable-row-security ca finet_app: pg_dump refuză ($(head -1 "$WORK/rls.err" | cut -c1-80))"
fi

if run_backup_env "$WORK/svc-backup" sh "$BIN/backup.sh" > "$WORK/backup.log" 2>&1; then
  ok "backup.sh ca finet_backup: reușit"
else
  fail "backup.sh ca finet_backup a eșuat"
  sed 's/^/    /' "$WORK/backup.log" | tail -20
fi
db_snaps=$(restic_t snapshots --tag finet-db --json | grep -o '"id"' | wc -l | tr -d ' ')
st_snaps=$(restic_t snapshots --tag finet-storage --json | grep -o '"id"' | wc -l | tr -d ' ')
[ "$db_snaps" = 1 ] && [ "$st_snaps" = 1 ] && ok "instantanee: 1 finet-db, 1 finet-storage (gazda finet)" ||
  fail "instantanee neașteptate: finet-db=$db_snaps finet-storage=$st_snaps"
restic_t snapshots --host finet --json | grep -q '"hostname":"finet"' && ok "instantaneele au gazda fixă finet" || fail "gazda instantaneelor nu e finet"
if [ "$BACKEND" = rclone ]; then
  [ -s "$WORK/repo/config" ] && [ -d "$WORK/repo/data" ] && ok "repository-ul a fost scris prin rclone (remote local)" || fail "repository-ul rclone lipsește"
fi
grep -q 'FINET_BACKUP_STAGE=check' "$WORK/backup.log" && grep -q 'backup reușit' "$WORK/backup.log" &&
  ok "backup.sh a parcurs toate etapele (până la check)" || fail "backup.sh nu a ajuns la check"
# Secretele nu apar în log.
if grep -Fq -e "$BACKUP_PW" -e "parola-restic-de-test-fictiva-1" "$WORK/backup.log"; then fail "un secret apare în logul backup-ului"; else ok "logul backup-ului fără secrete"; fi
# Dump-ul conține și tabelul „viitor” (privilegii implicite).
restic_t dump --tag finet-db latest /finet.dump | pg_restore --list | grep -q 'TABLE DATA finet backup_probe' &&
  ok "dump-ul conține tabelul creat după GRANT-uri (privilegii implicite)" || fail "dump-ul nu conține backup_probe"

# =============================================================================================
section "c) ștergerea schemei finet"
$SU -c "set client_min_messages = warning" -c "drop schema finet cascade"
$SU -f "$ROOT/ops/postgres/test-bootstrap.sql"
[ "$(su_val "select count(*) from pg_class where relnamespace = 'finet'::regnamespace")" = 0 ] &&
  ok "schema finet recreată goală (ca roles.sql)" || fail "schema finet nu e goală"

# =============================================================================================
section "d) restaurare cu restore.sh ca finet_migrator"
if run_backup_env "$WORK/svc-backup" sh "$BIN/restore.sh" > "$WORK/restore-no.log" 2>&1; then
  fail "restore.sh fără --yes a rulat"
else
  ok "restore.sh fără --yes refuză"
fi
mkdir -p "$WORK/restored-files"
if run_backup_env "$WORK/svc-backup" sh "$BIN/restore.sh" --yes --storage-target "$WORK/restored-files" > "$WORK/restore.log" 2>&1; then
  ok "restore.sh --yes: reușit"
else
  fail "restore.sh a eșuat"
  sed 's/^/    /' "$WORK/restore.log" | tail -20
fi
restored_storage=$(find "$WORK/restored-files" -type d -name storage | head -1)
if [ -n "$restored_storage" ] && diff -r "$WORK/storage" "$restored_storage" > /dev/null; then
  ok "fișierele restaurate identice ($(find "$restored_storage" -type f | wc -l | tr -d ' ') fișiere)"
else
  fail "fișierele restaurate diferă sau lipsesc"
fi
if run_backup_env "$WORK/svc-backup" sh "$BIN/restore.sh" --yes > "$WORK/restore-2.log" 2>&1; then
  fail "a doua restaurare peste o schemă plină a rulat"
else
  grep -q "nu e goală" "$WORK/restore-2.log" && ok "restore.sh refuză o schemă care nu e goală" || fail "a doua restaurare a eșuat din alt motiv"
fi

# =============================================================================================
section "e) verificarea bazei restaurate"
fingerprint "$WORK/after.txt"
if cmp -s "$WORK/before.txt" "$WORK/after.txt"; then
  ok "amprenta după = înainte ($(wc -l < "$WORK/after.txt") linii: rânduri, conținut, solduri, RLS, politici, ACL, funcții, triggere)"
else
  fail "amprenta diferă după restaurare"
  diff "$WORK/before.txt" "$WORK/after.txt" | head -30 | sed 's/^/    /'
fi
forced_after=$(su_val "select count(*) from pg_class where relnamespace = 'finet'::regnamespace and relkind = 'r' and relrowsecurity and relforcerowsecurity")
[ "$forced_after" = "$forced" ] && [ "$forced" -ge 10 ] && ok "RLS ENABLE+FORCE pe $forced_after tabele, ca înainte" || fail "RLS FORCE: $forced → $forced_after"
grep -q "^transactions|$real_tx|" "$WORK/after.txt" && ok "transactions: $real_tx rânduri restaurate" || fail "numărul de tranzacții diferă"
# finet_app rămâne supus RLS: fără context de gospodărie nu vede nimic.
app_sees=$(env PGSERVICEFILE="$WORK/svc-app" psql -X -At service=finet_backup -c "select count(*) from finet.transactions" 2>&1 || true)
[ "$app_sees" = 0 ] && ok "finet_app fără context vede 0 tranzacții (RLS activ)" || fail "finet_app vede: $app_sees"

# =============================================================================================
section "f) parola restic greșită"
printf '%s\n' "parola-gresita" > "$WORK/wrong.pw"
set +e
env HOME="$WORK/home" RESTIC_CACHE_DIR="$WORK/cache" RESTIC_PASSWORD_FILE="$WORK/wrong.pw" \
  RESTIC_REPOSITORY_FILE="$WORK/restic.repo" restic snapshots > /dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] && ok "restic snapshots cu parola greșită: refuzat (cod $rc)" || fail "repository-ul s-a deschis cu parola greșită"
before=$(snap_count)
if run_backup_env "$WORK/svc-backup" env RESTIC_PASSWORD_FILE="$WORK/wrong.pw" sh "$BIN/backup.sh" > "$WORK/wrongpw.log" 2>&1; then
  fail "backup.sh cu parola restic greșită a reușit"
else
  grep -q 'FINET_BACKUP_STAGE=repo' "$WORK/wrongpw.log" && ok "backup.sh cu parola restic greșită: eșuează la etapa repo" || fail "backup.sh cu parola greșită: altă etapă"
fi
[ "$(snap_count)" = "$before" ] && ok "niciun instantaneu nou cu parola greșită" || fail "instantaneu nou cu parola greșită"

# =============================================================================================
section "g) retenția 7 zilnice / 4 săptămânale / 12 lunare"
# shellcheck source=ops/backup/lib.sh
. "$BIN/lib.sh"
repo_url repo-retention > "$WORK/restic.repo"
restic_t init > /dev/null 2>&1
dates=
d=1
while [ "$d" -le 28 ]; do dates="$dates 2026-10-$(printf '%02d' "$d")"; d=$((d + 1)); done
for m in 01 02 03 04 05 06 07 08 09 10 11 12; do dates="$dates 2025-$m-01"; done
for m in 01 02 03 04 05 06 07 08 09; do dates="$dates 2026-$m-01"; done
n=0
for day in $dates; do
  echo "$day" | restic_t backup --quiet --host "$FINET_BACKUP_HOST" --tag "$FINET_DB_TAG" \
    --stdin --stdin-filename "$FINET_DUMP_NAME" --time "$day 12:00:00" > /dev/null
  n=$((n + 1))
done
[ "$(snap_count)" = 49 ] && ok "49 de instantanee simulate ($n)" || fail "instantanee simulate: $(snap_count)"
# Aceeași comandă ca în backup.sh (aceleași etichete, grupare și politică din lib.sh).
# shellcheck disable=SC2086
restic_t forget --host "$FINET_BACKUP_HOST" --tag "$FINET_DB_TAG" --tag "$FINET_STORAGE_TAG" \
  --group-by host,tags $FINET_RETENTION --prune > "$WORK/forget.log" 2>&1 || fail "restic forget a eșuat"
kept=$(snap_count)
[ "$kept" = 20 ] && ok "retenție: 20 păstrate din 49 (7 zilnice 22–28 oct, săptămânale 11 și 18 oct, lunare nov 2025–sep 2026)" ||
  fail "retenție: $kept păstrate (așteptat 20)"
times=$(restic_t snapshots --json | grep -o '"time":"[0-9-]*' | cut -d'"' -f4 | sort | tr '\n' ' ')
expected="2025-11-01 2025-12-01 2026-01-01 2026-02-01 2026-03-01 2026-04-01 2026-05-01 2026-06-01 2026-07-01 2026-08-01 2026-09-01 2026-10-11 2026-10-18 2026-10-22 2026-10-23 2026-10-24 2026-10-25 2026-10-26 2026-10-27 2026-10-28 "
[ "$times" = "$expected" ] && ok "retenție: exact datele așteptate" || { fail "retenție: alte date păstrate"; echo "    $times"; }

# Backup-ul din backup.sh aplică forget pe aceeași gazdă: un instantaneu cu altă gazdă nu e atins.
echo x | restic_t backup --quiet --host alta-gazda --tag "$FINET_DB_TAG" --stdin --stdin-filename x --time "2020-01-01 12:00:00" > /dev/null
# shellcheck disable=SC2086
restic_t forget --host "$FINET_BACKUP_HOST" --tag "$FINET_DB_TAG" --tag "$FINET_STORAGE_TAG" --group-by host,tags $FINET_RETENTION > /dev/null 2>&1
restic_t snapshots --host alta-gazda --json | grep -q '"hostname":"alta-gazda"' && ok "forget nu atinge instantaneele altei gazde" || fail "forget a șters instantaneul altei gazde"

echo
if [ "$FAILS" -eq 0 ]; then echo "restore-test: toate verificările au trecut"; else echo "restore-test: $FAILS eșecuri"; exit 1; fi
