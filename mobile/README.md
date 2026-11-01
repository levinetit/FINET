# FINET Android

Clientul Android al FINET (Flutter). Specificația: `docs/FINET_ANDROID_MASTER_PROMPT.md`; audit și plan: `docs/FINET_ANDROID_AUDIT.md`; decizii: `docs/adr/0038-android-client-foundation.md`.

- `applicationId`: `ro.finet.app` · `minSdk`: 29 (Android 10)
- Flutter **3.47.9** (stable), Dart 3.13.7. Aceeași versiune e fixată în `.github/workflows/android.yml`.
- Faza A: ecrane pe **date simulate** (banda „Date simulate”).
- Faza B: autentificare (Better Auth `bearer`), sesiune, profil și gospodării, statistici de utilizare, blocare cu amprentă. Cifrele rămân simulate până în Faza C.

## Comenzi

```sh
cd mobile
flutter pub get
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
flutter build apk --debug --dart-define=USE_MOCK_DATA=true
```

## Configurare (`--dart-define`)

| Variabilă | Rol |
|---|---|
| `API_BASE_URL` | adresa serverului FINET; în release doar HTTPS, fără adrese locale. Valoarea reală o dă operatorul. |
| `USE_MOCK_DATA` | `true` implicit până în Faza C; un build release cu date simulate nu pornește. |
| `USAGE_STATS_DEFAULT` | `true` implicit (`personal`); `false` pentru `saas` (statisticile cer acord explicit). |

Valorile `--dart-define` nu sunt secrete (se pot extrage din APK). Aplicația nu conține chei, parole sau service tokenuri.

## Structură

- `lib/core/money/`: `Money`, `parseAmount`, `formatMoney` (aceleași reguli ca `src/lib/money.ts`).
- `lib/core/network/`: clientul Dio, interceptorii (autentificare, `Idempotency-Key`, reîncercări), `ApiError`.
- `lib/core/theme/`: tokenii FINET și tema Material 3 (luminoasă și întunecată).
- `lib/features/`: ecranele (Acasă, Tranzacții, Scanează, Rapoarte, Mai mult).
- `assets/fonts/`: fonturile (licență OFL, textele alăturate).

## Licențe

Fonturile Bricolage Grotesque și IBM Plex sunt sub SIL Open Font License 1.1 (`assets/fonts/OFL-*.txt`).
