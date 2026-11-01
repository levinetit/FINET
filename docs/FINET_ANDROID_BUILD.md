# FINET Android — build, semnare, release și instalare

Specificația: `docs/FINET_ANDROID_MASTER_PROMPT.md` §11, §12. Deciziile: `docs/adr/0042-android-release-and-stabilization.md`.

## 1. Unde se construiește

Aplicația (`mobile/`) se construiește în **GitHub Actions** (`.github/workflows/android.yml` pentru PR-uri, `android-release.yml` pentru versiuni). Hostul `docker-apps` nu are SDK Android; pe el se pot rula doar `dart format`, `dart analyze` și `flutter test` (în containerul `finet-flutter-dev`).

Pe un calculator de dezvoltare (≥ 15 GB liberi): Flutter **3.47.9** (stable), JDK 17, Android SDK.

```bash
cd mobile
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
flutter build apk --debug --dart-define=API_BASE_URL=<URL de test primit de la operator>
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

`API_BASE_URL` nu se inventează: îl dă operatorul. Valorile `--dart-define` nu sunt secrete (se pot extrage din APK). Emulatorul ajunge la backendul local prin `10.0.2.2` (doar build-uri de debug).

## 2. Cheia de semnare (o singură dată, de către operator)

Cheia release se generează **o singură dată**, de operator, pe un calculator al lui, și se păstrează **în afara repository-ului, cu backup** (fără ea nu mai poți publica actualizări peste aceeași instalare). Parolele nu se trimit prin chat și nu se pun în repository.

```bash
keytool -genkeypair -v -keystore upload-keystore.jks -storetype PKCS12 \
  -alias finet -keyalg RSA -keysize 4096 -validity 10000
# amprenta SHA-256 a certificatului (se pune în variabila ANDROID_CERT_SHA256):
keytool -list -v -keystore upload-keystore.jks -alias finet | grep "SHA256:"
# conținutul pentru secretul ANDROID_KEYSTORE_BASE64:
base64 -w0 upload-keystore.jks
```

`*.jks` și `key.properties` sunt în `.gitignore`.

### Ce se pune în GitHub (Settings → Environments → `production`)

| Tip | Nume | Valoare |
|---|---|---|
| Secret | `ANDROID_KEYSTORE_BASE64` | `base64 -w0 upload-keystore.jks` |
| Secret | `ANDROID_KEYSTORE_PASSWORD` | parola keystore-ului |
| Secret | `ANDROID_KEY_ALIAS` | `finet` (aliasul de mai sus) |
| Secret | `ANDROID_KEY_PASSWORD` | parola cheii |
| Variabilă | `API_BASE_URL` | URL-ul de producție, **HTTPS** (de la operator) |
| Variabilă | `ANDROID_CERT_SHA256` | amprenta SHA-256 de mai sus |
| Variabilă (opțional) | `ANDROID_MIN_SUPPORTED_VERSION_CODE` | cod minim acceptat; implicit 1 |

Build-ul local de release citește aceeași cheie din variabilele `FINET_KEYSTORE_PATH`, `FINET_KEYSTORE_PASSWORD`, `FINET_KEY_ALIAS`, `FINET_KEY_PASSWORD` sau din `android/key.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`). **Fără cheie, build-ul release se oprește** (nu există cale de rezervă către cheia de debug).

## 3. Cum se publică o versiune

1. Scrie notele în română: `mobile/release-notes/X.Y.Z.md` (ce e nou). Fără fișier, workflow-ul nu publică.
2. Pune versiunea în `mobile/pubspec.yaml` (`version: X.Y.Z+N`) pentru build-urile locale; în release, `versionName` vine din tag, iar `versionCode` e numărul rulării workflow-ului (crește monoton).
3. Creează tag-ul și împinge-l: `git tag FINET-vX.Y.Z && git push origin FINET-vX.Y.Z`. Workflow-ul acceptă doar `FINET-v[0-9]+.[0-9]+.[0-9]+`.
4. `android-release.yml` rulează formatul, analiza și testele (dacă pică, nu se publică nimic), construiește APK-ul semnat, îl verifică (`apksigner verify --print-certs`, amprenta comparată cu `ANDROID_CERT_SHA256`, `applicationId`, `minSdk`, permisiuni, filtre de partajare, versiune) și creează un GitHub Release cu:
   - `finet-X.Y.Z.apk`
   - `finet-X.Y.Z.apk.sha256`
   - `android-latest.json` (metadatele pentru `GET /api/v1/app/android/latest`)
5. **Publicarea în FINET** (ca aplicațiile instalate să vadă versiunea nouă): copiază `android-latest.json` în `<STORAGE_DIR>/app/android-latest.json` pe serverul FINET (fișierul se citește la fiecare cerere, fără restart). `minSupportedVersionCode` din fișier forțează actualizarea tuturor versiunilor mai vechi: ridică-l doar după o schimbare incompatibilă de API.

Verificarea manuală a unui APK descărcat:

```bash
sha256sum -c finet-X.Y.Z.apk.sha256
apksigner verify --print-certs finet-X.Y.Z.apk   # amprenta trebuie să fie cea așteptată
```

## 4. Instalare pe telefon

1. Descarcă `finet-X.Y.Z.apk` din GitHub Releases (sau din FINET → Setări → Aplicația Android) și verifică suma SHA-256.
2. La prima instalare, Android cere permisiunea „Instalează aplicații necunoscute” pentru browserul sau managerul de fișiere folosit.
3. Actualizările se instalează peste aplicația existentă (aceeași cheie de semnare). Aplicația nu instalează nimic singură: arată „Versiune nouă disponibilă”, iar instalarea o confirmi în instalatorul Android.
4. Alternativă pentru actualizări automate: aplicația **Obtainium** poate urmări pagina de Releases a repository-ului (adaugă URL-ul repository-ului, filtrează fișierele `.apk`).

Din `adb`: `adb install -r finet-X.Y.Z.apk`.

## 5. Accesul telefonului la FINET (modul `personal`)

FINET este în spatele Cloudflare Access; telefoanele trec prin **Cloudflare One Agent (WARP)**. Aplicația nu conține service tokenuri Cloudflare și nu ocolește Access.

1. Instalează **Cloudflare One Agent** din Google Play (pachetul `com.cloudflare.cloudflareoneagent`).
2. Deschide aplicația, alege „Log in with Cloudflare Zero Trust” și introdu numele organizației Zero Trust (de la operator). Confirmă emailul cu codul primit.
3. Verifică: agentul arată „Connected”. Apoi deschide FINET.
4. Dacă FINET afișează „Nu te poți conecta la FINET. Pornește aplicația Cloudflare One și încearcă din nou.”, agentul e oprit sau înrolarea a expirat: pornește-l și încearcă din nou.

Politica Access pentru dispozitive și identitatea venită prin WARP: `ops/cloudflare/README.md`, pasul 5. **Neverificat de mine pe un telefon real.**

## 6. Ce rămâne neverificat

Instalarea și rularea pe un telefon real, login pe backendul real de producție, comportamentul prin WARP și cheia reală de semnare nu au fost testate: cer un telefon, hostname-ul, un cont de test și cheia operatorului. CI dovedește compilarea, semnarea cu o cheie temporară, verificările APK-ului și că un build release fără cheie eșuează.
