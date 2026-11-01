#!/usr/bin/env bash
# Verifică un APK FINET: identificator, versiune minimă, permisiuni interzise, filtrele de
# partajare și (pentru release) semnătura.
#
# Utilizare:
#   verify-android-apk.sh <apk> debug
#   verify-android-apk.sh <apk> release <amprenta SHA-256 așteptată | -> [versionName] [versionCode]
#
# `-` ca amprentă = nu se compară (doar pentru verificarea cu o cheie temporară din PR-uri).
# Nu tipărește chei sau parole. Verificările negative folosesc `if` explicit: un `! grep` nu
# oprește scriptul sub `set -e`.
set -euo pipefail

apk="${1:?apk}"
mode="${2:?debug|release}"
expected_cert="${3:--}"
expected_name="${4:-}"
expected_code="${5:-}"

fail() {
  echo "Verificare eșuată: $*" >&2
  exit 1
}

test -s "$apk" || fail "APK-ul lipsește sau e gol"
size=$(stat -c %s "$apk")
echo "Mărime: $size octeți"
[ "$size" -gt 5000000 ] || fail "mărime neplauzibilă ($size)"

tools=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
aapt2="$tools/aapt2"
apksigner="$tools/apksigner"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
"$aapt2" dump badging "$apk" > "$work/badging.txt"
head -5 "$work/badging.txt"

grep -q "package: name='ro.finet.app'" "$work/badging.txt" || fail "applicationId"
grep -q "^minSdkVersion:'29'" "$work/badging.txt" || fail "minSdk"
grep -q "uses-permission: name='android.permission.INTERNET'" "$work/badging.txt" || fail "INTERNET"

# Pictograma adaptivă FINET (XML), nu cea implicită Flutter (PNG în mipmap-*). În release,
# restrângerea resurselor poate redenumi fișierul, deci se verifică tipul, nu numele.
grep -q "application-icon-[0-9]*:'[^']*\.xml'" "$work/badging.txt" \
  || fail "pictograma de lansare nu e una adaptivă (XML)"
if grep -q "application-icon-[0-9]*:'[^']*\.png'" "$work/badging.txt"; then
  fail "pictograma de lansare PNG (implicită Flutter)"
fi

# Camera prin intentul sistemului: nicio permisiune de cameră sau de stocare în APK.
if grep -E "uses-permission(-sdk-23)?: name='android\.permission\.(CAMERA|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_MEDIA[^']*)'" "$work/badging.txt"; then
  fail "permisiune interzisă în APK"
fi

# „Partajează" din alte aplicații: filtrele de intent trebuie să existe în APK-ul construit.
"$aapt2" dump xmltree --file AndroidManifest.xml "$apk" > "$work/manifest.txt"
for needle in \
  'android.intent.action.SEND"' \
  'android.intent.action.SEND_MULTIPLE"' \
  '"image/*"' \
  '"application/pdf"' \
  '"text/csv"'; do
  grep -qF "$needle" "$work/manifest.txt" || fail "lipsește din manifest: $needle"
done

if [ "$mode" = "release" ]; then
  # Nu are voie să fie depanabil. (Traficul HTTP în clar e permis doar de configurația de rețea din
  # `src/debug`, care nu intră în release.)
  if grep -q "application-debuggable" "$work/badging.txt"; then
    fail "APK-ul release e depanabil"
  fi
  "$apksigner" verify --verbose --print-certs "$apk" > "$work/sign.txt" 2>&1 \
    || fail "semnătura nu se verifică"
  grep -E "^(Verifies|Verified using)" "$work/sign.txt" || true
  cert=$(grep -E "Signer #1 certificate SHA-256 digest:" "$work/sign.txt" | awk '{print $NF}' | head -1)
  [ -n "$cert" ] || fail "nu pot citi amprenta certificatului"
  echo "Amprenta certificatului: $cert"
  if grep -qF "CN=Android Debug" "$work/sign.txt"; then
    fail "APK-ul e semnat cu cheia de debug"
  fi
  if [ "$expected_cert" != "-" ]; then
    want=$(echo "$expected_cert" | tr -d ': ' | tr 'A-F' 'a-f')
    [ "$cert" = "$want" ] || fail "amprenta certificatului nu e cea așteptată"
    echo "Amprenta corespunde cu cea așteptată."
  fi
  if [ -n "$expected_name" ]; then
    grep -q "versionName='$expected_name'" "$work/badging.txt" || fail "versionName"
  fi
  if [ -n "$expected_code" ]; then
    grep -q "versionCode='$expected_code'" "$work/badging.txt" || fail "versionCode"
  fi
fi
echo "APK verificat ($mode)."
