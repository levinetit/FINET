#!/bin/sh
# Teste pentru notify.sh, FĂRĂ rețea: doar --dry-run și erorile de configurare.
# Rulare: sh ops/notify/test.sh
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
N="$DIR/notify.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FAILS=0

# Token fictiv, în formatul Telegram (nu e un token real).
FAKE_TOKEN="123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

check() { # descriere, cod așteptat, cod primit, text care trebuie să apară, ieșire
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 (cod $3, așteptat $2)"; FAILS=$((FAILS + 1)); return
  fi
  if [ -n "$4" ] && ! printf '%s' "$5" | grep -Fq -- "$4"; then
    echo "FAIL: $1 (lipsește „$4”)"; FAILS=$((FAILS + 1)); return
  fi
  echo "ok: $1"
}

clean_env() { env -i PATH="$PATH" HOME="$TMP" "$@"; }

out=$(clean_env sh "$N" --dry-run mesaj 2>&1); check "fără canal → 2" 2 $? "niciun canal" "$out"
out=$(clean_env sh "$N" 2>&1); check "fără mesaj → 2" 2 $? "Utilizare" "$out"
out=$(clean_env sh "$N" --test extra 2>&1); check "--test cu mesaj → 2" 2 $? "Utilizare" "$out"

out=$(clean_env NOTIFY_TELEGRAM_BOT_TOKEN="$FAKE_TOKEN" NOTIFY_TELEGRAM_CHAT_ID=-1001 \
  sh "$N" --dry-run --test 2>&1)
check "telegram dry-run" 0 $? "canal: telegram" "$out"
case "$out" in *"$FAKE_TOKEN"*) echo "FAIL: tokenul apare în dry-run"; FAILS=$((FAILS + 1)) ;; *) echo "ok: token mascat" ;; esac
check "telegram mesaj de test" 0 0 "mesaj de test" "$out"

out=$(clean_env NOTIFY_TELEGRAM_BOT_TOKEN="$FAKE_TOKEN" sh "$N" --dry-run x 2>&1)
check "telegram fără chat → 2" 2 $? "se setează împreună" "$out"

out=$(clean_env NOTIFY_TELEGRAM_BOT_TOKEN='1:"; url = "http://rau' NOTIFY_TELEGRAM_CHAT_ID=1 \
  sh "$N" --dry-run x 2>&1)
check "token cu caractere de injectare → 2" 2 $? "format invalid" "$out"

out=$(clean_env SMTP_HOST=smtp.exemplu.invalid SMTP_FROM='FINET <finet@exemplu.invalid>' \
  NOTIFY_EMAIL_TO=familia@exemplu.invalid SMTP_USER=u SMTP_PASSWORD=parola-fictiva \
  sh "$N" --dry-run "disc aproape plin" 2>&1)
check "email dry-run" 0 $? "canal: email" "$out"
check "email STARTTLS obligatoriu" 0 0 "--ssl-reqd" "$out"
case "$out" in *parola-fictiva*) echo "FAIL: parola apare în dry-run"; FAILS=$((FAILS + 1)) ;; *) echo "ok: parolă mascată" ;; esac

out=$(clean_env SMTP_HOST=smtp.exemplu.invalid SMTP_FROM=finet@exemplu.invalid \
  sh "$N" --dry-run x 2>&1)
check "email fără destinatar → 2" 2 $? "NOTIFY_EMAIL_TO" "$out"

out=$(clean_env SMTP_HOST=smtp.exemplu.invalid SMTP_PORT=465 SMTP_FROM=finet@exemplu.invalid \
  NOTIFY_EMAIL_TO=a@exemplu.invalid sh "$N" --dry-run x 2>&1)
check "email port 465 → smtps" 0 $? "smtps://" "$out"

# --env-file: citește doar cheile cunoscute și nu execută conținutul.
cat > "$TMP/finet.env" <<EOF
# comentariu
NOTIFY_TELEGRAM_BOT_TOKEN="$FAKE_TOKEN"
NOTIFY_TELEGRAM_CHAT_ID=42
DATABASE_URL=postgres://nu-se-citeste
\$(touch $TMP/executat)
EOF
out=$(clean_env sh "$N" --env-file "$TMP/finet.env" --dry-run x 2>&1)
check "--env-file telegram" 0 $? "chat 42" "$out"
if [ -e "$TMP/executat" ]; then echo "FAIL: fișierul de mediu a fost executat"; FAILS=$((FAILS + 1)); else echo "ok: fișierul de mediu nu e executat"; fi

out=$(clean_env NOTIFY_TELEGRAM_CHAT_ID=7 NOTIFY_TELEGRAM_BOT_TOKEN="$FAKE_TOKEN" \
  sh "$N" --env-file "$TMP/finet.env" --dry-run x 2>&1)
check "mediul are prioritate față de --env-file" 0 $? "chat 7" "$out"

out=$(clean_env sh "$N" --env-file "$TMP/lipsa.env" --dry-run x 2>&1)
check "--env-file inexistent → 2" 2 $? "nu poate fi citit" "$out"

# Valori pe mai multe linii (LF/CR): refuzate pe toată valoarea, înaintea regex-urilor. Fără ele,
# `grep` ar valida doar o linie, iar un CR/LF în SMTP_FROM/NOTIFY_EMAIL_TO ar injecta antete.
# (Linia nouă e literală: `$(printf '\n')` ar fi șirul gol.)
NL='
'
CR=$(printf '\r')
out=$(clean_env NOTIFY_TELEGRAM_BOT_TOKEN="$FAKE_TOKEN${NL}url = \"http://rau\"" \
  NOTIFY_TELEGRAM_CHAT_ID=1 sh "$N" --dry-run x 2>&1)
check "token cu LF (prima linie validă) → 2" 2 $? "NOTIFY_TELEGRAM_BOT_TOKEN conține un caracter de linie nouă" "$out"
out=$(clean_env NOTIFY_TELEGRAM_BOT_TOKEN="$FAKE_TOKEN" NOTIFY_TELEGRAM_CHAT_ID="-1001${NL}42" \
  sh "$N" --dry-run x 2>&1)
check "chat id cu LF → 2" 2 $? "NOTIFY_TELEGRAM_CHAT_ID conține" "$out"
out=$(clean_env NOTIFY_TELEGRAM_BOT_TOKEN="$FAKE_TOKEN$CR" NOTIFY_TELEGRAM_CHAT_ID=1 \
  sh "$N" --dry-run x 2>&1)
check "token cu CR final → 2" 2 $? "NOTIFY_TELEGRAM_BOT_TOKEN conține" "$out"

EMAIL_OK="SMTP_HOST=smtp.exemplu.invalid SMTP_FROM=finet@exemplu.invalid NOTIFY_EMAIL_TO=a@exemplu.invalid"
for var in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM NOTIFY_EMAIL_TO; do
  case "$var" in
    SMTP_HOST) bad="smtp.exemplu.invalid${NL}x" ;;
    SMTP_PORT) bad="587${NL}25" ;;
    SMTP_FROM) bad="finet@exemplu.invalid${CR}${NL}Bcc: altcineva@exemplu.invalid" ;;
    NOTIFY_EMAIL_TO) bad="a@exemplu.invalid${NL}Bcc: altcineva@exemplu.invalid" ;;
    *) bad="valoare${NL}url = \"http://rau\"" ;;
  esac
  # shellcheck disable=SC2086
  out=$(clean_env $EMAIL_OK SMTP_USER=u SMTP_PASSWORD=p "$var=$bad" sh "$N" --dry-run x 2>&1)
  check "$var cu linie nouă → 2" 2 $? "$var conține un caracter de linie nouă" "$out"
  case "$out" in *altcineva*|*rau*) echo "FAIL: valoarea lui $var apare în mesaj"; FAILS=$((FAILS + 1)) ;; esac
done

# Fișier de mediu cu terminații CRLF: valoarea ar purta un CR → refuzat, cu numele variabilei.
printf 'NOTIFY_TELEGRAM_BOT_TOKEN=%s\r\nNOTIFY_TELEGRAM_CHAT_ID=42\r\n' "$FAKE_TOKEN" > "$TMP/crlf.env"
out=$(clean_env sh "$N" --env-file "$TMP/crlf.env" --dry-run x 2>&1)
check "--env-file cu CRLF → 2" 2 $? "NOTIFY_TELEGRAM_BOT_TOKEN conține" "$out"

# curl_quote refuză CR/LF (apărare în plus față de verificarea de mai sus).
out=$(NL="$NL" CR="$CR" sh -c '
  eval "$(sed -n "/^curl_quote() {/,/^}/p" "$1")"
  curl_quote "a$2b" >/dev/null; echo "lf=$?"
  curl_quote "a$3b" >/dev/null; echo "cr=$?"
  curl_quote "a\"b"; echo " ok=$?"' _ "$N" "$NL" "$CR" 2>&1)
check "curl_quote refuză LF" 0 0 "lf=2" "$out"
check "curl_quote refuză CR" 0 0 "cr=2" "$out"
check "curl_quote scapă ghilimelele" 0 0 'a\"b ok=0' "$out"

echo
if [ "$FAILS" -eq 0 ]; then echo "notify.sh: toate testele au trecut"; else echo "notify.sh: $FAILS eșecuri"; exit 1; fi
