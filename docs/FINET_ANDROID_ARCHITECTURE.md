# FINET Android — arhitectură

Clientul Flutter din `mobile/`. Decizii: ADR 0038–0042. Specificația: `docs/FINET_ANDROID_MASTER_PROMPT.md`.

## Principii

- **Backendul este sursa adevărului.** Totaluri, solduri, bugete, verificările bonurilor, duplicatele și potrivirile le calculează serverul. Clientul afișează și formatează (`1.234,56 lei`); nu recalculează sume. Sumele sunt `int` în unități minore (`Money`), niciodată `double`.
- **Nicio acțiune repetată nu dublează date.** `Idempotency-Key` (UUID) generat o dată per acțiune și păstrat la reîncercări; încărcările refolosesc aceiași octeți (serverul deduplică după SHA-256).
- **Fără SDK de analitică.** Statisticile merg la `POST /api/v1/app/events` (câmpuri fixe, fără date financiare).
- **Fără secrete în APK.** Tokenul de sesiune stă în Android Keystore; cheia de semnare nu intră în repository.

## Straturi

```text
lib/
  main.dart, app.dart          pornire, MaterialApp.router, LockGate, ShareCoordinator
  core/
    config/                    AppEnv (API_BASE_URL din --dart-define, validat)
    network/                   Dio, interceptori (auth, X-FINET-Client, Idempotency-Key, reîncercări), ApiError
    money/, time/              Money, parseAmount, formatMoney; fusul orar al gospodăriei
    storage/                   KeyValueStore (Keystore / memorie în teste)
    router.dart                go_router: porți (intro, login, splash), navigare de jos, rute secundare
    theme/, widgets/           tokenii FINET, Material 3, componente comune
  features/
    auth/, profile/, settings/ sesiune bearer, profil, gospodării, confidențialitate
    lock/                      blocare cu amprentă / PIN
    usage/                     coada de evenimente de utilizare
    finance/ home/ transactions/ budgets/ reports/   (Faza C)
    recurring/                 plăți recurente
    scan/, receipts/           cameră/galerie/PDF, încărcare, verificarea bonului, potriviri
    statements/                import de extrase, acoperire
    share/                     „Partajează" din alte aplicații
    update/                    verificarea versiunii, banner, ecran de actualizare
android/                       MainActivity.kt (FLAG_SECURE, canal de partajare), manifest, semnare
```

Starea: Riverpod 3 (`Notifier`, `FutureProvider.autoDispose`). Navigare: go_router 18. HTTP: Dio 5. Modelele sunt scrise de mână după `docs/openapi.json`, cu citire strictă.

## Fluxuri importante

- **Sesiune:** login Better Auth (`/api/auth/sign-in/email`) → token în antetul `set-auth-token` → `Authorization: Bearer`. 401 pe o cerere cu token → date locale șterse, ecran de login. Deconectarea revocă sesiunea și șterge tokenul, coada de evenimente, fișierele temporare și starea sumelor.
- **Bon:** poză (intentul sistemului, fără permisiune de cameră) → JPEG fără EXIF în memorie → `POST /documents` (câmpuri text înaintea fișierului) → urmărire (`GET /documents/{id}`, pauze 2–8 s) → verificare (`GET/PATCH /receipts/{id}`) → `POST /receipts/{id}/confirm` cu cheie.
- **Extras:** `POST /statements/uploads` → previzualizare (sau PDF în coada workerului) → `POST /statements/imports/{id}/confirm`.
- **Actualizare:** `GET /app/android/latest` cel mult o dată pe zi; sub `minSupportedVersionCode` aplicația duce la un ecran de actualizare și nu mai trimite cereri financiare.
- **Partajare:** `MainActivity.kt` copiază fișierele `content://` ale altor aplicații în cache; `ShareCoordinator` așteaptă autentificarea și deblocarea, apoi deschide importul potrivit.

## Testare

`flutter test` rulează pe un server FINET simulat (`test/support/fake_server.dart` și modulele `fake_*`), inclusiv multipart brut. Vezi `docs/FINET_ANDROID_TEST_PLAN.md`.
