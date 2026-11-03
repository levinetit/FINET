#!/bin/sh
# Teste pentru ops/install/finet-install.sh, FĂRĂ Docker real, fără rețea reală și fără să atingă
# sistemul (inclus în `pnpm test:ops`; în CI rulează și într-un container Debian efemer, vezi
# .github/workflows/ci.yml). Rulare: sh ops/install/test.sh
#
# Ce verifică:
#  - sintaxa (sh, dash) și shellcheck (dacă există);
#  - reguli statice: fără `crontab -`, fără `read -s`, fără bashisme, fără build local;
#  - validatorii, ajutoarele de fișiere env (idempotență, backup) și textul cron generat;
#  - wizard-ul în --check, neinteractiv (--answers), cu stub-uri în PATH (docker, curl, git, ...):
#    nu scrie nimic în prefix/cron/systemd, nu apelează comenzi care modifică, docker doar cu
#    comenzi de citire, niciun secret din fișierul de răspunsuri în stdout, stderr, log sau argv;
#  - erori clare: răspuns lipsă, cheie necunoscută, fișier cu secrete citibil de alții, URL invalid.
# shellcheck disable=SC2034,SC2154,SC2016,SC2030,SC2031,SC2015
# (variabile folosite de funcțiile încărcate din finet-install.sh; stub-uri scrise din șiruri)
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
INSTALL="$DIR/finet-install.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
FAILS=0

ok() { echo "ok: $1"; }
fail() {
  echo "FAIL: $1"
  FAILS=$((FAILS + 1))
}
expect() { # descriere, cod așteptat, cod primit
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (cod $3, așteptat $2)"; fi
}
contains() { # descriere, fișier, text fix
  if grep -Fq -- "$3" "$2"; then ok "$1"; else fail "$1 (lipsește «$3»)"; fi
}

command -v python3 > /dev/null 2>&1 || {
  echo "FAIL: python3 lipsește (installer-ul îl cere)"
  exit 1
}

# --- sintaxă și shellcheck ---------------------------------------------------------------------
for f in "$DIR"/*.sh; do
  if sh -n "$f"; then ok "sintaxă sh $(basename "$f")"; else fail "sintaxă sh $(basename "$f")"; fi
  if command -v dash > /dev/null 2>&1; then
    if dash -n "$f"; then ok "sintaxă dash $(basename "$f")"; else fail "sintaxă dash $(basename "$f")"; fi
  fi
done
if command -v shellcheck > /dev/null 2>&1; then
  if shellcheck -s sh -x "$DIR"/*.sh; then ok "shellcheck ops/install/*.sh"; else fail "shellcheck ops/install/*.sh"; fi
else
  echo "skip: shellcheck lipsește (rulează în CI)"
fi

# --- reguli statice ----------------------------------------------------------------------------
active() { grep -Ev '^[[:space:]]*#' "$INSTALL"; }
if active | grep -Eq 'crontab.*[[:space:]]-([[:space:]]|$)'; then
  fail "finet-install.sh folosește «crontab -» (suprascrie tot crontab-ul root)"
else ok "fără «crontab -» activ"; fi
if active | grep -Eq 'crontab[[:space:]]+(-e|-r)\b'; then fail "crontab -e/-r activ"; else ok "fără crontab -e/-r"; fi
if active | grep -Eq '(^|[[:space:];|&])read[[:space:]]+-[a-zA-Z]*s'; then fail "read -s (nu există în dash)"; else ok "fără read -s"; fi
if active | grep -Eq 'pipefail|\[\[[^:]|set[[:space:]]+-x|^[[:space:]]*local[[:space:]]|=\(|<\('; then fail "bashism/trasare în finet-install.sh"; else ok "fără bashisme (pipefail, [[, local, array, <(), set -x)"; fi
if active | grep -Eq 'docker( compose)? build|--build|docker pull|docker login'; then fail "build/pull local (imaginile vin doar din CI)"; else ok "fără build local"; fi
if active | grep -Eq 'curl[^|]*(-H|--header)[[:space:]]+["'\'']?Authorization'; then fail "antet Authorization în argumentele curl"; else ok "tokenul nu e în argumentele curl"; fi
if head -n 1 "$INSTALL" | grep -q '^#!/bin/sh'; then ok "shebang #!/bin/sh"; else fail "shebang"; fi

# --- teste unitare (funcțiile din script, fără a rula wizard-ul) ---------------------------------
(
  set -e
  FINET_INSTALL_LIB=1
  # shellcheck disable=SC1090
  . "$INSTALL"
  set +e
  U=0
  t() { # descriere, cod așteptat, cod primit
    if [ "$2" = "$3" ]; then echo "ok: $1"; else
      echo "FAIL: $1 (cod $3, așteptat $2)"
      U=$((U + 1))
    fi
  }
  MARK=SECRETMARKERUNIT
  _val="postgres://finet_app.ref:$MARK@h.example.com:6543/postgres?sslmode=verify-full"
  v_dburl_app
  t "URL aplicație valid (6543)" 0 $?
  _val="postgres://finet_app.ref:$MARK@h.example.com:5432/postgres?sslmode=verify-full"
  v_dburl_app
  t "URL aplicație cu portul 5432 respins" 1 $?
  case $_err in *"$MARK"*) t "mesajul de eroare nu conține parola" 0 1 ;; *) t "mesajul de eroare nu conține parola" 0 0 ;; esac
  _val="postgres://u:$MARK@h.example.com:5432/postgres?sslmode=require"
  v_dburl_mig
  t "sslmode=require respins" 1 $?
  _val="postgres://u:$MARK@h.example.com:5432/postgres?sslmode=verify-full&sslrootcert=/x"
  v_dburl_mig
  t "sslrootcert în URL respins" 1 $?
  _val="postgres://u:$MARK@h.example.com:5432/postgres?sslmode=verify-full"
  v_dburl_mig
  t "URL migrator valid (5432)" 0 $?
  t "url_host" "h.example.com" "$([ "$(url_host "$_val")" = h.example.com ] && echo h.example.com)"
  t "url_port" "5432" "$(url_port "$_val")"
  t "url_port implicit https" "443" "$(url_port https://exemplu.ro/x)"
  _val=da
  v_yn
  t "v_yn da" 0 $?
  _val=Maybe
  v_yn
  t "v_yn respinge" 1 $?
  _val=finet.exemplu.ro
  v_hostname
  t "hostname valid" 0 $?
  _val='Finet.ro;rm'
  v_hostname
  t "hostname invalid" 1 $?
  _val=10.0.0.999
  v_ipv4
  t "IPv4 invalid" 1 $?
  _val=172.88.88.0/24
  v_subnet
  t "subnet valid" 0 $?
  _val=abcd
  v_apikey
  t "cheie AI prea scurtă" 1 $?
  ver_ge v2.29.1 2 24
  t "ver_ge 2.29 >= 2.24" 0 $?
  ver_ge 2.20.0 2 24
  t "ver_ge 2.20 < 2.24" 1 $?
  ver_ge 5.0.0 2 24
  t "ver_ge 5.0 >= 2.24" 0 $?

  # envapply: idempotent, backup o singură dată, modul păstrat, comentarii înlocuite
  TMP=$(mktemp -d)
  DATE=20260101
  DRY=0
  LOG=/dev/null
  printf '# comentariu\nA=1\n# B=2\n# C=3\n' >"$TMP/f.env"
  chmod 600 "$TMP/f.env"
  envapply "$TMP/f.env" set A 9 >/dev/null
  envapply "$TMP/f.env" set B 7 >/dev/null
  envapply "$TMP/f.env" set D 5 >/dev/null
  envapply "$TMP/f.env" comment A >/dev/null
  t "set înlocuiește linia activă (A comentată apoi)" 0 "$(grep -c '^# A=9$' "$TMP/f.env" | sed 's/^1$/0/')"
  t "set activează o cheie comentată" 0 "$(grep -c '^B=7$' "$TMP/f.env" | sed 's/^1$/0/')"
  t "set adaugă o cheie lipsă" 0 "$(grep -c '^D=5$' "$TMP/f.env" | sed 's/^1$/0/')"
  t "cheia C comentată rămâne neatinsă" 0 "$(grep -c '^# C=3$' "$TMP/f.env" | sed 's/^1$/0/')"
  t "backup creat" 0 "$([ -f "$TMP/f.env.bak-20260101" ] && echo 0 || echo 1)"
  t "backup conține originalul" 0 "$(grep -c '^A=1$' "$TMP/f.env.bak-20260101" | sed 's/^1$/0/')"
  t "modul 600 păstrat" "600" "$(stat -c %a "$TMP/f.env")"
  cp "$TMP/f.env" "$TMP/f.before"
  envapply "$TMP/f.env" set B 7 >/dev/null
  envapply "$TMP/f.env" set D 5 >/dev/null
  cmp -s "$TMP/f.env" "$TMP/f.before"
  t "a doua aplicare nu schimbă nimic" 0 $?
  DRY=1
  envapply "$TMP/f.env" set B 8 >/dev/null
  cmp -s "$TMP/f.env" "$TMP/f.before"
  t "în --check envapply nu scrie" 0 $?
  t "envget" "7" "$(envget "$TMP/f.env" B)"
  rm -rf "$TMP"
  TMP=""

  # gen_cron
  PREFIX=/srv/finet SRC=/srv/finet/src LOG_DIR=/var/log DATE=20260101
  BACKUP_READY=da AI_ASK_EFF=da CRON_IDEMP_ON=nu
  OUT=$(gen_cron)
  t "cron: 4 joburi" 4 "$(printf '%s\n' "$OUT" | grep -c '^[0-9]')"
  t "cron: coloana utilizator root" 0 "$(printf '%s\n' "$OUT" | grep '^[0-9]' | grep -vc ' root ')"
  t "cron: PATH în fișier" 0 "$(printf '%s\n' "$OUT" | grep -c '^PATH=' | sed 's/^1$/0/')"
  t "cron: docker-compose.ask.yml inclus" 0 "$(printf '%s\n' "$OUT" | grep '^[0-9].*finet-cleanup\|aggregate' | grep -vc 'docker-compose.ask.yml')"
  t "cron: orele 25/30/35 4 și 10 5" 4 "$(printf '%s\n' "$OUT" | grep -c '^\(25 4\|30 4\|35 4\|10 5\) ')"
  t "cron: fără «crontab» în liniile active" 0 "$(printf '%s\n' "$OUT" | grep -v '^#' | grep -c crontab)"
  DUP_AGG=1 DUP_BACKUP=1
  OUT=$(gen_cron)
  t "cron: joburile duplicate sunt sărite" 2 "$(printf '%s\n' "$OUT" | grep -c '^[0-9]')"
  exit "$U"
) || FAILS=$((FAILS + 1))

# --- wizard în --check, neinteractiv, cu stub-uri ------------------------------------------------
BIN=$TMP/bin
FX=$TMP/fx
mkdir -p "$BIN" "$FX" "$TMP/out"
CALLS=$TMP/calls
: >"$CALLS"
SHA=0123456789abcdef0123456789abcdef01234567

# Stub generic: înregistrează argv-ul (fără stdin), apoi ieșire 0 sau comportamentul specific.
stub() { # nume, corp-case-opțional
  {
    printf '#!/bin/sh\nprintf "%%s" "%s" >> "%s"\nfor a in "$@"; do printf " %%s" "$a" >> "%s"; done\nprintf "\\n" >> "%s"\n' "$1" "$CALLS" "$CALLS" "$CALLS"
    printf '%s\n' "${2:-exit 0}"
  } >"$BIN/$1"
  chmod +x "$BIN/$1"
}
stub docker 'case "$1" in
  version) echo 27.3.1 ;;
  compose) case "$2" in version) echo v2.29.1 ;; *) exit 99 ;; esac ;;
  info) echo /var/lib/docker ;;
  network) case "$2" in inspect) exit 1 ;; ls) exit 0 ;; *) exit 99 ;; esac ;;
  ps) exit 0 ;;
  inspect) exit 1 ;;
  image) exit 1 ;;
  *) exit 99 ;;
esac'
stub curl 'u=""; for a in "$@"; do case "$a" in http*|telnet*) u=$a ;; esac; done
case "$*" in *"-K -"*) cat > /dev/null ;; esac
case "$u" in
  *ifconfig.me*|*ipify*) echo 203.0.113.7 ;;
  */workflows/images.yml/runs*) cat "'"$FX"'/runs.json" ;;
  */artifacts*) cat "'"$FX"'/art.json" ;;
  *) exit 0 ;;
esac'
stub df 'echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/x 200000000 1000000 150000000 1% /"'
for n in git openssl rclone crontab ssh rsync systemctl install chown chmod mkdir whiptail dialog cloudflared stty tee; do stub "$n" 'exit 0'; done
stub crontab 'case "$1 $2 $3" in "-l -u root") exit 0 ;; *) exit 97 ;; esac'

cat >"$FX/runs.json" <<EOF
{"workflow_runs":[{"id":111,"event":"push","conclusion":"success","head_branch":"main","head_sha":"$SHA"}]}
EOF
cat >"$FX/art.json" <<EOF
{"artifacts":[{"name":"finet-web-$SHA","expired":false},{"name":"finet-tools-$SHA","expired":false},{"name":"finet-backup-$SHA","expired":false}]}
EOF
printf -- '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n' >"$FX/prod-ca-2021.crt"
printf '[Gdrive]\ntype = drive\ntoken = {"access_token":"SECRETMARKERRCLONE"}\n' >"$FX/rclone.conf"

make_answers() { # fișier
  cat >"$1" <<EOF
# răspunsuri de test; valorile SECRETMARKER* sunt fictive și NU trebuie să apară nicăieri
APP_HOST=finet.exemplu.ro
NET_NAME=apps
NET_SUBNET=10.99.0.0/24
WEB_IP=10.99.0.130
WORKER_IP=10.99.0.131
ENTRY=tunel-nou
CLOUDFLARED_INSTALL=da
CF_TUNNEL_TOKEN=SECRETMARKERTUNNEL_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
CF_TEAM=echipa.cloudflareaccess.com
CF_AUD=abcdef0123456789abcdef
AI_ENABLE=da
AI_BASE_URL=http://ai.exemplu.ro:4000/v1
AI_BUDGET=0
AI_KEY=SECRETMARKERAIKEY_12345
AI_ASK=da
AI_ASK_KEY=SECRETMARKERASKKEY_12345
EGRESS_IP_ADDED=da
DB_URL_APP=postgres://finet_app.abcd:SECRETMARKERDBAPP@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=verify-full
DB_URL_MIGRATE=postgres://finet_migrator.abcd:SECRETMARKERDBMIG@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full
CA_SRC=$FX/prod-ca-2021.crt
ADMIN_EMAIL=admin@exemplu.ro
ADMIN_NAME=Administrator Test
ADMIN_PASSWORD=SECRETMARKERADMINPASS1
IMAGES_SHA=auto
GITHUB_TOKEN=SECRETMARKERGHTOKEN_1
GITHUB_TOKEN_KEEP=nu
BACKUP_ENABLE=da
BACKUP_PG_ROLE_EXISTS=da
RCLONE_CONF=$FX/rclone.conf
BACKUP_PG_PASSWORD=SECRETMARKERPGBACKUP
RESTIC_PASSWORD=SECRETMARKERRESTIC1
BACKUP_TEST_RUN=nu
CRON_ENABLE=da
EOF
  chmod 600 "$1"
}
make_answers "$TMP/answers"

for d in prefix cron varlog systemd logrotate bin; do mkdir -p "$TMP/root/$d"; done
run_install() { # ieșire, eroare, argumente...
  _o=$1
  _e=$2
  shift 2
  env -i PATH="$BIN:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$TMP" FINET_TTY=/nonexistent \
    FINET_PREFIX="$TMP/root/prefix" FINET_CRON_DIR="$TMP/root/cron" FINET_LOG_DIR="$TMP/root/varlog" \
    FINET_SYSTEMD_DIR="$TMP/root/systemd" FINET_LOGROTATE_DIR="$TMP/root/logrotate" FINET_BIN_DIR="$TMP/root/bin" \
    timeout 120 sh "$INSTALL" "$@" </dev/null >"$_o" 2>"$_e"
}

run_install "$TMP/out/o1" "$TMP/out/e1" --check --answers "$TMP/answers" --log "$TMP/out/install.log"
RC=$?
expect "dry-run neinteractiv: cod 0" 0 $RC
[ "$RC" = 0 ] || sed 's/^/    /' "$TMP/out/o1" "$TMP/out/e1" | tail -30
contains "dry-run: anunță modul verificare" "$TMP/out/o1" "Mod verificare: nu se scrie nimic"
contains "dry-run: alege automat SHA-ul din API" "$TMP/out/o1" "SHA-ul imaginilor: $SHA"
contains "dry-run: planul pentru cron.d" "$TMP/out/o1" "ar face: scriu $TMP/root/cron/finet"
contains "dry-run: planul pentru migrații" "$TMP/out/o1" "finet-migrate de două ori"
contains "dry-run: pașii manuali Cloudflare" "$TMP/out/o1" "Pași manuali rămași în Cloudflare"
contains "dry-run: IP-ul de ieșire afișat" "$TMP/out/o1" "IP-ul public de ieșire: 203.0.113.7"
contains "dry-run: verificare terminată" "$TMP/out/o1" "nu s-a scris nimic"

if [ -z "$(find "$TMP/root" -mindepth 2 2>/dev/null)" ]; then ok "dry-run nu scrie nimic în prefix, cron, log, systemd, logrotate, bin"; else
  fail "dry-run a scris fișiere: $(find "$TMP/root" -mindepth 2 | head -5)"
fi

# comenzi care modifică nu au fost apelate
BAD=$(grep -E '^(git|openssl|rclone|ssh|rsync|systemctl|install|chown|chmod|mkdir|whiptail|dialog|cloudflared|tee) ' "$CALLS" || true)
if [ -z "$BAD" ]; then ok "stub-uri mutante neapelate (git, openssl, rsync, systemctl, install, chown, chmod, mkdir, whiptail, ...)"; else
  fail "comenzi mutante apelate în dry-run: $BAD"
fi
BADCRON=$(grep -E '^crontab' "$CALLS" | grep -v '^crontab -l -u root$' || true)
if [ -z "$BADCRON" ]; then ok "crontab apelat doar cu «-l -u root» (citire)"; else fail "crontab apelat altfel: $BADCRON"; fi
BADDOCKER=$(grep '^docker' "$CALLS" | awk '
  $2 == "version" || $2 == "info" || $2 == "inspect" || $2 == "ps" { next }
  $2 == "network" && ($3 == "inspect" || $3 == "ls") { next }
  $2 == "compose" && $3 == "version" { next }
  $2 == "image" && $3 == "inspect" { next }
  { print }')
if [ -z "$BADDOCKER" ]; then ok "docker apelat doar cu comenzi de citire"; else fail "docker apelat cu comenzi care modifică: $BADDOCKER"; fi
if grep -q '^docker' "$CALLS"; then ok "stub-ul docker a fost folosit (nu docker real)"; else fail "docker nu a fost apelat deloc"; fi

# niciun secret nu apare nicăieri
LEAK=0
for f in "$TMP/out/o1" "$TMP/out/e1" "$TMP/out/install.log" "$CALLS"; do
  if [ -f "$f" ] && grep -q 'SECRETMARKER' "$f"; then
    fail "secret în $(basename "$f"): $(grep -o 'SECRETMARKER[A-Za-z0-9_]*' "$f" | sort -u | tr '\n' ' ')"
    LEAK=1
  fi
done
[ "$LEAK" = 0 ] && ok "niciun secret în stdout, stderr, log sau argv-ul stub-urilor"
[ -s "$TMP/out/install.log" ] && ok "logul a fost scris (--log)" || fail "logul lipsește"
if [ "$(stat -c %a "$TMP/out/install.log" 2>/dev/null)" = 600 ]; then ok "logul are modul 600"; else fail "logul nu e 600"; fi

# a doua rulare: același rezultat
run_install "$TMP/out/o2" "$TMP/out/e2" --check --answers "$TMP/answers" --log "$TMP/out/install.log"
expect "a doua rulare: cod 0" 0 $?
if cmp -s "$TMP/out/o1" "$TMP/out/o2"; then ok "rulat de două ori, ieșire identică (idempotent)"; else
  fail "ieșirile diferă între rulări"
  diff "$TMP/out/o1" "$TMP/out/o2" | head -8 | sed 's/^/    /'
fi

# erori clare
grep -v '^ADMIN_EMAIL=' "$TMP/answers" >"$TMP/answers.lipsa"
chmod 600 "$TMP/answers.lipsa"
run_install "$TMP/out/o3" "$TMP/out/e3" --check --answers "$TMP/answers.lipsa"
expect "răspuns lipsă: cod 1" 1 $?
contains "răspuns lipsă: mesaj clar" "$TMP/out/e3" "Lipsește răspunsul «ADMIN_EMAIL»"

{ cat "$TMP/answers"; echo "CHEIE_NECUNOSCUTA=1"; } >"$TMP/answers.cheie"
chmod 600 "$TMP/answers.cheie"
run_install "$TMP/out/o4" "$TMP/out/e4" --check --answers "$TMP/answers.cheie"
expect "cheie necunoscută: cod 1" 1 $?
contains "cheie necunoscută: mesaj clar" "$TMP/out/e4" "cheie necunoscută"

cp "$TMP/answers" "$TMP/answers.644"
chmod 644 "$TMP/answers.644"
run_install "$TMP/out/o5" "$TMP/out/e5" --check --answers "$TMP/answers.644"
expect "fișier cu secrete citibil de alții: cod 1" 1 $?
contains "fișier cu secrete citibil de alții: mesaj clar" "$TMP/out/e5" "poate fi citit de grup/alții"
grep -q 'SECRETMARKER' "$TMP/out/e5" "$TMP/out/o5" && fail "secret în ieșirea erorii de permisiuni" || ok "fără secret în eroarea de permisiuni"

sed 's#:6543/postgres?sslmode=verify-full#:6543/postgres?sslmode=require#' "$TMP/answers" >"$TMP/answers.ssl"
chmod 600 "$TMP/answers.ssl"
run_install "$TMP/out/o6" "$TMP/out/e6" --check --answers "$TMP/answers.ssl"
expect "sslmode=require respins: cod 1" 1 $?
contains "sslmode=require: mesaj clar" "$TMP/out/e6" "lipsește sslmode=verify-full"
grep -q 'SECRETMARKER' "$TMP/out/e6" "$TMP/out/o6" && fail "secret în eroarea de URL" || ok "fără secret în eroarea de URL invalid"

# fără --answers și fără terminal: refuză clar, nu se blochează
run_install "$TMP/out/o7" "$TMP/out/e7" --check
expect "fără terminal și fără --answers: cod 1" 1 $?
contains "fără terminal: mesaj clar" "$TMP/out/e7" "Nu am terminal interactiv"

# --answers nu apelează niciodată whiptail/dialog
if grep -qE '^(whiptail|dialog) ' "$CALLS"; then fail "whiptail/dialog apelat în modul --answers"; else ok "whiptail/dialog neapelat în --answers"; fi

# instalarea reală cere root
if [ "$(id -u)" -ne 0 ]; then
  run_install "$TMP/out/o8" "$TMP/out/e8" --answers "$TMP/answers"
  expect "instalare fără root: cod 1" 1 $?
fi


# --- instalare reală (cu stub-uri pentru docker/git/curl), doar ca root -------------------------------
# Rulează căile de scriere din installer într-un prefix temporar: permisiuni, secrete, env, cron,
# parola prin stdin, a doua rulare idempotentă. Docker, git, rețeaua și pull-images sunt simulate.
if [ "$(id -u)" -eq 0 ] && command -v openssl > /dev/null 2>&1; then
  A=$TMP/apply
  mkdir -p "$A/bin" "$A/root" "$A/dockerroot/containers/abc123" "$A/fx"
  echo '{}' >"$A/dockerroot/containers/abc123/config.v2.json"
  ACALLS=$A/calls
  : >"$ACALLS"
  astub() { # nume, corp
    {
      printf '#!/bin/sh\nprintf "%%s" "%s" >> "%s"\nfor a in "$@"; do printf " %%s" "$a" >> "%s"; done\nprintf "\\n" >> "%s"\n' "$1" "$ACALLS" "$ACALLS" "$ACALLS"
      printf '%s\n' "${2:-exit 0}"
    } >"$A/bin/$1"
    chmod +x "$A/bin/$1"
  }
  cp "$BIN/curl" "$A/bin/curl"
  sed -i "s#$ACALLS#$ACALLS#" "$A/bin/curl"
  cp "$BIN/df" "$A/bin/df"
  astub docker 'case "$*" in
  "version "*) echo 27.3.1 ;;
  "compose version"*) echo v2.29.1 ;;
  "info "*) echo "'"$A"'/dockerroot" ;;
  "network inspect"*) if [ -f "'"$A"'/netcreated" ]; then case "$*" in *Subnet*) echo 10.99.0.0/24 ;; esac; else exit 1; fi ;;
  "network create"*) touch "'"$A"'/netcreated" ;;
  "network ls"*) exit 0 ;;
  "ps "*) exit 0 ;;
  "image inspect"*) exit 0 ;;
  "inspect -f {{.State.Health.Status}}"*) echo healthy ;;
  "inspect -f {{.State.Status}}"*) echo running ;;
  "inspect -f {{.Id}}"*) echo abc123 ;;
  "inspect "*"Config.Env"*) echo "[]" ;;
  "exec finet-web node"*) echo "200 ok db=ok storage=ok queue=unknown" ;;
  "run "*"/run/secrets/u"*) echo "conexiune ok" ;;
  "run "*"ifconfig.me"*) echo 203.0.113.7 ;;
  "compose "*" finet-migrate"*) n=$(cat "'"$A"'/mig" 2>/dev/null || echo 2); echo "finet-migrate: gata; aplicate acum $n, deja aplicate 5"; echo 0 > "'"$A"'/mig" ;;
  "compose "*" finet-admin"*) cat > "'"$A"'/admin-stdin"; echo "household=1 user=1" ;;
  "compose "*) exit 0 ;;
  *) exit 99 ;;
esac'
  astub git 'case "$1" in
  clone) for last; do :; done; mkdir -p "$last"; cp -R --no-preserve=all "'"$DIR"'/../.." "$last/" 2>/dev/null || cp -R "'"$DIR"'/../../." "$last/"; mkdir -p "$last/.git"; printf "#!/bin/sh\nexit 0\n" > "$last/ops/deploy/pull-images.sh"; chmod -R go-w "$last" ;;
  *) exit 0 ;;
esac'
  astub crontab 'case "$1 $2 $3" in "-l -u root") exit 0 ;; *) exit 97 ;; esac'
  astub rclone 'exit 0'
  astub cloudflared 'case "$*" in *--help*) echo "--token-file" ;; esac'
  astub systemctl 'exit 0'
  make_answers "$A/answers"
  { cat "$A/answers"; echo "CONFIRM=da"; echo "ADMIN_PASSWORD=SECRETMARKERADMINPASS1"; } >"$A/answers2"
  grep -v '^ADMIN_PASSWORD=SECRETMARKERADMINPASS1$' "$A/answers" >/dev/null
  mv "$A/answers2" "$A/answers"
  chmod 600 "$A/answers"
  for d in cron varlog systemd logrotate bin; do mkdir -p "$A/root/$d"; done
  run_apply() { # ieșire, eroare
    env -i PATH="$A/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$A" FINET_TTY=/nonexistent \
      FINET_PREFIX="$A/root/prefix" FINET_CRON_DIR="$A/root/cron" FINET_LOG_DIR="$A/root/varlog" \
      FINET_SYSTEMD_DIR="$A/root/systemd" FINET_LOGROTATE_DIR="$A/root/logrotate" FINET_BIN_DIR="$A/root/bin" \
      timeout 300 sh "$INSTALL" --answers "$A/answers" </dev/null >"$1" 2>"$2"
  }
  run_apply "$A/o1" "$A/e1"
  RC=$?
  expect "instalare reală (stub-uri): cod 0" 0 $RC
  [ "$RC" = 0 ] || sed 's/^/    /' "$A/o1" "$A/e1" | tail -40
  P=$A/root/prefix
  SECS="finet_database_url finet_worker_database_url finet_migrate_database_url finet_health_token finet_better_auth_secret finet_litellm_key finet_ask_litellm_key finet_backup_repository finet_restic_password finet_backup_pg_service finet_rclone_conf"
  BADPERM=""
  for sname in $SECS; do
    [ "$(stat -c '%u:%g:%a' "$P/secrets/$sname" 2>/dev/null)" = "1000:1000:400" ] || BADPERM="$BADPERM $sname"
  done
  if [ -z "$BADPERM" ]; then ok "toate secretele sunt 1000:1000 mod 400"; else fail "permisiuni greșite:$BADPERM"; fi
  [ "$(stat -c '%a' "$P/secrets")" = 700 ] && ok "directorul secrets e 700" || fail "secrets nu e 700"
  [ "$(stat -c '%u:%g:%a' "$P/storage")" = "1000:1000:700" ] && ok "storage e 1000:1000 700" || fail "storage: permisiuni greșite"
  [ "$(stat -c '%a' "$P/env/finet.env")" = 600 ] && ok "finet.env e 600" || fail "finet.env nu e 600"
  [ "$(tr -d '\n' <"$P/secrets/finet_health_token" | wc -c | tr -d ' ')" = 64 ] && ok "token de sănătate generat: 64 caractere hex" || fail "token de sănătate: lungime greșită"
  [ "$(wc -c <"$P/secrets/finet_better_auth_secret" | tr -d ' ')" -ge 32 ] && ok "secret Better Auth generat (≥ 32)" || fail "secret Better Auth prea scurt"
  grep -q ':5432/' "$P/secrets/finet_worker_database_url" && ok "URL-ul workerului derivat pe portul 5432" || fail "URL worker: port greșit"
  [ "$(grep -c '^\[' "$P/secrets/finet_rclone_conf")" = 1 ] && ok "finet_rclone_conf are doar secțiunea [Gdrive]" || fail "finet_rclone_conf: secțiuni în plus"
  grep -q '^user=finet_backup' "$P/secrets/finet_backup_pg_service" && grep -q '^sslmode=verify-full' "$P/secrets/finet_backup_pg_service" && ok "finet_backup_pg_service are verify-full" || fail "finet_backup_pg_service invalid"
  contains "APP_URL setat" "$P/env/finet.env" "APP_URL=https://finet.exemplu.ro"
  contains "AI_ASK=1 pe web" "$P/env/finet.env" "AI_ASK=1"
  contains "CF_ACCESS_AUD setat" "$P/env/finet.env" "CF_ACCESS_AUD=abcdef0123456789abcdef"
  contains "AI_BASE_URL pe worker" "$P/env/finet.worker.env" "AI_BASE_URL=http://ai.exemplu.ro:4000/v1"
  contains "compose.env: rețeaua" "$P/compose/compose.env" "FINET_APPS_NETWORK=apps"
  contains "compose.env: IP web" "$P/compose/compose.env" "FINET_WEB_IP=10.99.0.130"
  contains "compose.env: calea secretelor" "$P/compose/compose.env" "FINET_SECRETS_DIR=$P/secrets"
  contains "CA instalat" "$P/ca/prod-ca-2021.crt" "BEGIN CERTIFICATE"
  # parola administratorului a mers prin stdin, nu prin argumente
  if [ "$(cat "$A/admin-stdin" 2>/dev/null)" = "SECRETMARKERADMINPASS1" ]; then ok "parola administratorului a ajuns prin stdin"; else fail "parola nu a ajuns prin stdin"; fi
  if grep -q -- '--password-stdin' "$ACALLS"; then ok "create-user cu --password-stdin"; else fail "create-user fără --password-stdin"; fi
  # toate apelurile compose folosesc aceeași listă -f (inclusiv ask) și --no-build
  if grep '^docker compose' "$ACALLS" | grep -E ' (up|run) ' | grep -v ' finet-backup' | grep -vq 'docker-compose.ask.yml'; then fail "un apel compose up/run fără docker-compose.ask.yml (ar recrea finet-web fără secretul ask)"; else ok "toate apelurile compose up/run includ docker-compose.ask.yml"; fi
  if grep '^docker compose' "$ACALLS" | grep -E ' (up|run) ' | grep -v ' finet-backup' | grep -vq -- '--no-build'; then fail "up/run fără --no-build"; else ok "up/run cu --no-build (fără build local)"; fi
  if grep -E '^docker .*(build|pull|load)' "$ACALLS" | grep -vq 'compose'; then fail "docker build/pull/load apelat"; else ok "fără build/pull local"; fi
  contains "migrații: a doua rulare 0" "$A/o1" "a doua rulare: aplicate acum 0"
  contains "N1 verificat" "$A/o1" "N1 finet-web: 0 URL-uri"
  contains "health verificat" "$A/o1" "/api/health: 200 ok"
  # cron
  CF=$A/root/cron/finet
  [ "$(stat -c '%u:%a' "$CF" 2>/dev/null)" = "0:644" ] && ok "cron.d/finet: root, 644" || fail "cron.d/finet: permisiuni greșite"
  [ "$(grep -c '^[0-9]' "$CF")" = 4 ] && ok "cron.d/finet: 4 joburi" || fail "cron.d/finet: număr de joburi"
  grep -q ' root ' "$CF" && ok "cron.d/finet: coloana utilizator" || fail "cron.d/finet: fără utilizator"
  # cloudflared: tokenul în fișier, nu în unitate
  if [ -f "$A/root/systemd/finet-cloudflared.service" ] && ! grep -q 'SECRETMARKER' "$A/root/systemd/finet-cloudflared.service" && grep -q -- '--token-file' "$A/root/systemd/finet-cloudflared.service"; then ok "unitatea cloudflared folosește --token-file, fără token în ea"; else fail "unitatea cloudflared"; fi
  [ "$(stat -c '%a' "$P"/cloudflared/tunnel.token 2>/dev/null)" = 600 ] && ok "tokenul tunelului: fișier 600" || fail "tokenul tunelului: permisiuni"
  # log final root 600, fără secrete; nicăieri secretele
  FLOG=$(find "$P" -maxdepth 1 -name "install-*.log" | head -n 1)
  if [ -n "$FLOG" ] && [ "$(stat -c '%a' "$FLOG")" = 600 ]; then ok "log final în prefix, mod 600"; else fail "log final lipsă sau permisiuni greșite"; fi
  LEAK=0
  for f in "$A/o1" "$A/e1" "$FLOG" "$ACALLS"; do
    if [ -f "$f" ] && grep -q 'SECRETMARKER' "$f"; then
      fail "secret în $(basename "$f"): $(grep -o 'SECRETMARKER[A-Za-z0-9_]*' "$f" | sort -u | tr '\n' ' ')"
      LEAK=1
    fi
  done
  [ "$LEAK" = 0 ] && ok "instalare reală: niciun secret în stdout, stderr, log sau argv"
  if grep '^crontab' "$ACALLS" | grep -vq '^crontab -l -u root$'; then fail "crontab apelat altfel decât -l"; else ok "crontab doar citit"; fi
  # a doua rulare: nimic nu se schimbă, nu apar backup-uri
  find "$P" -type f ! -name 'install-*.log' -exec sha256sum {} + | sort >"$A/sum1"
  find "$A/root" -type f ! -path "$P/*" -exec sha256sum {} + | sort >>"$A/sum1"
  run_apply "$A/o2" "$A/e2"
  expect "a doua instalare: cod 0" 0 $?
  find "$P" -type f ! -name 'install-*.log' -exec sha256sum {} + | sort >"$A/sum2"
  find "$A/root" -type f ! -path "$P/*" -exec sha256sum {} + | sort >>"$A/sum2"
  if cmp -s "$A/sum1" "$A/sum2"; then ok "a doua rulare: niciun fișier nu s-a schimbat"; else
    fail "a doua rulare a schimbat fișiere"
    diff "$A/sum1" "$A/sum2" | head -6 | sed 's/^/    /'
  fi
  if [ -z "$(find "$A/root" -name '*.bak-*')" ]; then ok "a doua rulare: fără fișiere .bak inutile"; else fail "apar .bak la a doua rulare: $(find "$A/root" -name '*.bak-*' | head -3)"; fi
  grep -q 'SECRETMARKER' "$A/o2" "$A/e2" && fail "secret în ieșirea celei de-a doua rulări" || ok "a doua rulare: fără secrete în ieșire"

  # --- mutare de pe un server existent (rsync/ssh simulate: "serverul vechi" = prefixul de mai sus) ---
  MV=$A/move
  mkdir -p "$MV/root" "$MV/bin"
  cp -a "$P" "$A/old"
  rm -f "$A"/old/install-*.log
  rm -rf "$A/old/src" "$A/old/cloudflared"
  echo 0 >"$A/mig"
  rm -f "$A/admin-stdin" "$A/netcreated"
  cp -a "$A/bin/." "$MV/bin/"
  cat >"$MV/bin/rsync" <<STUB
#!/bin/sh
printf 'rsync' >> "$ACALLS"; for a in "\$@"; do printf ' %s' "\$a" >> "$ACALLS"; done; printf '\n' >> "$ACALLS"
n=\$#; i=0
for a in "\$@"; do i=\$((i + 1)); [ \$i -eq \$((n - 1)) ] && src=\$a; [ \$i -eq \$n ] && dst=\$a; done
p=\${src#*:}; m="$A/old/\${p#/srv/finet/}"
mkdir -p "\$dst"; cp -a "\$m." "\$dst"
STUB
  cat >"$MV/bin/ssh" <<STUB
#!/bin/sh
printf 'ssh' >> "$ACALLS"; for a in "\$@"; do printf ' %s' "\$a" >> "$ACALLS"; done; printf '\n' >> "$ACALLS"
for last; do :; done
case \$last in
  true) exit 0 ;;
  *sha256sum*) f=\${last##* }; h=\$(sha256sum "$A/old/\${f#/srv/finet/}" | sed 's# .*##'); [ -f "$A/mismatch" ] && h=deadbeef; echo "\$h  \$f" ;;
esac
STUB
  chmod +x "$MV/bin/rsync" "$MV/bin/ssh"
  cat >"$MV/answers" <<ANS
MODE=move
MOVE_SRC=ops@old.exemplu.ro
MOVE_SRC_PREFIX=/srv/finet
NET_NAME=apps
NET_SUBNET=10.99.0.0/24
WEB_IP=10.99.0.130
WORKER_IP=10.99.0.131
ENTRY=tunel-existent
EGRESS_IP_ADDED=da
IMAGES_SHA=auto
GITHUB_TOKEN=SECRETMARKERGHTOKEN_1
GITHUB_TOKEN_KEEP=nu
BACKUP_ENABLE=da
RCLONE_REMOTE=Gdrive
BACKUP_TEST_RUN=nu
CRON_ENABLE=da
MOVE_FINAL_SYNC=nu
CONFIRM=da
ANS
  chmod 600 "$MV/answers"
  for d in cron varlog systemd logrotate bin; do mkdir -p "$MV/root/$d"; done
  run_move() { # ieșire, eroare, argumente...
    _mo=$1
    _me=$2
    shift 2
    env -i PATH="$MV/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$A" FINET_TTY=/nonexistent \
      FINET_PREFIX="$MV/root/prefix" FINET_CRON_DIR="$MV/root/cron" FINET_LOG_DIR="$MV/root/varlog" \
      FINET_SYSTEMD_DIR="$MV/root/systemd" FINET_LOGROTATE_DIR="$MV/root/logrotate" FINET_BIN_DIR="$MV/root/bin" \
      timeout 300 sh "$INSTALL" --answers "$MV/answers" "$@" </dev/null >"$_mo" 2>"$_me"
  }
  run_move "$MV/o0" "$MV/e0" --check
  expect "mutare --check: cod 0" 0 $?
  contains "mutare --check: avertisment Better Auth" "$MV/o0" "trebuie să rămână IDENTIC"
  contains "mutare --check: planul rsync" "$MV/o0" "rsync -aHAX --numeric-ids"
  if [ -z "$(find "$MV/root" -mindepth 2 2>/dev/null)" ]; then ok "mutare --check: nu scrie nimic"; else fail "mutare --check a scris fișiere"; fi
  if grep -q '^rsync' "$ACALLS"; then fail "mutare --check a apelat rsync"; else ok "mutare --check: rsync neapelat"; fi
  run_move "$MV/o1" "$MV/e1"
  RC=$?
  expect "mutare reală (stub-uri): cod 0" 0 $RC
  [ "$RC" = 0 ] || sed 's/^/    /' "$MV/o1" "$MV/e1" | tail -30
  contains "mutare: Better Auth identic" "$MV/o1" "finet_better_auth_secret identic"
  contains "mutare: migrații aplicate acum 0" "$MV/o1" "mutare: migrațiile raportează «aplicate acum 0»"
  if grep '^rsync' "$ACALLS" | grep -q -- '--numeric-ids' && grep '^rsync' "$ACALLS" | grep -q -- '--rsync-path=sudo rsync'; then ok "rsync cu --numeric-ids și --rsync-path=sudo rsync"; else fail "rsync fără --numeric-ids/--rsync-path"; fi
  if grep '^rsync' "$ACALLS" | grep -q -- '-aHAX'; then ok "rsync -aHAX"; else fail "rsync fără -aHAX"; fi
  [ "$(stat -c '%u:%g:%a' "$MV/root/prefix/secrets/finet_database_url")" = "1000:1000:400" ] && ok "mutare: permisiunile secretelor păstrate" || fail "mutare: permisiuni secrete"
  if cmp -s "$P/secrets/finet_better_auth_secret" "$MV/root/prefix/secrets/finet_better_auth_secret"; then ok "mutare: secretul Better Auth identic bit cu bit"; else fail "mutare: secretul Better Auth diferă"; fi
  if [ -f "$A/admin-stdin" ]; then fail "mutare: s-a creat un utilizator (create-user nu se rulează la mutare)"; else ok "mutare: create-user sărit"; fi
  if grep -q 'SECRETMARKER' "$MV/o1" "$MV/e1"; then fail "mutare: secret în ieșire"; else ok "mutare: fără secrete în ieșire"; fi
  if grep '^docker compose' "$ACALLS" | grep -E ' (up|run) ' | grep -v ' finet-backup' | grep -vq 'docker-compose.ask.yml'; then fail "mutare: compose up/run fără ask.yml (AI_ASK=1 copiat)"; else ok "mutare: AI_ASK citit din finet.env copiat, ask.yml inclus"; fi
  # secretul Better Auth diferit pe sursă: oprire
  touch "$A/mismatch"
  rm -rf "$MV/root/prefix"
  run_move "$MV/o2" "$MV/e2"
  RC=$?
  expect "mutare cu Better Auth diferit: cod 1" 1 $RC
  contains "mutare cu Better Auth diferit: mesaj clar" "$MV/e2" "finet_better_auth_secret diferă"
else
  echo "skip: instalarea reală (stub-uri) cere root și openssl"
fi

echo
if [ "$FAILS" -gt 0 ]; then
  echo "installer: $FAILS verificări au eșuat"
  exit 1
fi
echo "installer: toate verificările au trecut"
