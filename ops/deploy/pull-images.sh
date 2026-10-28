#!/bin/sh
# Descarcă din GitHub imaginile FINET construite de workflow-ul `images` pentru un commit și le
# încarcă în Docker, sub numele pe care le așteaptă compose-ul (finet:local, finet:tools).
#
# Rulează pe host, ca root (citește tokenul GitHub, care nu e al utilizatorului obișnuit):
#   sudo sh ops/deploy/pull-images.sh <sha-commit>            # ambele imagini
#   sudo sh ops/deploy/pull-images.sh <sha-commit> web        # doar web
# Variabile: GITHUB_REPO (implicit levinetit/FINET), GITHUB_TOKEN_FILE (token cu Actions: read).
# Tokenul nu apare în argumentele proceselor (antetul vine pe stdin, `curl -K -`).
set -eu

SHA="${1:-}"
WHICH="${2:-all}"
REPO="${GITHUB_REPO:-levinetit/FINET}"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-/home/docker-apps/secrete/github-finet.token}"

case "$SHA" in
  *[!0-9a-f]* | "") echo "Folosire: $0 <sha-commit-complet-de-40-caractere> [web|tools|all]" >&2; exit 2 ;;
esac
[ "${#SHA}" -eq 40 ] || { echo "SHA-ul trebuie să aibă 40 de caractere (git rev-parse HEAD)." >&2; exit 2; }
case "$WHICH" in web | tools | all) ;; *) echo "Al doilea argument: web, tools sau all." >&2; exit 2 ;; esac
[ -r "$TOKEN_FILE" ] || { echo "Nu pot citi tokenul GitHub ($TOKEN_FILE); rulează cu sudo." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

api() { # $1 = URL; răspunsul pe stdout sau într-un fișier dacă se dă $2
  _out="${2:-}"
  if [ -n "$_out" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\r\n ' < "$TOKEN_FILE")" \
      | curl -fsSL -m 600 -K - -H 'Accept: application/vnd.github+json' -o "$_out" "$1"
  else
    printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\r\n ' < "$TOKEN_FILE")" \
      | curl -fsS -m 60 -K - -H 'Accept: application/vnd.github+json' "$1"
  fi
}

fetch_one() { # $1 = web | tools
  _n="$1"
  _name="finet-${_n}-${SHA}"
  echo "== ${_n}: caut artefactul ${_name}"
  _id="$(api "https://api.github.com/repos/${REPO}/actions/artifacts?name=${_name}&per_page=1" \
    | python3 -I -c 'import json,sys; a=json.load(sys.stdin).get("artifacts",[]); a=[x for x in a if not x.get("expired")]; print(a[0]["id"] if a else "")')"
  [ -n "$_id" ] || { echo "Artefactul ${_name} nu există sau a expirat (retenție 7 zile). Verifică workflow-ul images pe GitHub." >&2; return 1; }
  api "https://api.github.com/repos/${REPO}/actions/artifacts/${_id}/zip" "$WORK/${_n}.zip"
  mkdir -p "$WORK/${_n}"
  python3 -I -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$WORK/${_n}.zip" "$WORK/${_n}"
  ( cd "$WORK/${_n}" && sha256sum -c "finet-${_n}.tar.gz.sha256" )
  _loaded="$(gunzip -c "$WORK/${_n}/finet-${_n}.tar.gz" | docker load | sed -n 's/^Loaded image: //p' | head -1)"
  [ -n "$_loaded" ] || { echo "docker load nu a raportat o imagine." >&2; return 1; }
  case "$_n" in web) _tag="finet:local" ;; tools) _tag="finet:tools" ;; esac
  docker tag "$_loaded" "$_tag"
  echo "   încărcată ${_loaded} → ${_tag}"
}

case "$WHICH" in
  web) fetch_one web ;;
  tools) fetch_one tools ;;
  all) fetch_one web; fetch_one tools ;;
esac
docker images finet --format '{{.Repository}}:{{.Tag}} {{.Size}} {{.CreatedSince}}'
