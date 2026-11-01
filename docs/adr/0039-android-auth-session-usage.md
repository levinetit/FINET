# ADR 0039: clientul Android — autentificare, sesiune, statistici, blocare (Faza Android B)

- **Stare:** propus în branch `feature/android-b`. Continuă ADR 0038. Specificația: `docs/FINET_ANDROID_MASTER_PROMPT.md` §6, §10.1.
- **Legături:** `docs/API.md` (autentificare bearer, `X-FINET-Client`), `src/modules/auth/auth.ts` (plugin `bearer`), `docs/FINET_ANDROID_SECURITY.md`.

## Decizii

1. **Autentificare:** `POST /api/auth/sign-in/email` cu emailul și parola; tokenul de sesiune e antetul `set-auth-token` din răspuns. Apoi `Authorization: Bearer …` pe toate cererile. Mecanismul este pluginul `bearer` din Better Auth, fără alt mecanism paralel. Erorile Better Auth (`{ code, message }` la nivelul de sus) se normalizează în același `ApiError` ca erorile FINET; mesajele către utilizator sunt în română.
2. **Tokenul stă doar în `flutter_secure_storage`** (Android Keystore) și într-o variabilă din memorie. Nu există interceptor de log, iar tokenul nu apare în URL-uri. Profilul nu se păstrează pe disc: la pornire se cere din nou de la server (`GET /api/v1/me`), deci după deconectare nu rămân date ale utilizatorului.
3. **Sesiune expirată = un singur loc:** `UnauthorizedInterceptor` (401 pe o cerere cu token) apelează `SessionController.expire()`, care șterge tokenul, coada de statistici și starea ecranelor, apoi duce la login cu explicația „Sesiunea a expirat”. 403 nu se reîncearcă. Dacă serverul nu răspunde la pornire, tokenul se păstrează și se arată o reîncercare (nu se cere parola degeaba).
4. **Deconectare:** raportează `logout`, trimite ce e în coadă, apoi `POST /api/auth/sign-out` (revocă sesiunea pe server), apoi șterge datele locale. Revocarea pe server e „best effort” (cu timeout): fără rețea, telefonul tot se deconectează, iar sesiunea expiră singură pe server.
5. **`X-FINET-Client`** în forma completă, pe fiecare cerere: `platform=android; version; code; installation; os; model; locale`. Valorile se curăță după regulile serverului (altfel antetul ar fi ignorat tăcut). `installationId` e un UUID aleator, generat o dată și păstrat în stocarea securizată; nu se folosesc identificatori ai telefonului.
6. **Statistici de utilizare (§10.1):** evenimentele se strâng într-o coadă în memorie (cel mult 300), se trimit în loturi de cel mult 20 la 3 minute și la trecerea în fundal. Doar numele, ecranul, codul erorii (valori fixe din contractul serverului) și momentul. Fără sesiune nu se înregistrează nimic, deci o deconectare nu lasă evenimente; excepția e `session_expired`, care se trimite după următoarea autentificare. Alegerea utilizatorului (ecranul de informare, apoi Setări) se aliniază cu consimțământul `usageStats` de pe server în ambele sensuri. Implicit: pornit în `personal`, oprit în `saas` (`--dart-define=USAGE_STATS_DEFAULT=false`). Un 400/403 al serverului aruncă lotul, ca să nu se repete.
7. **`FLAG_SECURE` pe toată fereastra**, inclusiv în build-urile de debug (nu se pot face capturi de ecran în aplicație; asta e intenționat). `MainActivity` extinde `FlutterFragmentActivity` (cerință `local_auth`).
8. **Blocare cu amprentă / PIN (opțională):** `local_auth` cu fallback pe PIN-ul telefonului (nu doar biometrie), la deschidere și după 2 minute în fundal. Pornirea din Setări cere o autentificare reușită. Conținutul rămâne în arbore dar nu se desenează (`Offstage`), ca să se păstreze starea.
9. **Zidul Cloudflare Access:** mesajul din promptul Android §11 și un buton care duce la pagina aplicației Cloudflare One din Google Play (`com.cloudflare.cloudflareoneagent`, verificat că pagina există).

## Ce NU s-a verificat

- Autentificarea pe backendul real de test (cere hostname și cont de test de la operator) și accesul prin WARP de pe un telefon înrolat.
- Comportamentul pe un telefon real: `FLAG_SECURE`, promptul biometric, fonturile variabile.
- `integration_test` pe emulator: testele de sesiune rulează ca teste de widget, cu un server FINET simulat (`test/support/fake_server.dart`).

## Consecințe

- Analizorul Dart 3.13.7 se blochează pe o listă `const` de înregistrări (records) folosită într-un `for` de colecție; codul evită acest tipar (`more_screen.dart`).
