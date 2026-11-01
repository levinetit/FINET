# FINET Android — verificări de securitate

Se completează pe parcursul fazelor (`docs/FINET_ANDROID_MASTER_PROMPT.md` §6, §15). Stare la Faza E.

| Cerință | Stare | Dovadă |
|---|---|---|
| HTTPS obligatoriu în release; fără oprirea validării TLS | făcut | `network_security_config.xml` (fără trafic în clar), `AppEnv.validate`, teste `env_test.dart`; nu există `badCertificateCallback` |
| Trafic HTTP doar în debug, doar către `10.0.2.2`/`localhost` | făcut | `src/debug/res/xml/network_security_config.xml` |
| Tokenul doar în Android Keystore | făcut | `SecureKeyValueStore` (`flutter_secure_storage`); `StoreKeys.sessionToken` |
| Tokenul nu apare în loguri, URL-uri, erori, statistici | făcut | fără `LogInterceptor` (test), URL-urile nu conțin tokenul (test), `ApiError` nu poartă antete, evenimentele au câmpuri fixe (test) |
| Fără secrete în APK sau repository | făcut | `--dart-define` conține doar URL și comutatoare; nicio cheie, parolă sau service token Cloudflare |
| 401 → login, cu datele locale șterse | făcut | `UnauthorizedInterceptor` + `SessionController.expire()`; test `session_flow_test.dart` |
| 403 → mesaj clar, fără reîncercări | făcut | `RetryInterceptor` reîncearcă doar erori de rețea |
| Deconectare: revocare pe server, ștergerea tokenului și a cache-ului | făcut | test `deconectare` (server primește `sign-out` cu bearer; nimic nu rămâne) |
| `FLAG_SECURE` pe ferestrele cu date financiare | făcut (întreaga fereastră) | `MainActivity.kt` |
| Blocare opțională cu amprentă / PIN | făcut | `app_lock.dart`, `lock_test.dart`; neverificat pe telefon real |
| Ascunderea sumelor | făcut | `AmountText`, comutator în bara de sus |
| Fără date financiare în notificări | n/a | nu există notificări |
| Fără copii de siguranță ale datelor aplicației | făcut | `allowBackup=false`, `data_extraction_rules.xml` |
| Statistici: fără câmpuri financiare | făcut | `UsageEvent` are 4 câmpuri; test pe schemă |
| Acces cross-gospodărie | n/a (backend) | testat în backend (`404`) |
| Verificare pe telefon real | **neefectuată** | cere telefon cu WARP și backend de test |
| Fără permisiuni de cameră sau de stocare în APK | făcut | camera prin intentul sistemului, `tools:node="remove"` în manifest, verificare în `android.yml` (`if grep … exit 1`) |
| Fișiere partajate: doar `content://`, copiate în cache, șterse după încărcare și la deconectare | făcut | `MainActivity.kt`, `SystemTempFiles`, teste `scan_flow_test.dart` / `share_flow_test.dart` |
| Încărcări: aceiași octeți la reîncercare, fără bonuri dublate | făcut (pe server simulat) | `ScanController._prepared`, teste de reîncercare; duplicatele pe serverul real neverificate |
| Sumele ascunse acoperă ecranele Fazei D | făcut | un test pe fiecare ecran (recurențe, bonuri, extrase) |
| Camera, partajarea, EXIF/HEIC pe telefon real | **neefectuată** | cere telefon și backend de test |
| Release semnat doar cu cheia operatorului; fără cheie, build-ul eșuează | făcut (în CI cu cheie temporară) | `build.gradle.kts`, `android.yml` (release fără cheie trebuie să eșueze) |
| Amprenta certificatului comparată cu cea așteptată; nu cheia de debug | făcut (workflow) | `verify-android-apk.sh release`, `android-release.yml`; **neexecutat cu cheia reală** |
| Secretele de semnare nu apar în loguri; acțiunile terțe din release fixate pe SHA | făcut | `add-mask`, `env` pe pas, SHA-uri în `android-release.yml` |
| `API_BASE_URL` de release: HTTPS, nu local/rezervat | făcut | verificare în `android-release.yml` + `AppEnv.validate` |
| Actualizare: doar link HTTPS, fără instalare automată; sub minim, fără funcții financiare | făcut | `UpdateInfo.fromJson`, `redirectFor(updateRequired)`, `update_flow_test.dart` |
| Partajare: doar `content://` ale altor aplicații, autorități neobișnuite refuzate | făcut | `MainActivity.kt`; neverificat pe dispozitiv |
| Instalare și rulare pe telefon real | **neefectuată** | cere telefon, hostname, cont de test |
