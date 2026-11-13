#!/bin/sh
# FINET — installer interactiv (wizard) pentru un server nou (ADR 0044, docs/INSTALL.md).
#
# Rulare (recomandat: din checkout-ul repo-ului, ca root):
#   git clone https://github.com/levinetit/FINET.git && cd FINET
#   sudo sh ops/install/finet-install.sh                 # wizard (whiptail/dialog sau text)
#   sudo sh ops/install/finet-install.sh --check         # doar verificare: nu scrie nimic
#   sudo sh ops/install/finet-install.sh --answers F     # neinteractiv, răspunsurile din fișierul F
#
# Moduri: 1) instalare nouă, 2) mutare de pe un server existent (rsync peste SSH), 3) doar
# verificare (--check / --dry-run). Imaginile NU se construiesc local: se descarcă artefactele CI
# prin ops/deploy/pull-images.sh. Nu cere nimic din ce nu e documentat în docs/INFRA.md.
#
# Reguli ferme:
#  - POSIX sh (pe Debian `sudo sh` = dash): fără `read -s`, fără array-uri, fără pipefail. Valorile
#    secrete se citesc cu `stty -echo` + `read -r` din /dev/tty, trăiesc doar în variabile ale
#    shell-ului și ajung în fișiere prin `printf '%s' "$v" | install ... /dev/stdin` (printf e
#    builtin: nu apare în argumentele niciunui proces).
#  - Niciun secret în argumente, în log sau pe stdout. Secretele pe care le generează installer-ul
#    merg direct din openssl în fișier.
#  - Cron: NU se folosește `crontab -` (suprascrie tot crontab-ul root); se scrie un fișier
#    dedicat /etc/cron.d/finet. Crontab-ul root se citește doar (`crontab -l`) ca să nu dubleze joburi.
#  - Idempotent: ce există nu se suprascrie fără confirmare și se salvează ca <fișier>.bak-<data>.
#
# Variabile pentru teste (valorile implicite sunt cele de producție): FINET_PREFIX, FINET_CRON_DIR,
# FINET_LOG_DIR, FINET_SYSTEMD_DIR, FINET_LOGROTATE_DIR, FINET_BIN_DIR, FINET_GIT_URL,
# FINET_GITHUB_API, FINET_TTY, GITHUB_REPO. FINET_INSTALL_LIB=1 încarcă doar funcțiile (pentru teste).
#
# Coduri de ieșire: 0 = reușit (sau verificare fără eșecuri); 1 = eroare/precondiție; 2 = folosire greșită.
# shellcheck disable=SC2034,SC2154
# (variabile atribuite indirect prin eval sau folosite doar în anumite moduri)
set -eu

PROG=finet-install.sh
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_HERE=$(cd "$SELF_DIR/../.." && pwd)

PREFIX=${FINET_PREFIX:-/srv/finet}
CRON_DIR=${FINET_CRON_DIR:-/etc/cron.d}
LOG_DIR=${FINET_LOG_DIR:-/var/log}
SYSTEMD_DIR=${FINET_SYSTEMD_DIR:-/etc/systemd/system}
LOGROTATE_DIR=${FINET_LOGROTATE_DIR:-/etc/logrotate.d}
BIN_DIR=${FINET_BIN_DIR:-/usr/local/bin}
GITHUB_REPO=${GITHUB_REPO:-levinetit/FINET}
GIT_URL=${FINET_GIT_URL:-https://github.com/$GITHUB_REPO.git}
GH_API=${FINET_GITHUB_API:-https://api.github.com}
TTY=${FINET_TTY:-/dev/tty}

DRY=0
ANSWERS=""
MODE=""
NO_TUI=0
LOGFINAL=""
ERRLOG=""
LOG_SAVED=0
LOG_OK=0
TUI=""
QN=0
FAILS=0
WARNS=0
HIDDEN=0
TTYSTATE=""
SECRET_VARS=""
TMP=""
LOG=/dev/null
DATE=$(date +%Y%m%d)
SRC=""
SHA=""
CAN_START=1
GH_TOKEN_FILE=""
FRESH_FILES=""
# Valori implicite (set -u): completate de colectarea parametrilor.
APP_HOST="" NET_NAME=apps NET_SUBNET=172.88.88.0/24 WEB_IP=172.88.88.130 WORKER_IP=172.88.88.131
ENTRY=nimic TRAEFIK_RESOLVER=letsencrypt CF_TEAM_V="" CF_AUD_V="" CF_TUNNEL_TOKEN_V="" CLOUDFLARED_INSTALL=nu
AI_ENABLE_V=nu AI_BASE="" AI_ALLOWED="" AI_BUDGET_V=0 AI_KEY_V="" AI_ASK_KEY_V="" AI_ASK_EFF=nu
KEEP_AI_KEY_V=nu KEEP_AI_ASK_KEY_V=nu KEEP_DB_APP=nu KEEP_DB_MIG=nu KEEP_BK_PG_PASS=nu KEEP_RESTIC=nu
DB_APP="" DB_MIG="" DB_WORKER="" DB_HOSTPORTS="" CA_SRC="" CA_NAME="" CA_LOCAL="" EGRESS="" EGRESS_TRIED=0 EGRESS_OK=nu
NET_EXISTING_SUBNET="" ADMIN_EMAIL="" ADMIN_NAME="" ADMIN_GEN=da ADMIN_PASS="" BA_EXISTS=nu HT_EXISTS=nu
IMAGES_SHA_V=auto GH_TOKEN_V="" GH_KEEP=nu BACKUP_ON=nu BACKUP_READY=nu BACKUP_TEST=nu BK_PG_PASS=""
RESTIC_PASS="" RESTIC_GEN=nu RCLONE_REMOTE_V=Gdrive RCLONE_CONF_SRC="" BACKUP_PATH_V="" BACKUP_PG_USER_V=""
CRON_ON=nu CRON_IDEMP_ON=nu MOVE_SRC_V="" MOVE_KEY="" MOVE_PREFIX=/srv/finet FINAL_SYNC=nu MIGLINE="" MIGOUT=""
OLD_SHA="" MOVE_SHA_OK=nu

# Cheile permise în fișierul de răspunsuri (allowlist; fișierul NU se `source`-ază).
ANS_KEYS="MODE CONFIRM APP_HOST NET_NAME NET_SUBNET WEB_IP WORKER_IP ENTRY TRAEFIK_RESOLVER CF_TEAM CF_AUD \
CF_TUNNEL_TOKEN AI_ENABLE AI_BASE_URL AI_ALLOWED_HOSTS AI_BUDGET AI_KEY AI_ASK AI_ASK_KEY DB_URL_APP \
DB_URL_MIGRATE CA_SRC ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD IMAGES_SHA GITHUB_TOKEN GITHUB_TOKEN_KEEP \
EGRESS_IP_ADDED KEEP_EXISTING_SECRETS OVERWRITE_FILES BACKUP_ENABLE RCLONE_CONF RCLONE_REMOTE BACKUP_PATH \
BACKUP_PG_ROLE_EXISTS BACKUP_PG_USER BACKUP_PG_PASSWORD RESTIC_PASSWORD BACKUP_TEST_RUN CRON_ENABLE \
CRON_IDEMPOTENCY MOVE_SRC MOVE_SSH_KEY MOVE_SRC_PREFIX MOVE_FINAL_SYNC MOVE_SHA_DIFERIT CLOUDFLARED_INSTALL"
# Cheile cu valori secrete (fișierul de răspunsuri cu ele trebuie să fie 600).
# Chei care pot lipsi din fișierul de răspunsuri (valoarea goală e validă).
ASK_OPTIONAL=" MOVE_SSH_KEY CF_TEAM CF_AUD "
ANS_SECRET_KEYS="CF_TUNNEL_TOKEN AI_KEY AI_ASK_KEY DB_URL_APP DB_URL_MIGRATE ADMIN_PASSWORD GITHUB_TOKEN \
BACKUP_PG_PASSWORD RESTIC_PASSWORD"

# ---------------------------------------------------------------------------------------------
# Ieșire și log (nicio valoare secretă nu trece vreodată pe aici)
# ---------------------------------------------------------------------------------------------
say() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >>"$LOG"
}
note() { say "  $*"; }
section() {
  say ""
  say "== $* =="
}
die() {
  printf 'EROARE: %s\n' "$*" >&2 || : # stderr închis sau plin nu trebuie să schimbe codul de ieșire
  printf 'EROARE: %s\n' "$*" >>"$LOG" || :
  exit 1
}
chk_ok() { say "  [ OK ] $*"; }
chk_warn() {
  say "  [ATENȚIE] $*"
  WARNS=$((WARNS + 1))
}
chk_fail() {
  say "  [EȘEC] $*"
  FAILS=$((FAILS + 1))
}

cleanup() {
  _rc=$?
  trap - EXIT INT TERM HUP
  set +e # capcana nu are voie să se oprească înainte de rm -rf $TMP (stderr închis, disc plin etc.)
  if [ "$HIDDEN" = 1 ]; then
    if [ -n "$TTYSTATE" ]; then stty "$TTYSTATE" <"$TTY" 2>/dev/null || stty echo <"$TTY" 2>/dev/null || :; else stty echo <"$TTY" 2>/dev/null || :; fi
  fi
  if [ "$_rc" -ne 0 ]; then persist_error_log || :; fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then rm -rf "$TMP"; fi
  exit "$_rc"
}

# Salvează logul și la ieșirea cu eroare (altfel «vezi log» ar trimite spre un fișier șters odată cu
# $TMP). Rulează din cleanup, deci NU are voie să cheme die (capcanele sunt deja scoase, iar un
# exit aici ar sări peste rm -rf $TMP). Nu face nimic înainte ca modul să fie cunoscut (LOG_OK=1:
# --mode check / MODE=check din răspunsuri setează DRY abia atunci), în --check (nici cu --log),
# fără root (nici cu --log) sau, pentru calea implicită, fără directorul prefixului; nu salvează un
# log în care s-a găsit o valoare secretă.
persist_error_log() {
  [ "$LOG_OK" = 1 ] || return 0
  [ "$LOG_SAVED" = 0 ] || return 0
  [ -n "$ERRLOG" ] && [ -s "$LOG" ] || return 0
  [ "$DRY" = 0 ] || return 0
  [ "$(id -u)" -eq 0 ] || return 0
  if [ -z "$LOGFINAL" ]; then [ -d "$PREFIX" ] || return 0; fi
  if ! scrub_ok; then
    printf 'Logul de instalare conținea o valoare secretă și NU a fost salvat.\n' >&2 || :
    return 0
  fi
  if ! (
    umask 077
    cat "$LOG" >"$ERRLOG"
  ) 2>/dev/null; then
    printf 'Nu am putut salva logul de instalare în %s.\n' "$ERRLOG" >&2 || :
    return 0
  fi
  chmod 600 "$ERRLOG" 2>/dev/null || :
  chown root:root "$ERRLOG" 2>/dev/null || :
  printf 'Log de diagnostic salvat: %s (root, 600, fără secrete)\n' "$ERRLOG" >&2 || :
}

# act "descriere" comandă... : în --check doar anunță; altfel rulează (ieșirea în log; eșec = oprire).
act() {
  _d=$1
  shift
  if [ "$DRY" = 1 ]; then
    say "  [verificare] ar face: $_d"
    return 0
  fi
  say "  [fac] $_d"
  "$@" >>"$LOG" 2>&1 || die "A eșuat: $_d (vezi logul de eroare, dacă a putut fi salvat: ${ERRLOG:-indisponibil})."
}

# ---------------------------------------------------------------------------------------------
# Întrebări (whiptail/dialog dacă există, altfel prompturi text; --answers = neinteractiv)
# ---------------------------------------------------------------------------------------------
tty_ask() { # $1 text, $2 implicit → _val
  if [ -n "$TUI" ]; then
    _val=$($TUI --title "FINET — instalare" --inputbox "[$QN] $1" 14 74 "$2" 3>&1 1>&2 2>&3) || die "Anulat de operator."
  else
    if [ -n "$2" ]; then printf '[%s] %s [%s]: ' "$QN" "$1" "$2" >"$TTY"; else printf '[%s] %s: ' "$QN" "$1" >"$TTY"; fi
    IFS= read -r _val <"$TTY" || die "Intrare întreruptă."
    if [ -z "$_val" ]; then _val=$2; fi
  fi
}

# ask VAR CHEIE TEXT [IMPLICIT] [VALIDATOR]; validatorul citește $_val, poate să-l normalizeze
# și își explică eșecul în $_err. Răspunsul NU e secret (apare în log).
ask() {
  _v=$1 _k=$2 _t=$3 _d=${4-} _chk=${5-}
  QN=$((QN + 1))
  while :; do
    if [ -n "$ANSWERS" ]; then
      eval "_have=\${A_$_k+set}"
      if [ "$_have" = set ]; then
        eval "_val=\$A_$_k"
      elif [ -n "$_d" ]; then
        _val=$_d
      else
        case " $ASK_OPTIONAL " in
          *" $_k "*) _val="" ;;
          *) die "Lipsește răspunsul «$_k» din fișierul de răspunsuri ($_t)." ;;
        esac
      fi
    else
      tty_ask "$_t" "$_d"
    fi
    _err=""
    if [ -z "$_chk" ] || "$_chk"; then break; fi
    if [ -n "$ANSWERS" ]; then die "Valoare invalidă pentru $_k: $_err"; fi
    say "  Valoare invalidă: $_err"
  done
  eval "$_v=\$_val"
  printf '[%s] %s → %s\n' "$QN" "$_t" "$_val" >>"$LOG"
}
askyn() { ask "$1" "$2" "$3 [da/nu]" "$4" v_yn; }

# ask_secret VAR CHEIE TEXT [VALIDATOR]: citit ascuns din /dev/tty; în --check interactiv nu se cere.
ask_secret() {
  _v=$1 _k=$2 _t=$3 _chk=${4-}
  QN=$((QN + 1))
  SECRET_VARS="$SECRET_VARS $_v"
  if [ -z "$ANSWERS" ] && [ "$DRY" = 1 ]; then
    eval "$_v="
    printf '[%s] %s → (secret; nu se cere în verificare)\n' "$QN" "$_t" >>"$LOG"
    say "  [$QN] $_t: (secret, se va citi ascuns la instalare)"
    return 0
  fi
  while :; do
    if [ -n "$ANSWERS" ]; then
      eval "_have=\${A_$_k+set}"
      [ "$_have" = set ] || die "Lipsește răspunsul «$_k» din fișierul de răspunsuri ($_t)."
      eval "_val=\$A_$_k"
    else
      printf '[%s] %s (introducerea nu se afișează): ' "$QN" "$_t" >"$TTY"
      TTYSTATE=$(stty -g <"$TTY" 2>/dev/null || :)
      HIDDEN=1
      stty -echo <"$TTY" 2>/dev/null || :
      _rd=0
      IFS= read -r _val <"$TTY" || _rd=1
      if [ -n "$TTYSTATE" ]; then stty "$TTYSTATE" <"$TTY" 2>/dev/null || stty echo <"$TTY" 2>/dev/null || :; else stty echo <"$TTY" 2>/dev/null || :; fi
      HIDDEN=0
      printf '\n' >"$TTY"
      [ "$_rd" = 0 ] || die "Intrare întreruptă."
    fi
    _err=""
    if [ -z "$_chk" ] || "$_chk"; then break; fi
    if [ -n "$ANSWERS" ]; then die "Valoare secretă invalidă pentru $_k: $_err"; fi
    say "  Valoare invalidă: $_err"
  done
  eval "$_v=\$_val"
  _val=""
  printf '[%s] %s → (secret citit)\n' "$QN" "$_t" >>"$LOG"
}

# Afișează o valoare o singură dată, doar pe terminal (niciodată în log sau pe stdout).
show_once_tty() { # $1 etichetă, $2 valoare
  if [ -n "$ANSWERS" ] || ! ( : >"$TTY" ) 2>/dev/null; then
    die "Nu pot afișa «$1» pe un terminal; dă valoarea explicit (modul --answers nu o poate afișa)."
  fi
  printf '\n  >>> %s: %s\n  Copiaz-o ACUM în managerul de parole; nu se mai afișează și nu e salvată în log.\n  Apasă Enter pentru a continua... ' "$1" "$2" >"$TTY"
  IFS= read -r _dummy <"$TTY" || :
  printf '\n' >"$TTY"
}

# ---------------------------------------------------------------------------------------------
# Validatori ($_val → $_err)
# ---------------------------------------------------------------------------------------------
v_yn() {
  case $_val in
    da | DA | Da | d | y | yes) _val=da ;;
    nu | NU | Nu | n | no) _val=nu ;;
    *)
      _err="răspunde da sau nu"
      return 1
      ;;
  esac
}
v_mode() {
  case $_val in
    1 | new | nou | noua) _val=new ;;
    2 | move | mutare) _val=move ;;
    3 | check | verificare) _val=check ;;
    *)
      _err="alege 1 (instalare nouă), 2 (mutare) sau 3 (verificare)"
      return 1
      ;;
  esac
}
v_entry() {
  case $_val in
    1 | tunel-nou) _val=tunel-nou ;;
    2 | tunel-existent) _val=tunel-existent ;;
    3 | traefik) _val=traefik ;;
    4 | nimic) _val=nimic ;;
    *)
      _err="alege 1 (tunel nou), 2 (tunel existent), 3 (Traefik) sau 4 (niciuna acum)"
      return 1
      ;;
  esac
}
v_hostname() {
  case $_val in
    *[!a-z0-9.-]* | "" | .* | *. | *..*)
      _err="hostname invalid (litere mici, cifre, puncte, cratime)"
      return 1
      ;;
  esac
  case $_val in *.*) ;; *)
    _err="hostname fără domeniu"
    return 1
    ;;
  esac
}
v_ipv4() {
  case $_val in
    *[!0-9.]* | "" | .* | *.)
      _err="adresă IPv4 invalidă"
      return 1
      ;;
  esac
  python3 -I -c 'import ipaddress,sys; ipaddress.IPv4Address(sys.argv[1])' "$_val" 2>/dev/null || {
    _err="adresă IPv4 invalidă"
    return 1
  }
}
v_subnet() {
  python3 -I -c 'import ipaddress,sys; n=ipaddress.IPv4Network(sys.argv[1]); assert n.prefixlen<=28' "$_val" 2>/dev/null || {
    _err="subnet invalid (exemplu 172.88.88.0/24, cel mult /28)"
    return 1
  }
}
v_netname() {
  case $_val in
    "" | *[!A-Za-z0-9_.-]*)
      _err="nume de rețea invalid"
      return 1
      ;;
  esac
}
v_email() {
  printf '%s' "$_val" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || {
    _err="email invalid"
    return 1
  }
}
v_nonempty() { [ -n "$_val" ] || {
  _err="valoare obligatorie"
  return 1
}; }
v_cfteam() {
  [ -z "$_val" ] && return 0
  printf '%s' "$_val" | grep -Eq '^[a-z0-9-]+\.cloudflareaccess\.com$' || {
    _err="forma așteptată: <echipa>.cloudflareaccess.com"
    return 1
  }
}
v_cfaud() {
  [ -z "$_val" ] && return 0
  printf '%s' "$_val" | grep -Eq '^[A-Za-z0-9._-]{8,}$' || {
    _err="AUD invalid (cel puțin 8 caractere alfanumerice)"
    return 1
  }
}
v_cftoken() {
  printf '%s' "$_val" | grep -Eq '^[A-Za-z0-9+/=_-]{40,}$' || {
    _err="tokenul tunelului nu arată ca un token Cloudflare (base64, cel puțin 40 de caractere)"
    return 1
  }
}
v_sha() {
  case $_val in
    auto) return 0 ;;
    *[!0-9a-f]* | "")
      _err="auto sau un SHA complet de 40 de caractere"
      return 1
      ;;
  esac
  [ "${#_val}" -eq 40 ] || {
    _err="SHA-ul trebuie să aibă 40 de caractere"
    return 1
  }
}
v_aibase() {
  printf '%s' "$_val" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$' || {
    _err="URL invalid (exemplu http://gazda:4000/v1)"
    return 1
  }
}
v_aihosts() {
  printf '%s' "$_val" | grep -Eq '^[a-z0-9.:-]+(,[a-z0-9.:-]+)*$' || {
    _err="listă invalidă (gazdă sau gazdă:port, separate prin virgulă, litere mici)"
    return 1
  }
}
v_budget() {
  printf '%s' "$_val" | grep -Eq '^[0-9]+([.][0-9]+)?$' || {
    _err="număr invalid (0 = nimic nu pleacă spre AI extern)"
    return 1
  }
}
v_apikey() { # min 8, ASCII tipăribil, fără spații (src/lib/config.ts)
  printf '%s' "$_val" | grep -Eq '^[!-~]{8,512}$' || {
    _err="cheie invalidă (8–512 caractere ASCII tipăribile, fără spații)"
    return 1
  }
}
v_pass() {
  [ "${#_val}" -ge 12 ] || {
    _err="parola trebuie să aibă cel puțin 12 caractere"
    return 1
  }
}
v_safename() {
  printf '%s' "$_val" | grep -Eq '^[A-Za-z0-9._-]+$' || {
    _err="doar litere, cifre, punct, cratimă, underscore"
    return 1
  }
}
v_cafile() {
  printf '%s' "$_val" | grep -Eq '^[A-Za-z0-9._-]+\.(crt|pem)$' || {
    _err="numele CA trebuie să se termine în .crt sau .pem"
    return 1
  }
}
v_userhost() {
  printf '%s' "$_val" | grep -Eq '^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$' || {
    _err="forma așteptată: utilizator@gazdă"
    return 1
  }
}
v_abspath() {
  case $_val in
    /*) ;;
    *)
      _err="cale absolută necesară"
      return 1
      ;;
  esac
  case $_val in *[[:space:]]*)
    _err="fără spații în cale"
    return 1
    ;;
  esac
}
# Cale folosită pe serverul VECHI (ajunge în comenzi ssh/rsync): doar caractere sigure, fără spații,
# newline, ;, $, ` etc.
v_remotepath() {
  case $_val in
    /*) ;;
    *)
      _err="cale absolută necesară"
      return 1
      ;;
  esac
  case $_val in *[!A-Za-z0-9._/-]*)
    _err="doar litere, cifre și . _ / - în cale"
    return 1
    ;;
  esac
}
v_remotepath_or_empty() {
  [ -z "$_val" ] && return 0
  v_remotepath
}
v_abspath_or_empty() {
  [ -z "$_val" ] && return 0
  v_abspath
}
v_dburl() { # $_dbport = portul așteptat; mesajele nu conțin valoarea
  case $_val in
    postgres://* | postgresql://*) ;;
    *)
      _err="URL-ul trebuie să înceapă cu postgres://"
      return 1
      ;;
  esac
  case $_val in
    *sslmode=verify-full*) ;;
    *)
      _err="lipsește sslmode=verify-full"
      return 1
      ;;
  esac
  case $_val in
    *sslrootcert*)
      _err="fără sslrootcert în URL (CA-ul vine din DATABASE_CA_FILE)"
      return 1
      ;;
  esac
  _hp=$(printf '%s' "$_val" | sed -n 's#^[a-z]*://.*@\([^@/?]*\)[/?].*#\1#p')
  case $_hp in
    *:"$_dbport") ;;
    *)
      _err="portul trebuie să fie $_dbport"
      return 1
      ;;
  esac
}
v_dburl_app() {
  _dbport=6543
  v_dburl
}
v_dburl_mig() {
  _dbport=5432
  v_dburl
}

# Gazdă și port dintr-un URL (fără parolă).
url_hostport() { printf '%s' "$1" | sed -n 's#^[a-z]*://\([^@/]*@\)\{0,1\}\([^/?]*\).*#\2#p' | sed 's#^.*@##'; }
url_host() { url_hostport "$1" | sed 's#:[0-9]*$##'; }
url_port() {
  _p=$(url_hostport "$1" | sed -n 's#^.*:\([0-9][0-9]*\)$#\1#p')
  if [ -n "$_p" ]; then
    printf '%s' "$_p"
  else
    case $1 in https://*) printf 443 ;; *) printf 80 ;; esac
  fi
}

# ---------------------------------------------------------------------------------------------
# Fișiere de mediu: set/comentare de chei fără a atinge restul fișierului
# ---------------------------------------------------------------------------------------------
# envedit FIȘIER set|comment CHEIE [VALOARE] : scrie rezultatul în $TMP/env.new (nu modifică originalul).
envedit() {
  K=$3 V=${4-} awk -v act="$2" '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    {
      line = $0; bare = line; sub(/^#[ \t]*/, "", bare)
      if (!done && index(line, k "=") == 1) {
        if (act == "set") print k "=" v; else print "# " line
        done = 1; next
      }
      if (!done && act == "set" && index(line, "#") == 1 && index(bare, k "=") == 1) {
        print k "=" v; done = 1; next
      }
      print line
    }
    END { if (!done && act == "set") print k "=" v }' "$1" >"$TMP/env.new"
}
# envapply FIȘIER set|comment CHEIE [VALOARE]: aplică (cu backup, o singură dată pe zi) sau anunță.
envapply() {
  _f=$1
  if [ ! -f "$_f" ]; then
    note "ar seta $3 în $_f (fișierul se creează întâi din modelul .example)"
    return 0
  fi
  envedit "$@"
  if cmp -s "$TMP/env.new" "$_f"; then return 0; fi
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar actualiza $3 în $_f"
    return 0
  fi
  case " $FRESH_FILES " in
    *" $_f "*)
      cat "$TMP/env.new" >"$_f"
      note "actualizat $3 în $_f"
      return 0
      ;;
  esac
  if [ ! -e "$_f.bak-$DATE" ]; then cp -p "$_f" "$_f.bak-$DATE"; fi
  cat "$TMP/env.new" >"$_f"
  note "actualizat $3 în $_f (backup $_f.bak-$DATE)"
}
envget() { # FIȘIER CHEIE → valoarea activă (sau nimic)
  [ -r "$1" ] || return 0
  awk -v k="$2" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$1"
}

# ---------------------------------------------------------------------------------------------
# Argumente, fișierul de răspunsuri
# ---------------------------------------------------------------------------------------------
usage() {
  cat <<'EOF'
FINET — installer interactiv (wizard)

Folosire: sudo sh ops/install/finet-install.sh [opțiuni]

  --check, --dry-run   doar verificare: arată ce ar face, fără să scrie nimic
  --answers FIȘIER     neinteractiv: răspunsurile din FIȘIER (CHEIE=valoare, mod 600 dacă are secrete)
  --mode new|move|check  sare peste prima întrebare
  --log FIȘIER         unde se scrie logul (implicit /srv/finet/install-<data>.log, la eroare install-<data>-eroare.log; fără secrete)
  --no-tui             prompturi text chiar dacă există whiptail/dialog
  -h, --help           acest mesaj

Documentația: docs/INSTALL.md.
EOF
}
parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --check | --dry-run) DRY=1 ;;
      --answers)
        [ $# -ge 2 ] || {
          usage >&2
          exit 2
        }
        ANSWERS=$2
        shift
        ;;
      --mode)
        [ $# -ge 2 ] || {
          usage >&2
          exit 2
        }
        MODE=$2
        shift
        ;;
      --log)
        [ $# -ge 2 ] || {
          usage >&2
          exit 2
        }
        LOGFINAL=$2
        shift
        ;;
      --no-tui) NO_TUI=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        printf 'Opțiune necunoscută: %s\n' "$1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

load_answers() {
  [ -f "$ANSWERS" ] || die "Fișierul de răspunsuri nu există: $ANSWERS"
  _lineno=0
  while IFS= read -r _line || [ -n "$_line" ]; do
    _lineno=$((_lineno + 1))
    case $_line in "" | "#"*) continue ;; esac
    _key=${_line%%=*}
    if [ "$_key" = "$_line" ]; then die "Fișierul de răspunsuri, linia $_lineno: lipsește «=»."; fi
    case " $ANS_KEYS " in
      *" $_key "*) ;;
      *) die "Fișierul de răspunsuri, linia $_lineno: cheie necunoscută «$_key»." ;;
    esac
    _val=${_line#*=}
    case $_val in
      \"*\") _val=${_val#\"}; _val=${_val%\"} ;;
      \'*\') _val=${_val#\'}; _val=${_val%\'} ;;
    esac
    eval "A_$_key=\$_val"
    case " $ANS_SECRET_KEYS " in *" $_key "*) _has_secret=1 ;; esac
  done <"$ANSWERS"
  _val=""
  if [ "${_has_secret:-0}" = 1 ] && [ -n "$(find "$ANSWERS" -perm /077 2>/dev/null)" ]; then
    die "Fișierul de răspunsuri conține secrete, dar poate fi citit de grup/alții; rulează chmod 600."
  fi
}

# ---------------------------------------------------------------------------------------------
# Compose: aceeași listă de fișiere -f la TOATE apelurile (altfel `up finet-worker` ar recrea
# finet-web fără secretul «ask»)
# ---------------------------------------------------------------------------------------------
compose_files() {
  _cfl="-f $SRC/ops/docker/docker-compose.yml"
  if [ "${AI_ASK_EFF:-nu}" = da ]; then _cfl="$_cfl -f $SRC/ops/docker/docker-compose.ask.yml"; fi
  printf '%s' "$_cfl"
}
dc() { # docker compose cu fișierele și mediul FINET
  # shellcheck disable=SC2046
  docker compose $(compose_files) --env-file "$PREFIX/compose/compose.env" "$@"
}
dc_backup() {
  docker compose -f "$SRC/ops/docker/docker-compose.yml" -f "$SRC/ops/backup/compose.rclone.yml" \
    --env-file "$PREFIX/compose/compose.env" --profile backup "$@"
}

# ---------------------------------------------------------------------------------------------
# Precondiții
# ---------------------------------------------------------------------------------------------
ver_ge() { # $1 = versiune (cu v opțional), $2 = major, $3 = minor
  _vv=${1#v}
  _mj=${_vv%%.*}
  _rest=${_vv#*.}
  _mn=${_rest%%.*}
  case $_mj$_mn in *[!0-9]* | "") return 1 ;; esac
  [ "$_mj" -gt "$2" ] || { [ "$_mj" -eq "$2" ] && [ "$_mn" -ge "$3" ]; }
}
nearest_dir() {
  _d=$1
  while [ ! -d "$_d" ] && [ "$_d" != / ]; do _d=$(dirname "$_d"); done
  printf '%s' "$_d"
}
# Conexiune TCP (curl telnet:// nu se oprește singur după conectare; socket-ul Python da).
tcp_ok() { python3 -I -c 'import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 8).close()' "$1" "$2" >/dev/null 2>&1; }
https_ok() { curl -fsSI -m 10 -o /dev/null "$1" >/dev/null 2>&1; }

preflight_system() {
  section "Precondiții: sistem"
  _os=necunoscut
  if [ "$(uname -s)" = Linux ]; then
    _id=""
    if [ -r /etc/os-release ]; then _id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"'); fi
    case $_id in
      debian | ubuntu) chk_ok "OS: Linux ($_id)" ;;
      *) chk_warn "OS: Linux (${_id:-necunoscut}); testat doar pe Debian/Ubuntu" ;;
    esac
    _os=linux
  else
    chk_fail "OS: $(uname -s); e necesar Linux"
  fi
  if [ "$(id -u)" -eq 0 ]; then
    chk_ok "rulează ca root"
  elif [ "$DRY" = 1 ]; then
    chk_warn "nu rulezi ca root (în --check merge; instalarea cere sudo)"
  else
    chk_fail "rulează cu sudo (sudo sh ops/install/finet-install.sh)"
  fi
  for _c in curl git openssl python3 awk sed grep find tar sha256sum install cmp; do
    if command -v "$_c" >/dev/null 2>&1; then chk_ok "comanda $_c"; else chk_fail "lipsește comanda $_c (apt-get install ...)"; fi
  done
  if [ "$MODE" = move ]; then
    for _c in rsync ssh; do
      if command -v "$_c" >/dev/null 2>&1; then chk_ok "comanda $_c"; else chk_fail "lipsește comanda $_c (necesară la mutare)"; fi
    done
  fi
  if command -v docker >/dev/null 2>&1; then
    if _dv=$(docker version --format '{{.Server.Version}}' 2>/dev/null) && [ -n "$_dv" ]; then
      if ver_ge "$_dv" 24 0; then chk_ok "Docker Engine $_dv"; else chk_warn "Docker Engine $_dv (recomandat ≥ 24)"; fi
    else
      chk_fail "Docker Engine nu răspunde (daemon oprit sau fără drepturi)"
    fi
    if _cv=$(docker compose version --short 2>/dev/null) && [ -n "$_cv" ]; then
      # env_file cu `required:` (docker-compose.yml) cere Compose ≥ 2.24.
      if ver_ge "$_cv" 2 24; then chk_ok "Docker Compose $_cv"; else chk_fail "Docker Compose $_cv; e necesar v2.24 sau mai nou"; fi
    else
      chk_fail "lipsește Docker Compose v2 (plugin-ul «docker compose»)"
    fi
  else
    chk_fail "Docker nu e instalat (https://docs.docker.com/engine/install/)"
  fi
  _mem=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
  _avail=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)
  if [ "${_mem:-0}" -ge 1024 ]; then chk_ok "RAM total ${_mem} MB"; else chk_fail "RAM total ${_mem:-0} MB (minim 1024 MB)"; fi
  if [ "${_avail:-0}" -lt 768 ]; then chk_warn "RAM disponibil ${_avail:-0} MB (finet-web ia până la 512 MB, worker 384 MB)"; fi
  _free=$(df -Pk "$(nearest_dir "$PREFIX")" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024 / 1024) }')
  if [ "${_free:-0}" -ge 8 ]; then chk_ok "disc liber ${_free} GB la $PREFIX"; else chk_fail "disc liber ${_free:-0} GB (minim 8 GB)"; fi
  if [ "$_os" = linux ] && [ -n "$TUI" ]; then chk_ok "interfață: $TUI"; fi
}

egress_ip() { # → stdout: IP-ul public de ieșire
  for _u in https://ifconfig.me https://api.ipify.org; do
    _ip=$(curl -fsS -m 10 "$_u" 2>/dev/null | tr -d ' \r\n') || _ip=""
    if printf '%s' "$_ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
      printf '%s' "$_ip"
      return 0
    fi
  done
  return 1
}

detect_egress() { # o singură dată; EGRESS rămâne gol dacă nu se află
  if [ -z "$EGRESS" ] && [ "$EGRESS_TRIED" = 0 ]; then
    EGRESS_TRIED=1
    EGRESS=$(egress_ip) || EGRESS=""
  fi
}

preflight_network() {
  section "Precondiții: acces de ieșire"
  if https_ok https://github.com; then chk_ok "GitHub (github.com)"; else chk_fail "nu ajung la https://github.com"; fi
  if https_ok "$GH_API"; then chk_ok "API GitHub"; else chk_fail "nu ajung la $GH_API"; fi
  if [ -n "${DB_HOSTPORTS:-}" ]; then
    for _hp in $DB_HOSTPORTS; do
      if tcp_ok "${_hp%:*}" "${_hp##*:}"; then chk_ok "Supabase ${_hp}"; else chk_fail "nu ajung la Supabase ${_hp} (firewall de ieșire?)"; fi
    done
  fi
  if [ "${AI_ENABLE_V:-nu}" = da ] && [ -n "${AI_BASE:-}" ]; then
    _ah=$(url_host "$AI_BASE")
    _ap=$(url_port "$AI_BASE")
    if tcp_ok "$_ah" "$_ap"; then chk_ok "AI_BASE_URL (${_ah}:${_ap})"; else chk_fail "nu ajung la AI_BASE_URL (${_ah}:${_ap})"; fi
  fi
  detect_egress
  if [ -n "$EGRESS" ]; then
    chk_ok "IP-ul public de ieșire: $EGRESS"
  else
    chk_warn "nu am putut afla IP-ul public de ieșire (ifconfig.me / api.ipify.org)"
  fi
}

# IP-uri libere pe rețeaua Docker (inclusiv containere oprite cu IP static).
check_ips() {
  _used=""
  if docker network inspect "$NET_NAME" >/dev/null 2>&1; then
    _used=$(docker network inspect "$NET_NAME" --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}' 2>/dev/null || :)
    _ids=$(docker ps -aq 2>/dev/null || :)
    if [ -n "$_ids" ]; then
      # shellcheck disable=SC2086
      _st=$(docker inspect --format "{{.Name}} {{with index .NetworkSettings.Networks \"$NET_NAME\"}}{{with .IPAMConfig}}{{.IPv4Address}}{{end}}{{end}}" $_ids 2>/dev/null || :)
      _used="$_used
$_st"
    fi
    chk_ok "rețeaua $NET_NAME există"
    _sn=$(docker network inspect "$NET_NAME" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || :)
    NET_EXISTING_SUBNET=$_sn
    for _ip in "$WEB_IP" "$WORKER_IP"; do
      if [ -n "$_sn" ] && ! python3 -I -c 'import ipaddress,sys; assert ipaddress.IPv4Address(sys.argv[1]) in ipaddress.IPv4Network(sys.argv[2], strict=False)' "$_ip" "$_sn" 2>/dev/null; then
        chk_fail "IP-ul $_ip nu e în subnetul $_sn al rețelei $NET_NAME"
        continue
      fi
      _who=$(printf '%s\n' "$_used" | awk -v ip="$_ip" '{ split($2, a, "/"); if (a[1] == ip && $1 !~ /^\/?finet-(web|worker)$/) print $1 }' | head -n 1)
      if [ -n "$_who" ]; then chk_fail "IP-ul $_ip e ocupat de $_who"; else chk_ok "IP-ul $_ip e liber"; fi
    done
  else
    NET_EXISTING_SUBNET=""
    note "rețeaua $NET_NAME nu există; se va crea cu subnetul $NET_SUBNET"
    _nets=$(docker network ls -q 2>/dev/null || :)
    if [ -n "$_nets" ]; then
      # shellcheck disable=SC2086
      _sub=$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' $_nets 2>/dev/null || :)
      for _s in $_sub; do
        if python3 -I -c 'import ipaddress,sys; sys.exit(0 if ipaddress.IPv4Network(sys.argv[1], strict=False).overlaps(ipaddress.IPv4Network(sys.argv[2], strict=False)) else 1)' "$NET_SUBNET" "$_s" 2>/dev/null; then
          chk_fail "subnetul $NET_SUBNET se suprapune cu o rețea Docker existentă ($_s)"
        fi
      done
    fi
    for _ip in "$WEB_IP" "$WORKER_IP"; do
      if python3 -I -c 'import ipaddress,sys; assert ipaddress.IPv4Address(sys.argv[1]) in ipaddress.IPv4Network(sys.argv[2], strict=False)' "$_ip" "$NET_SUBNET" 2>/dev/null; then
        chk_ok "IP-ul $_ip e în $NET_SUBNET"
      else
        chk_fail "IP-ul $_ip nu e în subnetul $NET_SUBNET"
      fi
    done
  fi
  if [ "$WEB_IP" = "$WORKER_IP" ]; then chk_fail "IP-urile web și worker trebuie să fie diferite"; fi
}

# ---------------------------------------------------------------------------------------------
# Colectarea parametrilor
# ---------------------------------------------------------------------------------------------
existing_secret() { [ -s "$PREFIX/secrets/$1" ]; }

# Dacă secretul există deja: întreabă dacă îl păstrează. Setează KEEP_<VAR>=da|nu.
keep_or_ask() { # VAR CHEIE FIȘIER-SECRET TEXT VALIDATOR
  _kv=$1
  eval "KEEP_$_kv=nu"
  if existing_secret "$3"; then
    askyn _keep KEEP_EXISTING_SECRETS "Secretul $3 există deja. Îl păstrez?" da
    if [ "$_keep" = da ]; then
      eval "KEEP_$_kv=da"
      eval "$_kv="
      return 0
    fi
  fi
  ask_secret "$_kv" "$2" "$4" "$5"
}

collect_common_entry() {
  section "Intrarea (Cloudflare)"
  note "Ordinea în Cloudflare: întâi aplicația Access (ops/cloudflare/README.md), apoi valorile de mai jos."
  ask ENTRY ENTRY "Intrarea: 1) tunel Cloudflare nou pe acest server (cloudflared), 2) tunel existent, 3) Traefik, 4) niciuna acum" 2 v_entry
  if [ "$ENTRY" = traefik ]; then
    ask TRAEFIK_RESOLVER TRAEFIK_RESOLVER "Numele certresolver-ului Traefik (din traefik.yml)" letsencrypt v_safename
  fi
  if [ "$ENTRY" = tunel-nou ]; then
    ask CLOUDFLARED_INSTALL CLOUDFLARED_INSTALL "Dacă lipsește cloudflared, îl descarc din release-ul oficial GitHub?" da v_yn
    ask_secret CF_TUNNEL_TOKEN_V CF_TUNNEL_TOKEN "Tokenul tunelului Cloudflare (Zero Trust → Networks → Tunnels → Install connector)" v_cftoken
  fi
}

collect_network() {
  section "Rețeaua Docker"
  _dnet=$(envget "$PREFIX/compose/compose.env" FINET_APPS_NETWORK || :)
  ask NET_NAME NET_NAME "Numele rețelei Docker externe (compose: FINET_APPS_NETWORK)" "${_dnet:-apps}" v_netname
  _dsub=172.88.88.0/24
  _dweb=172.88.88.130
  _dwrk=172.88.88.131
  if docker network inspect "$NET_NAME" >/dev/null 2>&1; then
    _es=$(docker network inspect "$NET_NAME" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || :)
    if [ -n "$_es" ]; then
      _dsub=$_es
      _base=${_es%/*}
      _base=${_base%.*}
      _dweb=$_base.130
      _dwrk=$_base.131
    fi
  fi
  _cweb=$(envget "$PREFIX/compose/compose.env" FINET_WEB_IP || :)
  _cwrk=$(envget "$PREFIX/compose/compose.env" FINET_WORKER_IP || :)
  ask NET_SUBNET NET_SUBNET "Subnetul rețelei $NET_NAME (folosit doar dacă rețeaua nu există încă)" "$_dsub" v_subnet
  ask WEB_IP WEB_IP "IP-ul static al finet-web" "${_cweb:-$_dweb}" v_ipv4
  ask WORKER_IP WORKER_IP "IP-ul static al finet-worker" "${_cwrk:-$_dwrk}" v_ipv4
}

collect_ai_new() {
  section "AI (opțional)"
  askyn AI_ENABLE_V AI_ENABLE "Activez extragerea AI din bonuri (LiteLLM/OpenAI-compatibil)?" nu
  AI_BASE=""
  AI_ASK_EFF=nu
  AI_KEY_V=""
  AI_ASK_KEY_V=""
  KEEP_AI_KEY_V=nu
  KEEP_AI_ASK_KEY_V=nu
  AI_BUDGET_V=0
  if [ "$AI_ENABLE_V" = da ]; then
    ask AI_BASE AI_BASE_URL "AI_BASE_URL (de exemplu http://gazda:4000/v1; fără implicit)" "$(envget "$PREFIX/env/finet.worker.env" AI_BASE_URL || :)" v_aibase
    _dh=$(url_hostport "$AI_BASE")
    ask AI_ALLOWED AI_ALLOWED_HOSTS "AI_ALLOWED_HOSTS (anti-SSRF; doar gazda furnizorului)" "$_dh" v_aihosts
    ask AI_BUDGET_V AI_BUDGET "Buget lunar AI (0 = nimic nu pleacă spre furnizor, recomandat până la evaluare)" 0 v_budget
    keep_or_ask AI_KEY_V AI_KEY finet_litellm_key "Cheia AI a workerului (cheie virtuală LiteLLM)" v_apikey
    askyn AI_ASK_ENABLE AI_ASK "Activez și «Întreabă FINET» (AI_ASK=1, cheie dedicată, docker-compose.ask.yml)?" nu
    if [ "$AI_ASK_ENABLE" = da ]; then
      AI_ASK_EFF=da
      keep_or_ask AI_ASK_KEY_V AI_ASK_KEY finet_ask_litellm_key "Cheia DEDICATĂ pentru «Întreabă FINET» (alta decât a workerului)" v_apikey
    fi
  fi
}

collect_supabase() {
  section "Supabase"
  detect_egress
  note "Rolurile și schema se creează de operator în Supabase (ops/supabase/README.md, roles.sql)."
  if [ -n "${EGRESS:-}" ]; then
    note "IP-ul public de ieșire al acestui server: $EGRESS"
  else
    note "IP-ul de ieșire nu a putut fi aflat; află-l cu: curl -s https://ifconfig.me"
  fi
  note "Adaugă-l în Supabase → Settings → Database → Network Restrictions ÎNAINTE de a continua."
  note "Atenție: containerele de pe rețeaua Docker pot ieși cu alt IP decât gazda (NAT/proxy); testul de conexiune de mai jos arată IP-ul real."
  askyn EGRESS_OK EGRESS_IP_ADDED "Ai adăugat IP-ul în Network Restrictions?" nu
  keep_or_ask DB_APP DB_URL_APP finet_database_url "URL-ul pooler-ului în mod TRANZACȚIE (port 6543, rol finet_app, sslmode=verify-full)" v_dburl_app
  keep_or_ask DB_MIG DB_URL_MIGRATE finet_migrate_database_url "URL-ul pooler-ului în mod SESIUNE (port 5432, rol finet_migrator, sslmode=verify-full)" v_dburl_mig
  note "URL-ul workerului se derivă din cel al aplicației (același rol, portul 5432)."
  DB_HOSTPORTS=""
  if [ -n "$DB_APP" ]; then DB_HOSTPORTS="$(url_hostport "$DB_APP")"; fi
  if [ -n "$DB_MIG" ]; then DB_HOSTPORTS="$DB_HOSTPORTS $(url_hostport "$DB_MIG")"; fi
  _caold=$(find "$PREFIX/ca" -maxdepth 1 -type f \( -name '*.crt' -o -name '*.pem' \) 2>/dev/null | head -n 1 || :)
  ask CA_SRC CA_SRC "CA-ul Supabase: cale locală sau URL https:// (Settings → Database → SSL Configuration)" "$_caold" v_nonempty
  CA_LOCAL=""
  case $CA_SRC in
    https://*)
      if [ "$DRY" = 1 ]; then
        CA_NAME=$(basename "$CA_SRC")
      else
        CA_LOCAL=$TMP/ca-download.crt
        curl -fsSL -m 30 -o "$CA_LOCAL" "$CA_SRC" || die "Nu am putut descărca CA-ul de la URL-ul dat."
        CA_NAME=$(basename "$CA_SRC")
      fi
      ;;
    /*)
      CA_LOCAL=$CA_SRC
      CA_NAME=$(basename "$CA_SRC")
      [ -r "$CA_LOCAL" ] || die "Nu pot citi fișierul CA: $CA_SRC"
      ;;
    *) die "CA_SRC trebuie să fie o cale absolută sau un URL https://." ;;
  esac
  case $CA_NAME in *.crt | *.pem) ;; *) CA_NAME=$CA_NAME.crt ;; esac
  _val=$CA_NAME
  v_cafile || die "Numele fișierului CA nu e acceptat: $_err"
  if [ -n "$CA_LOCAL" ]; then
    [ "$(wc -c <"$CA_LOCAL")" -le 65536 ] || die "CA-ul depășește 64 KiB."
    grep -q 'BEGIN CERTIFICATE' "$CA_LOCAL" || die "Fișierul CA nu e un certificat PEM."
  fi
}

collect_admin() {
  section "Primul utilizator (administratorul platformei)"
  ask ADMIN_EMAIL ADMIN_EMAIL "Email-ul administratorului" "" v_email
  ask ADMIN_NAME ADMIN_NAME "Numele afișat" "" v_nonempty
  askyn ADMIN_GEN ADMIN_PASSWORD_GEN_UNUSED "Generez eu parola (o afișez o singură dată pe terminal)?" da
  ADMIN_PASS=""
  if [ -n "$ANSWERS" ]; then
    ask_secret ADMIN_PASS ADMIN_PASSWORD "Parola administratorului" v_pass
    ADMIN_GEN=nu
  elif [ "$ADMIN_GEN" = nu ]; then
    ask_secret ADMIN_PASS ADMIN_PASSWORD "Parola administratorului (minim 12 caractere)" v_pass
  fi
}

collect_images() {
  section "Imaginile (din CI, fără build local)"
  if [ "$MODE" = move ]; then
    # La mutare, baza (Supabase) e comună cu serverul vechi, care poate rămâne pornit: imaginile
    # trebuie să aibă exact migrațiile pe care le știe deja baza, deci SHA-ul de pe serverul vechi.
    ask IMAGES_SHA_V IMAGES_SHA "SHA-ul imaginilor: auto = SHA-ul rulat pe serverul vechi (${OLD_SHA:-necunoscut}); alt SHA cere confirmare (migrațiile noi s-ar aplica pe baza comună)" auto v_sha
  else
    ask IMAGES_SHA_V IMAGES_SHA "SHA-ul imaginilor: auto = ultimul commit de pe main cu artefacte neexpirate, sau SHA complet" auto v_sha
  fi
  if [ "$DRY" = 1 ] && [ -z "$ANSWERS" ]; then
    note "tokenul GitHub nu se cere în verificare"
    GH_TOKEN_V=""
  else
    ask_secret GH_TOKEN_V GITHUB_TOKEN "Tokenul GitHub (Actions: read; descărcarea artefactelor cere autentificare)" v_nonempty
  fi
  askyn GH_KEEP GITHUB_TOKEN_KEEP "Păstrez tokenul în $PREFIX/github-token (root, 600) pentru actualizări viitoare?" nu
}

collect_backup() {
  section "Backup (restic → rclone)"
  askyn BACKUP_ON BACKUP_ENABLE "Configurez backup-ul zilnic acum?" da
  BACKUP_READY=nu
  if [ "$BACKUP_ON" != da ]; then return 0; fi
  askyn BK_ROLE BACKUP_PG_ROLE_EXISTS "Rolul finet_backup există în Supabase (ops/backup/backup-role.sql, rulat de operator)?" nu
  if [ "$BK_ROLE" != da ]; then
    note "Backup-ul se omite acum. Rulează ops/backup/backup-role.sql, apoi reia installer-ul."
    BACKUP_ON=nu
    return 0
  fi
  ask RCLONE_CONF_SRC RCLONE_CONF "Fișierul de configurare rclone al root-ului" /root/.config/rclone/rclone.conf v_abspath
  ask RCLONE_REMOTE_V RCLONE_REMOTE "Numele remote-ului rclone" Gdrive v_safename
  ask BACKUP_PATH_V BACKUP_PATH "Calea în remote pentru repository-ul restic" finet-backup/restic v_safepath
  _bu=""
  if [ -n "${DB_MIG:-}" ]; then _bu=$(printf '%s' "$DB_MIG" | sed -n 's#^[a-z]*://[^:@]*\.\([^:@.]*\):.*#\1#p'); fi
  ask BACKUP_PG_USER_V BACKUP_PG_USER "Utilizatorul rolului de backup pe pooler (<rol>.<ref-proiect>)" "finet_backup${_bu:+.$_bu}" v_safename
  keep_or_ask BK_PG_PASS BACKUP_PG_PASSWORD finet_backup_pg_service "Parola rolului finet_backup" v_nonempty
  KEEP_RESTIC=nu
  RESTIC_PASS=""
  RESTIC_GEN=nu
  if existing_secret finet_restic_password; then
    askyn _keepr KEEP_EXISTING_SECRETS "Parola restic există deja (finet_restic_password). O păstrez?" da
    [ "$_keepr" = da ] && KEEP_RESTIC=da
  fi
  if [ "$KEEP_RESTIC" = nu ]; then
    askyn RESTIC_GEN_ASK RESTIC_PASSWORD_GEN_UNUSED "Generez eu parola restic (o afișez o singură dată)?" da
    if [ -n "$ANSWERS" ]; then
      ask_secret RESTIC_PASS RESTIC_PASSWORD "Parola restic" v_pass
    elif [ "$RESTIC_GEN_ASK" = da ]; then
      RESTIC_GEN=da
    else
      ask_secret RESTIC_PASS RESTIC_PASSWORD "Parola restic (minim 12 caractere; păstreaz-o și în afara serverului)" v_pass
    fi
  fi
  askyn BACKUP_TEST BACKUP_TEST_RUN "Rulez un backup de probă la final?" da
  BACKUP_READY=da
}
v_safepath() {
  printf '%s' "$_val" | grep -Eq '^[A-Za-z0-9._/-]+$' || {
    _err="cale invalidă"
    return 1
  }
}

collect_cron() {
  section "Cron (fișier dedicat în cron.d; crontab-ul root nu se modifică)"
  askyn CRON_ON CRON_ENABLE "Instalez joburile zilnice (curățare 04:25/04:30, agregare 04:35, backup 05:10)?" da
  CRON_IDEMP_ON=nu
  if [ "$CRON_ON" = da ]; then
    askyn CRON_IDEMP_ON CRON_IDEMPOTENCY "Adaug și curățarea cheilor de idempotență 04:15 (opțională; nu e în producția actuală)?" nu
  fi
}

collect_new() {
  section "Aplicația"
  ask APP_HOST APP_HOST "Hostname-ul public (fără https://), de exemplu finet.exemplu.ro" "$(envget "$PREFIX/env/finet.env" APP_URL | sed 's#^https://##' || :)" v_hostname
  collect_network
  collect_common_entry
  ask CF_TEAM_V CF_TEAM "CF_ACCESS_TEAM_DOMAIN (<echipa>.cloudflareaccess.com; gol = nu-l am încă)" "$(envget "$PREFIX/env/finet.env" CF_ACCESS_TEAM_DOMAIN | grep -v 'exemplu' || :)" v_cfteam
  ask CF_AUD_V CF_AUD "CF_ACCESS_AUD (tag-ul aplicației Access; gol = nu-l am încă)" "$(envget "$PREFIX/env/finet.env" CF_ACCESS_AUD | grep -v 'exemplu' || :)" v_cfaud
  if [ -z "$CF_TEAM_V" ] || [ -z "$CF_AUD_V" ]; then
    CAN_START=0
    note "Fără CF_ACCESS_* finet-web nu poate porni: creez fișierele, dar NU îl pornesc."
  fi
  collect_ai_new
  collect_supabase
  collect_admin
  keep_or_ask_ba
  collect_images
  collect_backup
  collect_cron
}
keep_or_ask_ba() { # secretele generate: se păstrează dacă există
  BA_EXISTS=nu
  HT_EXISTS=nu
  if existing_secret finet_better_auth_secret; then
    BA_EXISTS=da
    note "finet_better_auth_secret există: se păstrează (rotirea invalidează toate sesiunile)."
  fi
  if existing_secret finet_health_token; then HT_EXISTS=da; fi
}

# Determină SHA-ul rulat pe serverul vechi → $OLD_SHA (gol = necunoscut). Sursa principală e eticheta
# imaginii REALE a containerului finet-web (finet:web-<sha>, pusă de pull-images.sh), nu checkout-ul:
# un `git pull` în /srv/finet/src ar muta HEAD fără ca imaginile să se schimbe. Checkout-ul
# (<prefix>/src, HEAD) servește doar la confirmare: dacă lipsește eticheta sau diferă de HEAD,
# SHA-ul rămâne necunoscut și mutarea cere confirmare explicită. Doar citire peste SSH; fiecare
# comandă întâi fără sudo, apoi `sudo -n`; safe.directory prin -c (proprietarul diferă de utilizatorul SSH).
read_old_sha() {
  OLD_SHA=""
  _ssh=$(ssh_cmd_str)
  _hd="git -c safe.directory=$MOVE_PREFIX/src -C $MOVE_PREFIX/src rev-parse HEAD"
  _tg="i=\$(docker inspect finet-web --format '{{.Image}}' 2>/dev/null || sudo -n docker inspect finet-web --format '{{.Image}}' 2>/dev/null); [ -n \"\$i\" ] || i=finet:local; docker image inspect \"\$i\" --format '{{range .RepoTags}}{{println .}}{{end}}' 2>/dev/null || sudo -n docker image inspect \"\$i\" --format '{{range .RepoTags}}{{println .}}{{end}}' 2>/dev/null"
  # shellcheck disable=SC2086
  _head=$($_ssh "$MOVE_SRC_V" "$_hd 2>/dev/null || sudo -n $_hd 2>/dev/null" 2>/dev/null | head -n 1 | tr -d '\r ') || _head=""
  case $_head in
    auto | "" | *[!0-9a-f]*) _head="" ;;
    *) if [ "${#_head}" -ne 40 ]; then _head=""; fi ;;
  esac
  # shellcheck disable=SC2086
  _tags=$($_ssh "$MOVE_SRC_V" "$_tg" 2>/dev/null | tr -d '\r' | sed -n 's/^finet:web-\([0-9a-f]\{40\}\)$/\1/p' | sort -u) || _tags=""
  _tagn=$(printf '%s\n' "$_tags" | grep -c .) || _tagn=0
  if [ "$_tagn" -eq 1 ]; then _tag=$_tags; else _tag=""; fi
  if [ -n "$_tag" ] && { [ -z "$_head" ] || [ "$_tag" = "$_head" ]; }; then
    OLD_SHA=$_tag
    note "SHA-ul imaginii rulate pe serverul vechi (finet-web): $OLD_SHA${_head:+, identic cu HEAD din $MOVE_PREFIX/src}"
    return 0
  fi
  if [ -n "$_tag" ]; then
    note "ATENȚIE: imaginea rulată pe serverul vechi e la $_tag, dar checkout-ul $MOVE_PREFIX/src e la $_head (un git pull după deploy?)."
  elif [ "$_tagn" -gt 1 ]; then
    note "ATENȚIE: imaginea finet-web de pe serverul vechi are mai multe etichete finet:web-<sha>; nu pot alege."
  else
    note "Nu am putut citi SHA-ul rulat pe serverul vechi: lipsește eticheta finet:web-<sha> a imaginii finet-web, conexiune SSH eșuată (cheia gazdei neacceptată? în --answers se folosește BatchMode) sau fără drept docker/sudo -n."
  fi
  note "SHA-ul serverului vechi rămâne NECUNOSCUT (imagine: ${_tag:-?}; checkout: ${_head:-?}); mutarea cere SHA explicit și confirmare."
}

# Autentificat doar dacă există token (fișierul pas-cu-pas sau valoarea colectată); antetul trece pe
# stdin prin printf (builtin), nu în argumentele curl.
gh_get() { # URL → stdout
  _gt=""
  if [ -n "$GH_TOKEN_FILE" ] && [ -s "$GH_TOKEN_FILE" ]; then
    _gt=$(tr -d '\r\n ' <"$GH_TOKEN_FILE")
  elif [ -n "${GH_TOKEN_V:-}" ]; then
    _gt=$(printf '%s' "$GH_TOKEN_V" | tr -d '\r\n ')
  fi
  if [ -n "$_gt" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$_gt" | curl -fsS -m 60 -K - -H 'Accept: application/vnd.github+json' "$1"
  else
    curl -fsS -m 60 -H 'Accept: application/vnd.github+json' "$1"
  fi
}

# Artefactele web, tools și backup ale SHA-ului $1 există și nu au expirat? 0 = da; 1 = nu (lipsă sau
# expirate, se păstrează 7 zile); 2 = n-am putut întreba GitHub (inconcludent).
artifacts_complete() {
  gh_get "$GH_API/repos/$GITHUB_REPO/actions/workflows/images.yml/runs?head_sha=$1&event=push&status=success&per_page=10" >"$TMP/runs-sha.json" 2>/dev/null || return 2
  python3 -I -c '
import json, sys
for r in json.load(open(sys.argv[1])).get("workflow_runs", []):
    if r.get("event") == "push" and r.get("conclusion") == "success" and r.get("head_branch") == "main" and r.get("head_sha") == sys.argv[2]:
        print(r["id"])
' "$TMP/runs-sha.json" "$1" >"$TMP/runs-sha.txt" || return 2
  _aerr=0
  while read -r _rid; do
    if gh_get "$GH_API/repos/$GITHUB_REPO/actions/runs/$_rid/artifacts?per_page=100" >"$TMP/art-sha.json" 2>/dev/null; then
      if python3 -I -c '
import json, sys
sha = sys.argv[2]
ok = {a["name"] for a in json.load(open(sys.argv[1])).get("artifacts", []) if not a.get("expired")}
sys.exit(0 if all("finet-%s-%s" % (n, sha) in ok for n in ("web", "tools", "backup")) else 1)
' "$TMP/art-sha.json" "$1"; then
        return 0
      fi
    else
      _aerr=1
    fi
  done <"$TMP/runs-sha.txt"
  if [ "$_aerr" = 1 ]; then return 2; fi
  return 1
}

# Decide SHA-ul imaginilor la mutare. Implicit = SHA-ul imaginii rulate pe serverul vechi. Un alt SHA
# (sau unul care nu poate fi comparat) poate aduce migrații pe care baza comună nu le are:
# finet-migrate le-ar aplica pe baza de producție cât serverul vechi încă rulează, deci cere
# confirmare explicită (MOVE_SHA_DIFERIT=da în răspunsuri). Apoi verifică devreme artefactele CI ale
# SHA-ului ales (expiră în 7 zile), ca eșecul să nu vină abia la pull-images.sh, după rsync.
# În --check eșecurile sunt raportate (chk_fail), nu fatale.
move_check_sha() {
  MOVE_SHA_OK=nu
  move_decide_sha
  [ -n "$IMAGES_SHA_V" ] || return 0
  _ar=0
  artifacts_complete "$IMAGES_SHA_V" || _ar=$?
  case $_ar in
    0) chk_ok "artefactele CI (web, tools, backup) pentru $IMAGES_SHA_V există și nu au expirat" ;;
    2) chk_warn "nu am putut verifica artefactele CI ale $IMAGES_SHA_V (GitHub inaccesibil); pull-images.sh le va cere" ;;
    *)
      _msg="Mutare: artefactele CI (web, tools, backup) pentru $IMAGES_SHA_V lipsesc sau au expirat (se păstrează 7 zile). Variante: (1) re-rulează workflow-ul images pentru acel commit în GitHub (Re-run jobs), apoi reia; (2) dă un IMAGES_SHA recent cu artefacte, după ce ai verificat că nu are migrații noi față de serverul vechi (git diff --name-only <SHA-vechi> <SHA-nou> -- src/db/migrations), cu MOVE_SHA_DIFERIT=da; (3) oprește întâi serverul vechi. Nu s-a atins nimic."
      if [ "$DRY" = 1 ]; then
        chk_fail "$_msg"
      else
        die "$_msg"
      fi
      ;;
  esac
}

move_decide_sha() {
  if [ "$IMAGES_SHA_V" = auto ]; then
    if [ -n "$OLD_SHA" ]; then
      IMAGES_SHA_V=$OLD_SHA
      note "Imaginile vor fi cele de la SHA-ul de pe serverul vechi: $OLD_SHA"
      return 0
    fi
    IMAGES_SHA_V=""
    _msg="Mutare: SHA-ul rulat pe serverul vechi e necunoscut, deci «auto» nu are ce alege. Dă IMAGES_SHA explicit (SHA-ul rulat pe serverul vechi) și confirmă cu MOVE_SHA_DIFERIT=da. Nu s-a atins baza."
    if [ "$DRY" = 1 ]; then
      chk_fail "$_msg"
      return 0
    fi
    die "$_msg"
  fi
  if [ -n "$OLD_SHA" ] && [ "$IMAGES_SHA_V" = "$OLD_SHA" ]; then return 0; fi
  say "  ATENȚIE: SHA-ul ales ($IMAGES_SHA_V) nu e cel rulat pe serverul vechi (${OLD_SHA:-necunoscut})."
  say "  Dacă are migrații noi, finet-migrate le aplică pe baza de producție COMUNĂ cât serverul vechi încă rulează."
  askyn MOVE_SHA_OK MOVE_SHA_DIFERIT "Confirm că ținta poate avea migrații noi față de serverul vechi?" nu
  if [ "$MOVE_SHA_OK" = da ]; then return 0; fi
  if [ "$DRY" = 1 ]; then
    chk_fail "mutare: SHA-ul imaginilor diferă de cel rulat pe serverul vechi (sau acesta e necunoscut) și nu e confirmat (MOVE_SHA_DIFERIT=da)"
    return 0
  fi
  die "Mutare: SHA-ul imaginilor diferă de cel rulat pe serverul vechi (${OLD_SHA:-necunoscut}) și nu e confirmat. Nu s-a atins baza. Folosește «auto» sau confirmă explicit (MOVE_SHA_DIFERIT=da)."
}

collect_move() {
  section "Mutare de pe un server existent"
  say "  ATENȚIE: secretul Better Auth (finet_better_auth_secret) trebuie să rămână IDENTIC cu cel de pe serverul vechi."
  say "  Dacă se schimbă, toate sesiunile și tokenurile bearer (aplicația Android) devin invalide."
  say "  Installer-ul îl copiază cu rsync și NU îl regenerează; verifică la final că sumele coincid."
  say "  Pe serverul vechi: utilizatorul trebuie să poată rula \`sudo rsync\` fără parolă (fișierele sunt root 600)."
  ask MOVE_SRC_V MOVE_SRC "Serverul sursă (utilizator@gazdă)" "" v_userhost
  ask MOVE_KEY MOVE_SSH_KEY "Calea cheii SSH (gol = agentul/configul SSH al root-ului; sub sudo agentul cere --preserve-env=SSH_AUTH_SOCK)" "" v_remotepath_or_empty
  ask MOVE_PREFIX MOVE_SRC_PREFIX "Directorul FINET pe serverul vechi" /srv/finet v_remotepath
  collect_network
  collect_common_entry
  read_old_sha
  collect_images
  move_check_sha
  detect_egress
  note "IP-ul public de ieșire al acestui server: ${EGRESS:-necunoscut (află-l cu: curl -s https://ifconfig.me)}"
  askyn EGRESS_OK EGRESS_IP_ADDED "Ai adăugat IP-ul public al ACESTUI server în Supabase → Network Restrictions? (IP-ul se afișează la verificarea de rețea; poți lăsa și IP-ul vechi până la mutare)" nu
  askyn BACKUP_ON BACKUP_ENABLE "Programez backup-ul zilnic (secretele de backup vin din copie)?" da
  BACKUP_READY=nu
  if [ "$BACKUP_ON" = da ]; then
    ask RCLONE_REMOTE_V RCLONE_REMOTE "Numele remote-ului rclone (verificat din finet_rclone_conf copiat)" Gdrive v_safename
    askyn BACKUP_TEST BACKUP_TEST_RUN "Rulez un backup de probă la final?" da
    BACKUP_READY=da
  fi
  collect_cron
  ask FINAL_SYNC MOVE_FINAL_SYNC "Este acesta sincronizarea FINALĂ a storage-ului (containerele vechi sunt deja oprite)?" nu v_yn
  AI_ASK_EFF=nu
}

# ---------------------------------------------------------------------------------------------
# Rezumat și confirmare
# ---------------------------------------------------------------------------------------------
secret_status() { # VAR-KEEP, fișier
  if existing_secret "$2"; then
    case $1 in da) printf 'se păstrează' ;; *) printf 'se înlocuiește (backup .bak-%s)' "$DATE" ;; esac
  else
    printf 'se creează'
  fi
}
print_summary() {
  section "Rezumat"
  note "Mod: $MODE$([ "$DRY" = 1 ] && printf ' (doar verificare: nu se scrie nimic)')"
  note "Director: $PREFIX (checkout: $PREFIX/src)"
  note "Rețea Docker: $NET_NAME; web ${WEB_IP}, worker ${WORKER_IP}; subnet nou (dacă lipsește): $NET_SUBNET"
  note "Intrare: $ENTRY"
  note "Imagini: SHA ${IMAGES_SHA_V:-?}; token GitHub: $([ "$GH_KEEP" = da ] && printf 'se păstrează' || printf 'se șterge la final')"
  if [ "$MODE" = move ]; then
    note "Sursă: $MOVE_SRC_V:$MOVE_PREFIX → rsync -aHAX --numeric-ids (env, secrets, ca, compose, storage), backup .bak-$DATE la fișierele înlocuite"
    note "Better Auth: copiat, NU regenerat"
  else
    note "Hostname: $APP_HOST; Access: $([ "$CAN_START" = 1 ] && printf 'complet' || printf 'INCOMPLET (finet-web nu se pornește)')"
    note "AI: $AI_ENABLE_V$([ "$AI_ENABLE_V" = da ] && printf ' (%s; ask=%s; buget %s)' "$AI_BASE" "$AI_ASK_EFF" "$AI_BUDGET_V")"
    note "Secrete: finet_database_url: $(secret_status "${KEEP_DB_APP:-nu}" finet_database_url)"
    note "         finet_migrate_database_url: $(secret_status "${KEEP_DB_MIG:-nu}" finet_migrate_database_url)"
    note "         finet_better_auth_secret: $([ "$BA_EXISTS" = da ] && printf 'se păstrează' || printf 'se generează direct în fișier')"
    note "         finet_health_token: $([ "$HT_EXISTS" = da ] && printf 'se păstrează' || printf 'se generează direct în fișier')"
    note "CA Supabase: $CA_NAME"
    note "Administrator: $ADMIN_EMAIL (parola: $([ "$ADMIN_GEN" = da ] && printf 'generată, afișată o dată' || printf 'dată de tine, prin stdin'))"
  fi
  note "Backup: ${BACKUP_ON:-nu}$([ "${BACKUP_READY:-nu}" = da ] && [ "$MODE" = new ] && printf ' (repository restic: rclone:%s:%s)' "$RCLONE_REMOTE_V" "$BACKUP_PATH_V"); cron: ${CRON_ON:-nu}"
  note "Pe serverul VECHI (dacă există): oprește containerele și scoate cron-urile FINET, altfel rulează dublu."
}

confirm() {
  if [ "$DRY" = 1 ]; then return 0; fi
  if [ -n "$TUI" ] && [ -z "$ANSWERS" ]; then
    $TUI --title "FINET — instalare" --defaultno --yesno "Aplic?" 8 40 || die "Nu s-a aplicat nimic (răspuns: nu)."
    return 0
  fi
  ask CONFIRM_V CONFIRM "Aplic? [da/NU]" nu v_yn
  [ "$CONFIRM_V" = da ] || die "Nu s-a aplicat nimic (răspuns: nu)."
}

# ---------------------------------------------------------------------------------------------
# Aplicarea
# ---------------------------------------------------------------------------------------------
find_images_sha() {
  if [ "$MODE" = move ] && [ -z "$IMAGES_SHA_V" ]; then
    SHA=""
    return 0 # doar în --check, cu eșecul deja raportat de move_check_sha
  fi
  if [ "$IMAGES_SHA_V" != auto ]; then
    SHA=$IMAGES_SHA_V
    note "SHA ales de operator: $SHA"
    return 0
  fi
  gh_get "$GH_API/repos/$GITHUB_REPO/actions/workflows/images.yml/runs?branch=main&event=push&status=success&per_page=10" >"$TMP/runs.json" ||
    die "Nu am putut citi rulările workflow-ului images din GitHub."
  python3 -I -c '
import json, sys
for r in json.load(open(sys.argv[1])).get("workflow_runs", []):
    if r.get("event") == "push" and r.get("conclusion") == "success" and r.get("head_branch") == "main":
        print(r["id"], r["head_sha"])
' "$TMP/runs.json" >"$TMP/runs.txt"
  SHA=""
  while read -r _rid _rsha; do
    gh_get "$GH_API/repos/$GITHUB_REPO/actions/runs/$_rid/artifacts?per_page=100" >"$TMP/art.json" || continue
    if python3 -I -c '
import json, sys
sha = sys.argv[2]
ok = {a["name"] for a in json.load(open(sys.argv[1])).get("artifacts", []) if not a.get("expired")}
sys.exit(0 if all("finet-%s-%s" % (n, sha) in ok for n in ("web", "tools", "backup")) else 1)
' "$TMP/art.json" "$_rsha"; then
      SHA=$_rsha
      break
    fi
  done <"$TMP/runs.txt"
  [ -n "$SHA" ] || die "Nicio rulare images reușită pe main nu are toate cele 3 artefacte (web, tools, backup) neexpirate (se păstrează 7 zile). Fă un push pe main sau dă IMAGES_SHA; o rulare workflow_dispatch NU e acceptată de pull-images.sh."
  note "SHA-ul imaginilor: $SHA (ultimul commit de pe main cu artefacte complete)"
}

step_token() {
  if [ "$DRY" = 1 ] && [ -z "${GH_TOKEN_V:-}" ]; then
    note "[verificare] tokenul GitHub nu e disponibil; căutarea SHA merge fără autentificare, descărcarea artefactelor ar cere token"
    return 0
  fi
  (
    umask 077
    printf '%s' "$GH_TOKEN_V" >"$TMP/gh.token"
  )
  GH_TOKEN_FILE=$TMP/gh.token
  [ -s "$GH_TOKEN_FILE" ] || die "Tokenul GitHub e gol."
}

step_dirs() {
  section "Directoare"
  for _spec in "root root 755 $PREFIX" "root root 700 $PREFIX/env" "root root 700 $PREFIX/secrets" "root root 755 $PREFIX/compose" "root root 755 $PREFIX/ca" "1000 1000 700 $PREFIX/storage" "root root 700 $PREFIX/backup-state"; do
    # shellcheck disable=SC2086
    set -- $_spec
    if [ -d "$4" ]; then
      note "există: $4"
    else
      act "creez $4 (proprietar $1:$2, mod $3)" install -d -o "$1" -g "$2" -m "$3" "$4"
    fi
  done
}

step_src() {
  section "Checkout-ul root-owned (/srv/finet/src) la SHA-ul imaginilor"
  SRC=$PREFIX/src
  if [ -d "$SRC/.git" ]; then
    act "actualizez checkout-ul existent ($SRC)" git -C "$SRC" fetch --quiet origin
  else
    act "clonez $GIT_URL în $SRC" git clone --quiet "$GIT_URL" "$SRC"
  fi
  act "pun checkout-ul pe $SHA (detached)" git -C "$SRC" checkout --quiet --detach "$SHA"
  if [ "$DRY" = 0 ]; then
    if [ -n "$(find "$SRC" -perm /022 -not -type l 2>/dev/null | head -n 1)" ]; then die "$SRC are fișiere scriibile de grup/alții; run-backup.sh refuză un astfel de checkout (LOW-1)."; fi
    if [ -n "$(find "$SRC" ! -user root 2>/dev/null | head -n 1)" ]; then die "$SRC conține fișiere care nu aparțin lui root."; fi
    chk_ok "checkout root:root, fără drept de scriere pentru grup/alții"
  fi
}

install_from_example() { # model destinație
  if [ -e "$2" ]; then
    note "există: $2 (se păstrează; doar cheile din wizard se actualizează)"
  else
    act "creez $2 din $(basename "$1")" install -o root -g root -m 600 "$1" "$2"
    FRESH_FILES="$FRESH_FILES $2"
  fi
}

step_env_new() {
  section "Fișiere de mediu (nesecrete)"
  _ex=$SRC/ops/docker
  if [ "$DRY" = 1 ] && [ ! -d "$_ex" ]; then _ex=$REPO_HERE/ops/docker; fi
  install_from_example "$_ex/finet.env.example" "$PREFIX/env/finet.env"
  install_from_example "$_ex/finet.worker.env.example" "$PREFIX/env/finet.worker.env"
  install_from_example "$_ex/finet.migrate.env.example" "$PREFIX/env/finet.migrate.env"
  install_from_example "$_ex/finet.admin.env.example" "$PREFIX/env/finet.admin.env"
  install_from_example "$_ex/compose.env.example" "$PREFIX/compose/compose.env"
  install_from_example "$(dirname "$_ex")/notify/notify.env.example" "$PREFIX/env/notify.env"
  envapply "$PREFIX/env/finet.env" set APP_URL "https://$APP_HOST"
  envapply "$PREFIX/env/finet.env" set CF_ACCESS_TEAM_DOMAIN "${CF_TEAM_V:-}"
  envapply "$PREFIX/env/finet.env" set CF_ACCESS_AUD "${CF_AUD_V:-}"
  envapply "$PREFIX/env/finet.env" set AI_MONTHLY_BUDGET "$AI_BUDGET_V"
  envapply "$PREFIX/env/finet.worker.env" set AI_MONTHLY_BUDGET "$AI_BUDGET_V"
  if [ "$AI_ENABLE_V" = da ]; then
    envapply "$PREFIX/env/finet.worker.env" set AI_BASE_URL "$AI_BASE"
    envapply "$PREFIX/env/finet.worker.env" set AI_ALLOWED_HOSTS "$AI_ALLOWED"
  else
    # Exemplul vine cu gazda LiteLLM din producția docker-apps: pe un server nou nu există.
    envapply "$PREFIX/env/finet.worker.env" comment AI_BASE_URL
    envapply "$PREFIX/env/finet.worker.env" comment AI_ALLOWED_HOSTS
  fi
  if [ "$AI_ASK_EFF" = da ]; then
    envapply "$PREFIX/env/finet.env" set AI_ASK 1
    envapply "$PREFIX/env/finet.env" set AI_BASE_URL "$AI_BASE"
    envapply "$PREFIX/env/finet.env" set AI_ALLOWED_HOSTS "$AI_ALLOWED"
  else
    envapply "$PREFIX/env/finet.env" set AI_ASK 0
  fi
  step_compose_env
}
step_compose_env() {
  envapply "$PREFIX/compose/compose.env" set FINET_HOST "${APP_HOST:-$(envget "$PREFIX/compose/compose.env" FINET_HOST)}"
  envapply "$PREFIX/compose/compose.env" set FINET_APPS_NETWORK "$NET_NAME"
  envapply "$PREFIX/compose/compose.env" set FINET_WEB_IP "$WEB_IP"
  envapply "$PREFIX/compose/compose.env" set FINET_WORKER_IP "$WORKER_IP"
  envapply "$PREFIX/compose/compose.env" set FINET_ENV_DIR "$PREFIX/env"
  envapply "$PREFIX/compose/compose.env" set FINET_DATA_DIR "$PREFIX"
  envapply "$PREFIX/compose/compose.env" set FINET_SECRETS_DIR "$PREFIX/secrets"
  envapply "$PREFIX/compose/compose.env" set FINET_CA_DIR "$PREFIX/ca"
  if [ -n "${CA_NAME:-}" ]; then envapply "$PREFIX/compose/compose.env" set FINET_DATABASE_CA_NAME "$CA_NAME"; fi
  if [ "$ENTRY" = traefik ]; then
    envapply "$PREFIX/compose/compose.env" set FINET_TRAEFIK_ENABLE true
    envapply "$PREFIX/compose/compose.env" set FINET_CERTRESOLVER "$TRAEFIK_RESOLVER"
  else
    envapply "$PREFIX/compose/compose.env" set FINET_TRAEFIK_ENABLE false
  fi
}

# put_secret FIȘIER VARIABILĂ KEEP : scrie valoarea din variabilă (cu backup) sau păstrează.
put_secret() {
  _f=$PREFIX/secrets/$1
  if [ "$3" = da ] && [ -s "$_f" ]; then
    note "păstrat: $1"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar scrie $1 (1000:1000, mod 400)$([ -e "$_f" ] && printf ', cu backup .bak-%s' "$DATE")"
    return 0
  fi
  if [ -e "$_f" ] && [ ! -e "$_f.bak-$DATE" ]; then cp -p "$_f" "$_f.bak-$DATE"; fi
  eval "printf '%s' \"\$$2\"" | install -o 1000 -g 1000 -m 400 /dev/stdin "$_f" || die "Nu pot scrie secretul $1."
  note "scris: $1"
}
# gen_secret FIȘIER hex|base64: generat direct în fișier, doar dacă lipsește.
gen_secret() {
  _f=$PREFIX/secrets/$1
  if [ -s "$_f" ]; then
    note "păstrat: $1"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar genera $1 (openssl rand, direct în fișier, 1000:1000 mod 400)"
    return 0
  fi
  case $2 in
    hex) openssl rand -hex 32 ;;
    *) openssl rand -base64 32 ;;
  esac | install -o 1000 -g 1000 -m 400 /dev/stdin "$_f" || die "Nu pot genera $1."
  note "generat: $1"
}

step_secrets_new() {
  section "Secrete (fișiere 1000:1000, mod 400)"
  put_secret finet_database_url DB_APP "${KEEP_DB_APP:-nu}"
  if [ -z "$DB_APP" ] && [ ! -s "$PREFIX/secrets/finet_worker_database_url" ] && [ "$DRY" = 0 ]; then
    DB_APP=$(cat "$PREFIX/secrets/finet_database_url")
    SECRET_VARS="$SECRET_VARS DB_APP"
  fi
  if [ -n "$DB_APP" ]; then
    DB_WORKER=$(printf '%s' "$DB_APP" | sed 's#:6543/#:5432/#')
    SECRET_VARS="$SECRET_VARS DB_WORKER"
    put_secret finet_worker_database_url DB_WORKER nu
  else
    note "păstrat: finet_worker_database_url (derivat din cel al aplicației la crearea lui)"
  fi
  put_secret finet_migrate_database_url DB_MIG "${KEEP_DB_MIG:-nu}"
  gen_secret finet_health_token hex
  gen_secret finet_better_auth_secret base64
  if [ "$AI_ENABLE_V" = da ]; then
    put_secret finet_litellm_key AI_KEY_V "${KEEP_AI_KEY_V:-nu}"
  elif [ -s "$PREFIX/secrets/finet_litellm_key" ]; then
    note "păstrat: finet_litellm_key"
  elif [ "$DRY" = 1 ]; then
    note "[verificare] ar crea finet_litellm_key cu o valoare de umplere (AI oprit; compose cere fișierul, iar config.ts refuză un fișier gol)"
  else
    printf '%s' 'ai-dezactivat-fara-cheie' | install -o 1000 -g 1000 -m 400 /dev/stdin "$PREFIX/secrets/finet_litellm_key" || die "Nu pot scrie finet_litellm_key."
    note "scris: finet_litellm_key (valoare de umplere; AI oprit)"
  fi
  if [ "$AI_ASK_EFF" = da ]; then put_secret finet_ask_litellm_key AI_ASK_KEY_V "${KEEP_AI_ASK_KEY_V:-nu}"; fi
  # CA-ul (public)
  _caf=$PREFIX/ca/$CA_NAME
  if [ -e "$_caf" ] && [ -n "$CA_LOCAL" ] && cmp -s "$CA_LOCAL" "$_caf"; then
    note "CA identic, existent: $_caf"
  elif [ -e "$_caf" ]; then
    note "CA-ul $_caf diferă: se înlocuiește cu backup .bak-$DATE"
    if [ "$DRY" = 0 ]; then cp -p "$_caf" "$_caf.bak-$DATE"; fi
    act "instalez CA-ul în $_caf" install -o root -g root -m 644 "$CA_LOCAL" "$_caf"
  elif [ "$DRY" = 1 ]; then
    note "[verificare] ar instala CA-ul în $_caf (root, 644)"
  else
    act "instalez CA-ul în $_caf" install -o root -g root -m 644 "$CA_LOCAL" "$_caf"
  fi
}

ssh_cmd_str() {
  _s="ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=yes"
  if [ -n "$ANSWERS" ]; then _s="$_s -o BatchMode=yes"; fi
  if [ -n "$MOVE_KEY" ]; then _s="$_s -i $MOVE_KEY -o IdentitiesOnly=yes"; fi
  printf '%s' "$_s"
}
step_move_copy() {
  section "Mutare: copiez /srv/finet de pe $MOVE_SRC_V"
  _ssh=$(ssh_cmd_str)
  _dirs="env secrets ca compose storage"
  if [ "$FINAL_SYNC" = da ]; then _dirs=storage; fi
  _rpath="rsync"
  case $MOVE_SRC_V in root@*) ;; *) _rpath="sudo rsync" ;; esac
  if [ "$DRY" = 1 ]; then
    # shellcheck disable=SC2086
    if $_ssh "$MOVE_SRC_V" true >/dev/null 2>&1; then chk_ok "conexiune SSH la $MOVE_SRC_V"; else chk_fail "nu mă pot conecta prin SSH la $MOVE_SRC_V (conectează-te o dată manual ca root ca să accepți cheia gazdei)"; fi
    for _d in $_dirs; do note "[verificare] ar copia $MOVE_PREFIX/$_d/ → $PREFIX/$_d/ (rsync -aHAX --numeric-ids --backup --suffix=.bak-$DATE)"; done
    return 0
  fi
  # shellcheck disable=SC2086
  $_ssh "$MOVE_SRC_V" true || die "Nu mă pot conecta prin SSH la $MOVE_SRC_V."
  for _d in $_dirs; do
    say "  [fac] rsync $_d"
    rsync -aHAX --numeric-ids --backup --suffix=".bak-$DATE" --rsync-path="$_rpath" -e "$_ssh" \
      "$MOVE_SRC_V:$MOVE_PREFIX/$_d/" "$PREFIX/$_d/" >>"$LOG" 2>&1 || die "rsync $_d a eșuat (vezi log)."
  done
  # Verificarea secretului Better Auth: aceeași sumă pe ambele capete (suma nu e secretul).
  _local=$(sha256sum "$PREFIX/secrets/finet_better_auth_secret" 2>/dev/null | cut -d' ' -f1) || _local=""
  # shellcheck disable=SC2086
  _remote=$($_ssh "$MOVE_SRC_V" "$([ "$_rpath" = rsync ] || printf 'sudo ')sha256sum $MOVE_PREFIX/secrets/finet_better_auth_secret" 2>/dev/null | cut -d' ' -f1) || _remote=""
  if [ -n "$_local" ] && [ "$_local" = "$_remote" ]; then
    chk_ok "finet_better_auth_secret identic cu cel de pe serverul vechi"
  else
    die "finet_better_auth_secret diferă sau nu poate fi verificat; NU continua (sesiunile s-ar pierde)."
  fi
  [ -s "$PREFIX/secrets/finet_database_url" ] || die "După copiere lipsește finet_database_url."
  CA_NAME=$(envget "$PREFIX/compose/compose.env" FINET_DATABASE_CA_NAME)
  CA_NAME=${CA_NAME:-prod-ca-2021.crt}
  step_compose_env
  AI_ASK_EFF=nu
  if [ "$(envget "$PREFIX/env/finet.env" AI_ASK)" = 1 ]; then AI_ASK_EFF=da; fi
  APP_HOST=$(envget "$PREFIX/compose/compose.env" FINET_HOST)
  if [ -z "$(envget "$PREFIX/env/finet.env" CF_ACCESS_AUD)" ]; then CAN_START=0; fi
}

step_network() {
  section "Rețeaua Docker"
  if docker network inspect "$NET_NAME" >/dev/null 2>&1; then
    note "rețeaua $NET_NAME există"
  else
    act "creez rețeaua $NET_NAME ($NET_SUBNET)" docker network create --driver bridge --subnet "$NET_SUBNET" "$NET_NAME"
  fi
}

step_images() {
  section "Imaginile web, tools, backup (artefacte CI)"
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar rula: pull-images.sh $SHA all (tokenul prin fișier temporar root 600, șters la final)"
    return 0
  fi
  [ -n "$GH_TOKEN_FILE" ] || die "Fără token GitHub nu pot descărca artefactele."
  say "  [fac] pull-images.sh $SHA all (poate dura minute)"
  GITHUB_TOKEN_FILE=$GH_TOKEN_FILE GITHUB_REPO=$GITHUB_REPO sh "$SRC/ops/deploy/pull-images.sh" "$SHA" all >>"$LOG" 2>&1 ||
    die "pull-images.sh a eșuat (artefacte expirate? token fără Actions: read?). Vezi log."
  for _im in finet:local finet:tools finet:backup; do
    docker image inspect "$_im" >/dev/null 2>&1 || die "Imaginea $_im lipsește după pull; refuz să las compose să construiască local."
  done
  chk_ok "imaginile finet:local, finet:tools, finet:backup sunt încărcate"
}

step_dbtest() {
  section "Test conexiune la bază (sslmode=verify-full, imaginea tools)"
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar testa finet_database_url și finet_migrate_database_url cu un container finet:tools (CA montat, rejectUnauthorized)"
    return 0
  fi
  _js="const fs=require('fs');const postgres=require('postgres');const u=new URL(fs.readFileSync('/run/secrets/u','utf8').trim());u.searchParams.delete('sslmode');const sql=postgres(u.toString(),{ssl:{ca:fs.readFileSync(process.argv[1]),rejectUnauthorized:true},max:1,connect_timeout:10,prepare:false});sql\`select 1 as ok\`.then(()=>{console.log('conexiune ok');return sql.end()}).then(()=>process.exit(0)).catch(e=>{console.log('eroare: '+(e.code||e.name));process.exit(1)});"
  for _sf in finet_database_url finet_migrate_database_url; do
    _out=$(docker run --rm --network "$NET_NAME" --read-only --cap-drop ALL --security-opt no-new-privileges \
      -v "$PREFIX/secrets/$_sf:/run/secrets/u:ro" -v "$PREFIX/ca/$CA_NAME:/run/finet/ca/$CA_NAME:ro" \
      --entrypoint node finet:tools -e "$_js" "/run/finet/ca/$CA_NAME" 2>&1) || _out="eșec"
    say "  $_sf: $_out"
    case $_out in
      "conexiune ok") ;;
      *) die "Conexiunea la bază cu $_sf a eșuat. Verifică Network Restrictions (IP-ul de ieșire al containerelor), parola, CA-ul și rolurile din roles.sql." ;;
    esac
  done
  _cip=$(docker run --rm --network "$NET_NAME" --entrypoint node finet:tools -e "fetch('https://ifconfig.me/ip').then(r=>r.text()).then(t=>console.log(t.trim())).catch(()=>console.log('necunoscut'))" 2>/dev/null || echo necunoscut)
  if [ -n "${EGRESS:-}" ] && [ "$_cip" != "$EGRESS" ]; then
    chk_warn "containerele ies cu IP $_cip, gazda cu $EGRESS; în Network Restrictions trebuie IP-ul containerelor"
  else
    chk_ok "IP-ul de ieșire al containerelor: $_cip"
  fi
}

run_migrate() { # → $MIGOUT
  MIGOUT=$(dc --profile migrate run --rm -T finet-migrate 2>&1) || {
    printf '%s\n' "$MIGOUT" >>"$LOG"
    die "finet-migrate a eșuat (vezi log)."
  }
  printf '%s\n' "$MIGOUT" >>"$LOG"
  MIGLINE=$(printf '%s\n' "$MIGOUT" | grep 'aplicate acum' | tail -n 1)
  note "${MIGLINE:-finet-migrate: fără linie de raport}"
}
step_migrate() {
  section "Configurație și migrații"
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar rula: docker compose config -q, apoi finet-migrate de două ori (a doua: «aplicate acum 0»)"
    return 0
  fi
  dc --profile worker --profile migrate --profile admin --profile cleanup config -q >>"$LOG" 2>&1 || die "docker compose config a eșuat (vezi log)."
  chk_ok "docker compose config valid"
  # Plasă de siguranță (move_check_sha a decis deja): nu rula migrații peste baza comună cu un SHA
  # diferit de cel de pe serverul vechi decât dacă operatorul a confirmat.
  if [ "$MODE" = move ] && [ "$SHA" != "$OLD_SHA" ] && [ "$MOVE_SHA_OK" != da ]; then
    die "Mutare: SHA-ul imaginilor ($SHA) diferă de cel de pe serverul vechi (${OLD_SHA:-necunoscut}) și nu e confirmat; NU rulez migrațiile pe baza comună."
  fi
  run_migrate
  case $MIGLINE in
    *"aplicate acum 0"*) MIG_ZERO=1 ;;
    *) MIG_ZERO=0 ;;
  esac
  if [ "$MODE" = move ]; then
    if [ "$MIG_ZERO" = 1 ]; then chk_ok "mutare: migrațiile raportează «aplicate acum 0»"; else die "Mutare: finet-migrate a aplicat migrații noi; baza nu era la zi față de imaginile alese. Verifică SHA-ul imaginilor și baza."; fi
  else
    run_migrate
    case $MIGLINE in *"aplicate acum 0"*) chk_ok "a doua rulare: aplicate acum 0 (idempotent)" ;; *) die "A doua rulare a migrațiilor nu a raportat «aplicate acum 0»." ;; esac
  fi
}

step_user() {
  section "Primul utilizator"
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar crea utilizatorul $ADMIN_EMAIL cu finet-admin create-user --password-stdin (parola prin stdin)"
    return 0
  fi
  if [ "$ADMIN_GEN" = da ]; then
    ADMIN_PASS=$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20)
    SECRET_VARS="$SECRET_VARS ADMIN_PASS"
    [ "${#ADMIN_PASS}" -ge 16 ] || die "Generarea parolei a eșuat."
    show_once_tty "Parola administratorului" "$ADMIN_PASS"
  fi
  _uo=$(printf '%s\n' "$ADMIN_PASS" | dc --profile admin run --rm -T finet-admin create-user --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" --password-stdin 2>&1) || {
    printf '%s\n' "$_uo" >>"$LOG"
    die "create-user a eșuat (vezi log; un utilizator existent nu e o eroare)."
  }
  printf '%s\n' "$_uo" >>"$LOG"
  chk_ok "utilizator creat/existent: $ADMIN_EMAIL"
}

wait_healthy() { # container, secunde
  _t=0
  while [ "$_t" -lt "$2" ]; do
    _s=$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo none)
    [ "$_s" = healthy ] && return 0
    sleep 3
    _t=$((_t + 3))
  done
  return 1
}
step_start() {
  section "Pornire"
  if [ "$CAN_START" = 0 ]; then
    note "CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD lipsesc: finet-web NU se pornește. Completează-le în $PREFIX/env/finet.env și rulează din nou installer-ul."
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar rula: up -d --no-build finet-web; --profile worker up -d --no-build finet-worker; așteaptă healthy"
    return 0
  fi
  say "  [fac] up -d finet-web"
  dc up -d --no-build finet-web >>"$LOG" 2>&1 || die "up finet-web a eșuat (vezi log)."
  wait_healthy finet-web 150 || die "finet-web nu a ajuns healthy în 150 s (docker logs finet-web)."
  chk_ok "finet-web healthy"
  say "  [fac] up -d finet-worker"
  dc --profile worker up -d --no-build finet-worker >>"$LOG" 2>&1 || die "up finet-worker a eșuat (vezi log)."
  sleep 5
  _ws=$(docker inspect -f '{{.State.Status}}' finet-worker 2>/dev/null || echo necunoscut)
  if [ "$_ws" = running ]; then chk_ok "finet-worker rulează"; else chk_fail "finet-worker: $_ws"; fi
}

step_acceptance() {
  section "Acceptare"
  if [ "$CAN_START" = 0 ]; then
    note "omisă (finet-web nu e pornit)"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar verifica: N1 (niciun postgres:// în docker inspect / config.v2.json), /api/health cu tokenul din fișier"
    return 0
  fi
  _root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  for _c in finet-web finet-worker; do
    _id=$(docker inspect -f '{{.Id}}' "$_c" 2>/dev/null || :)
    [ -n "$_id" ] || continue
    _n1=$(docker inspect "$_c" --format '{{json .Config.Env}}' | grep -c 'postgres://' || :)
    _n2=$(grep -c 'postgres://' "$_root/containers/$_id/config.v2.json" 2>/dev/null || :)
    if [ "${_n1:-0}" = 0 ] && [ "${_n2:-0}" = 0 ]; then chk_ok "N1 $_c: 0 URL-uri în docker inspect și în config.v2.json"; else chk_fail "N1 $_c: URL-uri de bază în configurația containerului (inspect=${_n1:-?}, config.v2.json=${_n2:-?})"; fi
  done
  # Tokenul se citește în container din fișierul secret: nu trece prin argumente sau shell.
  _hjs="const fs=require('fs');const t=fs.readFileSync('/run/secrets/finet_health_token','utf8').trim();fetch('http://127.0.0.1:3000/api/health',{headers:{'x-finet-health-token':t}}).then(async r=>{const j=await r.json().catch(()=>({}));console.log(r.status,j.status,'db='+j.db,'storage='+j.storage,'queue='+j.queue);process.exit(r.ok?0:1)}).catch(()=>{console.log('eroare');process.exit(1)})"
  _try=0
  _hout=""
  while [ "$_try" -lt 6 ]; do
    if _hout=$(docker exec finet-web node -e "$_hjs" 2>&1); then break; fi
    _try=$((_try + 1))
    sleep 5
  done
  case $_hout in
    200*) chk_ok "/api/health: $_hout" ;;
    *) chk_fail "/api/health: $_hout" ;;
  esac
}

step_cloudflared() {
  [ "$ENTRY" = tunel-nou ] || return 0
  section "cloudflared (tunel nou, token în fișier root 600, nu în argumente)"
  _unit=$SYSTEMD_DIR/finet-cloudflared.service
  _tokdir=/etc/finet-cloudflared
  _tokf=$_tokdir/tunnel.token
  [ "$PREFIX" = /srv/finet ] || { _tokdir=$PREFIX/cloudflared; _tokf=$_tokdir/tunnel.token; }
  if ! command -v cloudflared >/dev/null 2>&1 && [ ! -x "$BIN_DIR/cloudflared" ]; then
    if [ "$CLOUDFLARED_INSTALL" != da ]; then
      note "cloudflared lipsește și ai ales să nu-l descarc: instalează-l din documentația Cloudflare, apoi reia."
      return 0
    fi
    case $(uname -m) in
      x86_64) _arch=amd64 ;;
      aarch64 | arm64) _arch=arm64 ;;
      *) die "Arhitectură neacoperită pentru cloudflared: $(uname -m). Instalează-l manual." ;;
    esac
    if [ "$DRY" = 1 ]; then
      note "[verificare] ar descărca cloudflared-linux-$_arch din release-ul GitHub oficial (HTTPS) în $BIN_DIR"
    else
      curl -fsSL -m 120 -o "$TMP/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$_arch" || die "Descărcarea cloudflared a eșuat."
      note "sha256 al binarului descărcat: $(sha256sum "$TMP/cloudflared" | cut -d' ' -f1) (compară-l cu pagina release-ului; installer-ul nu are o sumă de referință)"
      install -o root -g root -m 755 "$TMP/cloudflared" "$BIN_DIR/cloudflared"
    fi
  fi
  if [ "$DRY" = 0 ]; then
    _cfbin=$(command -v cloudflared || printf '%s' "$BIN_DIR/cloudflared")
    "$_cfbin" tunnel run --help 2>&1 | grep -q -- '--token-file' || die "Această versiune de cloudflared nu are --token-file; actualizează-l."
  fi
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar scrie tokenul în $_tokf (root, 600), unitatea $_unit și ar porni finet-cloudflared.service"
    return 0
  fi
  install -d -o root -g root -m 700 "$_tokdir"
  printf '%s\n' "$CF_TUNNEL_TOKEN_V" | install -o root -g root -m 600 /dev/stdin "$_tokf"
  cat >"$TMP/unit" <<EOF
[Unit]
Description=Cloudflare Tunnel pentru FINET
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$_cfbin --no-autoupdate tunnel run --token-file $_tokf
Restart=on-failure
RestartSec=5s
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
  if [ -e "$_unit" ] && ! cmp -s "$TMP/unit" "$_unit"; then cp -p "$_unit" "$_unit.bak-$DATE"; fi
  install -o root -g root -m 644 "$TMP/unit" "$_unit"
  if [ "$SYSTEMD_DIR" = /etc/systemd/system ]; then
    systemctl daemon-reload >>"$LOG" 2>&1 || die "systemctl daemon-reload a eșuat."
    systemctl enable --now finet-cloudflared.service >>"$LOG" 2>&1 || die "Nu pot porni finet-cloudflared.service (journalctl -u finet-cloudflared)."
    chk_ok "finet-cloudflared.service pornit (tokenul e în $_tokf, nu în unitate)"
  else
    note "unitate scrisă în $_unit (systemd neatins: director de test)"
  fi
}

print_cloudflare_manual() {
  section "Pași manuali rămași în Cloudflare (nu se pot automatiza fără chei API)"
  _host=${APP_HOST:-<hostname>}
  case $ENTRY in
    traefik) note "Traefik: înregistrare DNS proxied către IP-ul public; resolver $TRAEFIK_RESOLVER; confirmă entrypoint-ul websecure în traefik.yml." ;;
    nimic) note "Intrarea nu e configurată: alege tunel sau Traefik (ops/cloudflare/README.md)." ;;
    *)
      note "1. Tunel → Public Hostname → $_host → Service: HTTP → http://$WEB_IP:3000 (de pe gazdă) sau finet-web:3000 (dacă tunelul rulează pe rețeaua $NET_NAME)."
      note "   NU seta «HTTP Host Header» la 127.0.0.1/localhost."
      ;;
  esac
  note "2. Access → aplicație self-hosted pe $_host, politică «Allow» doar pentru emailurile familiei (ops/cloudflare/access-policy.md)."
  note "3. Notează Team domain și Application Audience (AUD) → $PREFIX/env/finet.env (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD), apoi: docker compose ... up -d --force-recreate finet-web."
  note "4. Verifică în browser: login Access cu un email permis; unul nepermis e refuzat."
}

gen_cron() { # → stdout: conținutul /etc/cron.d/finet (doar joburile nedublate)
  _lg=$LOG_DIR/finet-cleanup.log
  _base="cd $SRC && docker compose $(compose_files) --env-file $PREFIX/compose/compose.env"
  cat <<EOF
# FINET — joburi zilnice. Generat de ops/install/finet-install.sh ($DATE); NU adăuga acest conținut
# și în crontab-ul root (rulare dublă). Oprire: șterge acest fișier. Fără secrete.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
  if [ "${CRON_IDEMP_ON:-nu}" = da ] && [ "${DUP_IDEMP:-0}" = 0 ]; then
    echo "15 4 * * * root $_base --profile admin run --rm -T finet-admin cleanup-idempotency >> $_lg 2>&1"
  fi
  if [ "${DUP_CLEAN:-0}" = 0 ]; then
    echo "25 4 * * * root $_base --profile cleanup run --rm -T finet-cleanup >> $_lg 2>&1"
  fi
  if [ "${DUP_UNVER:-0}" = 0 ]; then
    echo "30 4 * * * root $_base --profile cleanup run --rm -T finet-cleanup cleanup-unverified --yes >> $_lg 2>&1"
  fi
  if [ "${DUP_AGG:-0}" = 0 ]; then
    echo "35 4 * * * root $_base --profile admin run --rm -T finet-admin aggregate-events >> $_lg 2>&1"
  fi
  if [ "${BACKUP_READY:-nu}" = da ] && [ "${DUP_BACKUP:-0}" = 0 ]; then
    if [ "$PREFIX" = /srv/finet ]; then
      echo "10 5 * * * root /bin/sh $SRC/ops/backup/run-backup.sh >> $LOG_DIR/finet-backup.log 2>&1"
    else
      echo "10 5 * * * root FINET_BACKUP_HOST_ENV=$PREFIX/env/backup-host.env /bin/sh $SRC/ops/backup/run-backup.sh >> $LOG_DIR/finet-backup.log 2>&1"
    fi
  fi
}

cron_dup() { # model → 0 dacă apare deja în crontab-ul root sau în alt fișier din cron.d
  _rc=$(crontab -l -u root 2>/dev/null || :)
  if printf '%s\n' "$_rc" | grep -Fq -- "$1"; then return 0; fi
  if [ -d "$CRON_DIR" ] && grep -Fl -- "$1" "$CRON_DIR"/* 2>/dev/null | grep -v "/finet\$" | grep -q .; then return 0; fi
  return 1
}
step_cron() {
  section "Cron și rotația logurilor"
  if [ "${CRON_ON:-nu}" != da ]; then
    note "joburile cron nu se instalează (alegerea ta)"
    return 0
  fi
  DUP_CLEAN=0 DUP_UNVER=0 DUP_AGG=0 DUP_BACKUP=0 DUP_IDEMP=0
  if cron_dup "--profile cleanup run --rm -T finet-cleanup >>"; then DUP_CLEAN=1; fi
  if cron_dup "cleanup-unverified"; then DUP_UNVER=1; fi
  if cron_dup "aggregate-events"; then DUP_AGG=1; fi
  if cron_dup "run-backup.sh"; then DUP_BACKUP=1; fi
  if cron_dup "cleanup-idempotency"; then DUP_IDEMP=1; fi
  if [ "$DUP_CLEAN$DUP_UNVER$DUP_AGG$DUP_BACKUP$DUP_IDEMP" != 00000 ]; then
    chk_warn "există deja joburi FINET în crontab-ul root sau în $CRON_DIR; nu le dublez (fiecare ar rula de două ori)"
  fi
  gen_cron >"$TMP/finet.cron"
  _cf=$CRON_DIR/finet
  if [ -e "$_cf" ] && cmp -s "$TMP/finet.cron" "$_cf"; then
    note "$_cf există și e identic"
  else
    if [ -e "$_cf" ]; then
      note "$_cf există și diferă: se înlocuiește cu backup $_cf.bak-$DATE (cron ignoră fișierele cu punct în nume)"
      if [ "$DRY" = 0 ]; then cp -p "$_cf" "$_cf.bak-$DATE"; fi
    fi
    act "scriu $_cf (root:root, 644)" install -o root -g root -m 644 "$TMP/finet.cron" "$_cf"
  fi
  for _l in finet-cleanup.log finet-backup.log; do
    if [ -e "$LOG_DIR/$_l" ]; then note "există: $LOG_DIR/$_l"; else act "creez $LOG_DIR/$_l (root, 600)" install -o root -g root -m 600 /dev/null "$LOG_DIR/$_l"; fi
  done
  _lrlogs=""
  for _l in finet-cleanup.log finet-backup.log; do
    # logrotate dă eroare la două stanze pentru același fișier: sar peste cele deja acoperite.
    if grep -Fqs -- "$LOG_DIR/$_l" "$LOGROTATE_DIR"/* 2>/dev/null && ! grep -Fqs -- "$LOG_DIR/$_l" "$LOGROTATE_DIR/finet-install" 2>/dev/null; then
      note "logrotate pentru $_l există deja în $LOGROTATE_DIR"
    else
      _lrlogs="$_lrlogs $LOG_DIR/$_l"
    fi
  done
  printf '%s {\n  weekly\n  rotate 8\n  compress\n  missingok\n  notifempty\n  create 0600 root root\n}\n' "${_lrlogs# }" >"$TMP/logrotate"
  if [ -z "$_lrlogs" ]; then
    note "logrotate: nimic de adăugat"
  elif [ -e "$LOGROTATE_DIR/finet-install" ] && cmp -s "$TMP/logrotate" "$LOGROTATE_DIR/finet-install"; then
    note "logrotate identic"
  else
    act "scriu $LOGROTATE_DIR/finet-install" install -o root -g root -m 644 "$TMP/logrotate" "$LOGROTATE_DIR/finet-install"
  fi
  say "  ATENȚIE: pe serverul vechi (dacă există) NU lăsa cron-uri FINET active: ar rula în paralel (backup dublu, curățări concurente)."
}

step_backup() {
  [ "${BACKUP_READY:-nu}" = da ] || return 0
  section "Backup (restic → rclone)"
  _ex=$SRC/ops
  if [ "$DRY" = 1 ] && [ ! -d "$_ex" ]; then _ex=$REPO_HERE/ops; fi
  if [ "$MODE" = new ]; then
    install_from_example "$_ex/docker/finet.backup.env.example" "$PREFIX/env/finet.backup.env"
    install_from_example "$_ex/backup/backup-host.env.example" "$PREFIX/env/backup-host.env"
    envapply "$PREFIX/env/backup-host.env" set FINET_BACKUP_DEST rclone
    envapply "$PREFIX/env/backup-host.env" set FINET_COMPOSE_ENV "$PREFIX/compose/compose.env"
    envapply "$PREFIX/env/backup-host.env" set FINET_NOTIFY_ENV "$PREFIX/env/notify.env"
    envapply "$PREFIX/env/backup-host.env" set FINET_BACKUP_STATE_DIR "$PREFIX/backup-state"
    _repo="rclone:$RCLONE_REMOTE_V:$BACKUP_PATH_V"
    if existing_secret finet_backup_repository; then
      note "păstrat: finet_backup_repository"
    elif [ "$DRY" = 1 ]; then
      note "[verificare] ar scrie finet_backup_repository ($_repo)"
    else
      printf '%s\n' "$_repo" | install -o 1000 -g 1000 -m 400 /dev/stdin "$PREFIX/secrets/finet_backup_repository"
      note "scris: finet_backup_repository"
    fi
    if [ "$KEEP_RESTIC" = nu ]; then
      if [ "$RESTIC_GEN" = da ] && [ "$DRY" = 0 ]; then
        RESTIC_PASS=$(openssl rand -base64 32 | tr -d '\n')
        SECRET_VARS="$SECRET_VARS RESTIC_PASS"
        show_once_tty "Parola restic (fără ea backup-ul e de nerecuperat)" "$RESTIC_PASS"
      fi
      if [ "$DRY" = 1 ]; then
        note "[verificare] ar scrie finet_restic_password (generată sau dată de tine; 1000:1000 mod 400)"
      else
        put_secret finet_restic_password RESTIC_PASS nu
      fi
    else
      note "păstrat: finet_restic_password"
    fi
    if [ "$KEEP_BK_PG_PASS" = da ]; then
      note "păstrat: finet_backup_pg_service"
    elif [ "$DRY" = 1 ]; then
      note "[verificare] ar scrie finet_backup_pg_service (fișier de servicii libpq, sslmode=verify-full)"
    else
      _bh=$(url_host "$DB_MIG")
      [ -s "$PREFIX/secrets/finet_backup_pg_service" ] && [ ! -e "$PREFIX/secrets/finet_backup_pg_service.bak-$DATE" ] && cp -p "$PREFIX/secrets/finet_backup_pg_service" "$PREFIX/secrets/finet_backup_pg_service.bak-$DATE"
      printf '[finet_backup]\nhost=%s\nport=5432\ndbname=postgres\nuser=%s\npassword=%s\nsslmode=verify-full\nsslrootcert=/run/finet/ca/%s\n' "$_bh" "$BACKUP_PG_USER_V" "$BK_PG_PASS" "$CA_NAME" |
        install -o 1000 -g 1000 -m 400 /dev/stdin "$PREFIX/secrets/finet_backup_pg_service" || die "Nu pot scrie finet_backup_pg_service."
      note "scris: finet_backup_pg_service"
    fi
    if [ -s "$PREFIX/secrets/finet_rclone_conf" ]; then
      note "păstrat: finet_rclone_conf"
    elif [ "$DRY" = 1 ]; then
      note "[verificare] ar extrage doar secțiunea [$RCLONE_REMOTE_V] din $RCLONE_CONF_SRC în finet_rclone_conf (1000:1000 mod 400)"
    else
      [ -r "$RCLONE_CONF_SRC" ] || die "Nu pot citi $RCLONE_CONF_SRC."
      awk -v s="[$RCLONE_REMOTE_V]" '/^\[/ { p = ($0 == s) } p' "$RCLONE_CONF_SRC" | install -o 1000 -g 1000 -m 400 /dev/stdin "$PREFIX/secrets/finet_rclone_conf"
      [ -s "$PREFIX/secrets/finet_rclone_conf" ] || die "Remote-ul [$RCLONE_REMOTE_V] nu există în $RCLONE_CONF_SRC."
      note "scris: finet_rclone_conf (doar secțiunea [$RCLONE_REMOTE_V]; la fel de sensibil ca tot Drive-ul)"
    fi
  fi
  if [ "$DRY" = 1 ]; then
    note "[verificare] ar verifica remote-ul rclone, ar inițializa repository-ul restic dacă nu există și ar rula un backup de probă"
    return 0
  fi
  if command -v rclone >/dev/null 2>&1; then
    rclone --config "$PREFIX/secrets/finet_rclone_conf" lsd "$RCLONE_REMOTE_V:" --max-depth 1 >>"$LOG" 2>&1 || die "Remote-ul rclone «$RCLONE_REMOTE_V» nu răspunde (token expirat?)."
    chk_ok "remote-ul rclone $RCLONE_REMOTE_V răspunde"
  else
    chk_warn "rclone nu e instalat pe gazdă: remote-ul nu a fost verificat (imaginea de backup îl are)"
  fi
  if dc_backup run --rm -T finet-backup snapshots >>"$LOG" 2>&1; then
    note "repository-ul restic există deja (init omis)"
  else
    act "inițializez repository-ul restic" dc_backup run --rm -T finet-backup init
  fi
  if [ "${BACKUP_TEST:-nu}" = da ]; then
    if FINET_BACKUP_HOST_ENV=$PREFIX/env/backup-host.env sh "$SRC/ops/backup/run-backup.sh" >>"$LOG" 2>&1; then
      chk_ok "backup de probă reușit (run-backup.sh, cod 0)"
    else
      chk_fail "backup-ul de probă a eșuat (vezi $LOG_DIR/finet-backup.log și logul de instalare)"
    fi
  fi
  note "Notificările (Telegram/SMTP) rămân manuale: $PREFIX/env/notify.env, apoi ops/notify/notify.sh --test."
}

# ---------------------------------------------------------------------------------------------
# Verificarea că niciun secret nu a ajuns în log (plasă de siguranță, fără secrete în argumente)
# ---------------------------------------------------------------------------------------------
scrub_ok() { # 0 = logul e curat; 1 = s-a găsit o valoare secretă (logul a fost golit). Nu cheamă die.
  for _sv in $SECRET_VARS; do
    eval "_sval=\${$_sv-}"
    [ -n "$_sval" ] || continue
    (
      umask 077
      printf '%s\n' "$_sval" >"$TMP/pat"
    )
    if grep -qFf "$TMP/pat" "$LOG" 2>/dev/null; then
      : >"$LOG"
      rm -f "$TMP/pat"
      _sval=""
      return 1
    fi
    rm -f "$TMP/pat"
  done
  _sval=""
  return 0
}
scrub_check() {
  scrub_ok || die "O valoare secretă a fost detectată în log; logul a fost șters. Raportează bug-ul."
}

finish() {
  section "Raport final"
  note "Erori: $FAILS; atenționări: $WARNS"
  if [ "$DRY" = 1 ]; then
    note "Verificare terminată: nu s-a scris nimic."
  else
    note "Rollback: docker compose <aceleași -f> --env-file $PREFIX/compose/compose.env --profile worker down (fără ștergerea $PREFIX); rm $CRON_DIR/finet; systemctl disable --now finet-cloudflared. Vezi docs/INSTALL.md."
  fi
  scrub_check
  if [ "$DRY" = 0 ]; then
    _lf=${LOGFINAL:-$PREFIX/install-$(date +%Y%m%d-%H%M%S).log}
    (
      umask 077
      cat "$LOG" >"$_lf"
    )
    chmod 600 "$_lf"
    chown root:root "$_lf" 2>/dev/null || :
    LOG_SAVED=1
    printf 'Log salvat: %s (root, 600, fără secrete)\n' "$_lf"
  elif [ -n "$LOGFINAL" ]; then
    (
      umask 077
      cat "$LOG" >"$LOGFINAL"
    )
    LOG_SAVED=1
    printf 'Log scris: %s\n' "$LOGFINAL"
  fi
  [ "$FAILS" -eq 0 ] || exit 1
}

# ---------------------------------------------------------------------------------------------
# Programul principal
# ---------------------------------------------------------------------------------------------
welcome() {
  _w="FINET — installer
Acest wizard instalează FINET pe un server cu Docker: directoare, fișiere de mediu, secrete (fișiere 1000:1000 mod 400), imaginile din CI (fără build local), migrațiile, primul utilizator, intrarea Cloudflare, cron și backup.
Nu cere nimic ce nu e în docs/INFRA.md; secretele se tastează ascuns și nu apar în argumente, log sau stdout.
Rulat a doua oară, nu strică nimic: ce există se păstrează sau se salvează ca .bak-$DATE."
  say "$_w"
  if [ -n "$TUI" ]; then $TUI --title "FINET — instalare" --msgbox "$_w" 18 74 || :; fi
}

main() {
  parse_args "$@"
  ERRLOG=${LOGFINAL:-$PREFIX/install-$(date +%Y%m%d-%H%M%S)-eroare.log}
  TMP=$(mktemp -d)
  LOG=$TMP/install.log
  : >"$LOG"
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP
  if [ -n "$ANSWERS" ]; then load_answers; fi
  if [ -z "$ANSWERS" ]; then
    ( : <"$TTY" ) 2>/dev/null || die "Nu am terminal interactiv. Rulează într-un terminal sau folosește --answers FIȘIER."
    if [ "$NO_TUI" = 0 ] && [ -t 1 ]; then
      if command -v whiptail >/dev/null 2>&1; then TUI=whiptail; elif command -v dialog >/dev/null 2>&1; then TUI=dialog; fi
    fi
  fi
  umask 022
  welcome
  if [ -z "$MODE" ]; then
    ask MODE MODE "Ce vrei să faci? 1) instalare nouă, 2) mutare de pe un server existent, 3) doar verificare (nu scrie nimic)" 1 v_mode
  else
    _val=$MODE
    v_mode || die "--mode invalid: $_err"
    MODE=$_val
  fi
  if [ "$MODE" = check ]; then
    DRY=1
    MODE=new
  fi
  if [ "$DRY" = 1 ]; then say "  Mod verificare: nu se scrie nimic pe disc (doar un log temporar, șters la ieșire)."; fi
  if [ "$DRY" = 0 ] && [ "$(id -u)" -ne 0 ]; then die "Instalarea cere root: sudo sh ops/install/finet-install.sh"; fi
  LOG_OK=1
  SRC=$PREFIX/src
  preflight_system
  if [ "$FAILS" -gt 0 ] && [ "$DRY" = 0 ]; then die "Precondiții neîndeplinite ($FAILS). Corectează și rulează din nou."; fi
  if [ "$MODE" = move ]; then collect_move; else collect_new; fi
  preflight_network
  check_ips
  if [ "$FAILS" -gt 0 ] && [ "$DRY" = 0 ]; then die "Precondiții neîndeplinite ($FAILS). Corectează și rulează din nou."; fi
  if [ "$MODE" = new ] && [ "${EGRESS_OK:-nu}" != da ] && [ "$DRY" = 0 ]; then
    die "Adaugă IP-ul de ieșire în Supabase → Network Restrictions și rulează din nou."
  fi
  [ "$MODE" = new ] && [ "${EGRESS_OK:-nu}" != da ] && chk_warn "IP-ul de ieșire nu a fost confirmat în Network Restrictions"
  print_summary
  confirm
  # --- aplicarea ---
  if [ -n "${GH_TOKEN_V:-}" ] || [ "$DRY" = 0 ]; then step_token; fi
  find_images_sha
  step_dirs
  step_src
  if [ "$MODE" = move ]; then step_move_copy; else step_env_new; step_secrets_new; fi
  step_network
  step_images
  step_dbtest
  step_migrate
  if [ "$MODE" = new ]; then step_user; fi
  step_start
  step_cloudflared
  step_cron
  step_backup
  step_acceptance
  if [ "${GH_KEEP:-nu}" = da ] && [ "$DRY" = 0 ] && [ -n "$GH_TOKEN_FILE" ]; then
    install -o root -g root -m 600 "$GH_TOKEN_FILE" "$PREFIX/github-token"
    note "tokenul GitHub păstrat în $PREFIX/github-token (alegerea ta)"
  fi
  print_cloudflare_manual
  finish
}

if [ -z "${FINET_INSTALL_LIB:-}" ]; then main "$@"; fi
