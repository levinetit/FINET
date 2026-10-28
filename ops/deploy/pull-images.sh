#!/bin/sh
# Descarcă din GitHub imaginile FINET construite de workflow-ul `images` pentru un commit și le
# încarcă în Docker, sub numele pe care le așteaptă compose-ul (finet:local, finet:tools,
# finet:backup).
#
# Rulează pe host, ca root (citește tokenul GitHub, care nu e al utilizatorului obișnuit):
#   sudo sh ops/deploy/pull-images.sh <sha-commit>            # toate imaginile (web, tools, backup)
#   sudo sh ops/deploy/pull-images.sh <sha-commit> web        # doar web
#   sudo sh ops/deploy/pull-images.sh <sha-commit> backup     # doar imaginea de backup (F3-D)
# Variabile: GITHUB_REPO (implicit levinetit/FINET), GITHUB_TOKEN_FILE (token cu Actions: read).
# Proveniență: se acceptă doar artefacte din rularea `push` reușită a workflow-ului images, din același
# repository, pe exact commit-ul cerut (vezi trusted_run_id); tarball-ul trebuie să conțină exact
# imaginea așteptată. Tokenul nu apare în argumentele proceselor (antetul vine pe stdin, curl -K -).
set -eu

SHA="${1:-}"
WHICH="${2:-all}"
REPO="${GITHUB_REPO:-levinetit/FINET}"
TOKEN_FILE="${GITHUB_TOKEN_FILE:-/home/docker-apps/secrete/github-finet.token}"

case "$SHA" in
  *[!0-9a-f]* | "") echo "Folosire: $0 <sha-commit-complet-de-40-caractere> [web|tools|backup|all]" >&2; exit 2 ;;
esac
[ "${#SHA}" -eq 40 ] || { echo "SHA-ul trebuie să aibă 40 de caractere (git rev-parse HEAD)." >&2; exit 2; }
case "$WHICH" in web | tools | backup | all) ;; *) echo "Al doilea argument: web, tools, backup sau all." >&2; exit 2 ;; esac
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

# Rularea de încredere a workflow-ului `images`: doar evenimentul `push`, încheiată cu succes, pe
# exact commit-ul cerut, din ACELAȘI repository (nu dintr-un fork), pe `main` sau `phase/*`.
# Altfel orice alt workflow (de exemplu `ci` pe un PR dintr-un fork) ar putea încărca un artefact
# cu același nume, pe care scriptul l-ar încărca apoi în Docker ca root.
trusted_run_id() {
  api "https://api.github.com/repos/${REPO}/actions/workflows/images.yml/runs?head_sha=${SHA}&event=push&status=success&per_page=10" \
    | REPO="$REPO" SHA="$SHA" python3 -I -c '
import json, os, re, sys
repo, sha = os.environ["REPO"], os.environ["SHA"]
for r in json.load(sys.stdin).get("workflow_runs", []):
    if (r.get("head_sha") == sha and r.get("event") == "push" and r.get("conclusion") == "success"
            and r.get("path") == ".github/workflows/images.yml"
            and (r.get("head_repository") or {}).get("full_name") == repo
            and (r.get("repository") or {}).get("full_name") == repo
            and re.fullmatch(r"(main|phase/[A-Za-z0-9._/-]+)", r.get("head_branch") or "")):
        print(r["id"]); break
'
}

fetch_one() { # $1 = web | tools | backup
  _n="$1"
  _name="finet-${_n}-${SHA}"
  _expected="finet:${_n}-${SHA}"
  echo "== ${_n}: caut artefactul ${_name} în rularea de încredere"
  _run="$(trusted_run_id)"
  [ -n "$_run" ] || { echo "Nu există o rulare reușită a workflow-ului images (push, același repository, main sau phase/*) pentru ${SHA}." >&2; return 1; }
  _id="$(api "https://api.github.com/repos/${REPO}/actions/runs/${_run}/artifacts?name=${_name}&per_page=5" \
    | python3 -I -c 'import json,sys; a=[x for x in json.load(sys.stdin).get("artifacts",[]) if not x.get("expired")]; print(a[0]["id"] if len(a)==1 else "")')"
  [ -n "$_id" ] || { echo "Artefactul ${_name} lipsește, a expirat sau nu e unic în rularea ${_run}." >&2; return 1; }
  api "https://api.github.com/repos/${REPO}/actions/artifacts/${_id}/zip" "$WORK/${_n}.zip"
  mkdir -p "$WORK/${_n}"
  python3 -I -c 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); n=z.namelist(); exp={sys.argv[3]+".tar.gz", sys.argv[3]+".tar.gz.sha256"}; assert set(n)==exp, n; z.extractall(sys.argv[2])' "$WORK/${_n}.zip" "$WORK/${_n}" "finet-${_n}"
  ( cd "$WORK/${_n}" && sha256sum -c "finet-${_n}.tar.gz.sha256" )
  # Înainte de `docker load`: tarball-ul trebuie să conțină exact o imagine, cu exact eticheta așteptată.
  gunzip -c "$WORK/${_n}/finet-${_n}.tar.gz" > "$WORK/${_n}/image.tar"
  python3 -I -c '
import json, sys, tarfile
t = tarfile.open(sys.argv[1])
m = json.load(t.extractfile("manifest.json"))
tags = [tag for e in m for tag in (e.get("RepoTags") or [])]
assert len(m) == 1 and tags == [sys.argv[2]], (len(m), tags)
' "$WORK/${_n}/image.tar" "$_expected" \
    || { echo "Tarball-ul nu conține exact imaginea ${_expected}; refuz." >&2; return 1; }
  _loaded="$(docker load -i "$WORK/${_n}/image.tar" | sed -n 's/^Loaded image: //p')"
  [ "$_loaded" = "$_expected" ] || { echo "docker load a raportat '${_loaded}', așteptam ${_expected}." >&2; return 1; }
  case "$_n" in web) _tag="finet:local" ;; tools) _tag="finet:tools" ;; backup) _tag="finet:backup" ;; esac
  docker tag "$_loaded" "$_tag"
  echo "   încărcată ${_loaded} → ${_tag}"
}

case "$WHICH" in
  web) fetch_one web ;;
  tools) fetch_one tools ;;
  backup) fetch_one backup ;;
  all) fetch_one web; fetch_one tools; fetch_one backup ;;
esac
docker images finet --format '{{.Repository}}:{{.Tag}} {{.Size}} {{.CreatedSince}}'
