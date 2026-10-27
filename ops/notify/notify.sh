#!/bin/sh
# FINET — notificări operaționale (master prompt 3.1): un singur canal, Telegram sau email,
# folosit de toate scripturile din ops/ (backup, versiunea PostgreSQL, /api/health, disc).
#
# Utilizare:
#   notify.sh [--env-file FIȘIER] [--dry-run] MESAJ...
#   notify.sh [--env-file FIȘIER] [--dry-run] --test
#
# Canalul se alege din variabilele prezente (în mediu sau în --env-file):
#   - Telegram, dacă sunt setate NOTIFY_TELEGRAM_BOT_TOKEN și NOTIFY_TELEGRAM_CHAT_ID;
#   - altfel email, dacă sunt setate SMTP_HOST, SMTP_FROM și NOTIFY_EMAIL_TO
#     (opțional SMTP_PORT, implicit 587; SMTP_USER/SMTP_PASSWORD).
# Variabilele deja setate în mediu au prioritate față de --env-file.
#
# --dry-run: nu trimite nimic și nu accesează rețeaua; afișează canalul, destinatarul și cererea,
# cu secretele mascate.
#
# Secretele (tokenul botului, parola SMTP) nu apar în argumentele proceselor (`ps`): se dau lui
# curl prin configurația citită din stdin (`curl -K -`). Scriptul nu folosește `set -x`.
#
# Coduri de ieșire: 0 trimis (sau dry-run reușit), 1 trimiterea a eșuat, 2 utilizare sau
# configurație invalidă.

set -eu

PROG=notify.sh
DRY_RUN=0
TEST=0
ENV_FILE=

usage() {
  echo "Utilizare: $PROG [--env-file FIȘIER] [--dry-run] (--test | MESAJ...)" >&2
  exit 2
}

fail_config() {
  echo "$PROG: $1" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --test) TEST=1; shift ;;
    --env-file)
      [ $# -ge 2 ] || usage
      ENV_FILE=$2; shift 2 ;;
    --help|-h) usage ;;
    --) shift; break ;;
    -*) usage ;;
    *) break ;;
  esac
done

# Citește DOAR cheile cunoscute din fișierul de mediu, fără să-l execute (nu `source`).
load_env_file() {
  [ -r "$1" ] || fail_config "fișierul de mediu nu poate fi citit"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      NOTIFY_TELEGRAM_BOT_TOKEN=*|NOTIFY_TELEGRAM_CHAT_ID=*|NOTIFY_EMAIL_TO=*|\
      SMTP_HOST=*|SMTP_PORT=*|SMTP_USER=*|SMTP_PASSWORD=*|SMTP_FROM=*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    value=${line#*=}
    # Ghilimele simple sau duble în jurul valorii, dacă există.
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    # Mediul are prioritate.
    eval "current=\${$key-}"
    if [ -z "$current" ]; then
      eval "$key=\$value"
      export "${key?}"
    fi
  done < "$1"
}

[ -n "$ENV_FILE" ] && load_env_file "$ENV_FILE"

if [ "$TEST" -eq 1 ]; then
  [ $# -eq 0 ] || usage
  MESSAGE="FINET: mesaj de test al canalului de notificări ($(hostname 2>/dev/null || echo necunoscut), $(date -u '+%Y-%m-%dT%H:%M:%SZ'))."
else
  [ $# -gt 0 ] || usage
  MESSAGE=$*
fi

# Escape pentru valorile scrise între ghilimele în configurația curl.
curl_quote() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

TG_TOKEN=${NOTIFY_TELEGRAM_BOT_TOKEN-}
TG_CHAT=${NOTIFY_TELEGRAM_CHAT_ID-}

if [ -n "$TG_TOKEN" ] || [ -n "$TG_CHAT" ]; then
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] ||
    fail_config "NOTIFY_TELEGRAM_BOT_TOKEN și NOTIFY_TELEGRAM_CHAT_ID se setează împreună"
  # Formatul tokenului: <id>:<cheie>; orice alt caracter e refuzat (evită injectarea în config).
  printf '%s' "$TG_TOKEN" | grep -Eq '^[0-9]{1,20}:[A-Za-z0-9_-]{20,200}$' ||
    fail_config "NOTIFY_TELEGRAM_BOT_TOKEN are un format invalid"
  printf '%s' "$TG_CHAT" | grep -Eq '^-?[0-9]{1,20}$' ||
    fail_config "NOTIFY_TELEGRAM_CHAT_ID are un format invalid"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "canal: telegram"
    echo "destinatar: chat $TG_CHAT"
    echo "cerere: POST https://api.telegram.org/bot***/sendMessage"
    echo "mesaj: $MESSAGE"
    exit 0
  fi

  response=$(printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TG_TOKEN" |
    curl -sS --max-time 15 --proto '=https' -K - \
      --data-urlencode "chat_id=$TG_CHAT" \
      --data-urlencode "text=$MESSAGE" \
      --data-urlencode "disable_web_page_preview=true") || {
    echo "$PROG: trimiterea pe Telegram a eșuat (rețea)" >&2
    exit 1
  }
  case "$response" in
    *'"ok":true'*) echo "trimis: telegram"; exit 0 ;;
    *) echo "$PROG: Telegram a refuzat mesajul" >&2; exit 1 ;;
  esac
fi

SMTP_HOST_V=${SMTP_HOST-}
if [ -n "$SMTP_HOST_V" ]; then
  SMTP_FROM_V=${SMTP_FROM-}
  EMAIL_TO=${NOTIFY_EMAIL_TO-}
  SMTP_PORT_V=${SMTP_PORT:-587}
  [ -n "$SMTP_FROM_V" ] || fail_config "SMTP_FROM lipsește"
  [ -n "$EMAIL_TO" ] || fail_config "NOTIFY_EMAIL_TO lipsește"
  printf '%s' "$SMTP_PORT_V" | grep -Eq '^[0-9]{1,5}$' || fail_config "SMTP_PORT invalid"
  printf '%s' "$SMTP_HOST_V" | grep -Eq '^[A-Za-z0-9.-]{1,253}$' || fail_config "SMTP_HOST invalid"

  # Adresa simplă din „Nume <adresă>”.
  addr_of() {
    case "$1" in
      *'<'*'>'*) a=${1#*<}; printf '%s' "${a%%>*}" ;;
      *) printf '%s' "$1" ;;
    esac
  }
  FROM_ADDR=$(addr_of "$SMTP_FROM_V")
  TO_ADDR=$(addr_of "$EMAIL_TO")
  for a in "$FROM_ADDR" "$TO_ADDR"; do
    printf '%s' "$a" | grep -Eq '^[^[:space:]<>"@]+@[A-Za-z0-9.-]+$' ||
      fail_config "adresă de email invalidă în SMTP_FROM sau NOTIFY_EMAIL_TO"
  done

  # 465 = TLS implicit; altfel STARTTLS obligatoriu, cu excepția unui server local de test.
  case "$SMTP_PORT_V" in
    465) SMTP_URL="smtps://$SMTP_HOST_V:$SMTP_PORT_V"; TLS_OPT= ;;
    *)
      SMTP_URL="smtp://$SMTP_HOST_V:$SMTP_PORT_V"
      case "$SMTP_HOST_V" in
        localhost|127.0.0.1|mailpit) TLS_OPT= ;;
        *) TLS_OPT=--ssl-reqd ;;
      esac ;;
  esac

  SUBJECT="FINET: notificare operațională"
  [ "$TEST" -eq 1 ] && SUBJECT="FINET: test notificări"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "canal: email"
    echo "destinatar: $TO_ADDR"
    echo "cerere: $SMTP_URL ${TLS_OPT:-fără-TLS} de la $FROM_ADDR${SMTP_USER:+ (autentificare: ***)}"
    echo "mesaj: $MESSAGE"
    exit 0
  fi

  BODY=$(mktemp)
  trap 'rm -f "$BODY"' EXIT INT TERM
  {
    printf 'From: %s\r\n' "$SMTP_FROM_V"
    printf 'To: %s\r\n' "$TO_ADDR"
    printf 'Subject: =?UTF-8?B?%s?=\r\n' "$(printf '%s' "$SUBJECT" | base64 | tr -d '\n')"
    printf 'Date: %s\r\n' "$(LC_ALL=C date -R)"
    printf 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n'
    printf 'Content-Transfer-Encoding: 8bit\r\n\r\n%s\r\n' "$MESSAGE"
  } > "$BODY"

  {
    if [ -n "${SMTP_USER-}" ]; then
      printf 'user = "%s:%s"\n' "$(curl_quote "$SMTP_USER")" "$(curl_quote "${SMTP_PASSWORD-}")"
    fi
  } | curl -sS --max-time 30 -K - $TLS_OPT --url "$SMTP_URL" \
      --mail-from "$FROM_ADDR" --mail-rcpt "$TO_ADDR" --upload-file "$BODY" || {
    echo "$PROG: trimiterea emailului a eșuat" >&2
    exit 1
  }
  echo "trimis: email"
  exit 0
fi

fail_config "niciun canal configurat (Telegram: NOTIFY_TELEGRAM_*; email: SMTP_HOST, SMTP_FROM, NOTIFY_EMAIL_TO)"
