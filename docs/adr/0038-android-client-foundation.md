# ADR 0038: clientul Android — fundația (Faza Android A)

- **Stare:** propus în branch `feature/android-a`. Audit: `docs/FINET_ANDROID_AUDIT.md`. Specificația: `docs/FINET_ANDROID_MASTER_PROMPT.md`.
- **Legături:** ADR 0020 (`GET /api/v1/app/android/latest`), `docs/API.md` (autentificare bearer, `Idempotency-Key`, `X-FINET-Client`).

## Decizii

1. **Aplicația stă în `mobile/`** (Flutter, Dart), în același repository, fără să atingă aplicația web. Backendul rămâne autoritatea pentru date, reguli și autentificare; clientul nu are bază de date proprie și nu recalculează sume.
2. **`applicationId` = `ro.finet.app`** (decizia operatorului, 2026-11-01). Se fixează o singură dată: schimbarea lui ar crea o aplicație nouă pe telefoane.
3. **`minSdk` = 29 (Android 10)** (decizia operatorului, 2026-11-01), în loc de 26 din promptul Android. Motiv: telefoanele familiei sunt recente; Android 10 simplifică stocarea fișierelor și permisiunile de cameră.
4. **Flutter 3.47.9 (stable, Dart 3.13.7)**, fixat în `.github/workflows/android.yml` și în `mobile/README.md`. Se schimbă doar printr-un PR dedicat.
5. **Dependențe (Faza A):** `flutter_riverpod` (stare), `go_router` (navigare), `dio` (HTTP), `intl`, `uuid` (cheile de idempotență), `mocktail` (teste). Fiecare e pe pub.dev, cu versiunea stabilă curentă la data adăugării; dependențele pentru sesiune (`flutter_secure_storage`, `local_auth`), cameră și grafice se adaugă în fazele care le folosesc. `freezed`/`json_serializable` nu intră în Faza A: modelele generate din `docs/openapi.json` vin cu primele răspunsuri reale (Faza B/C), ca să nu avem cod generat fără consumator.
6. **Bani:** `Money(int amountMinor, Currency)`, niciodată `double`. `parseAmount` urmărește `parseAmount` din web și rulează aceleași cazuri de test (`test/core/money/parse_amount_test.dart` ↔ `src/lib/money.test.ts`). Formatarea (`1.234,56 lei`, `25.10.2026`) nu depinde de limba telefonului, ca rezultatul să fie același pe orice dispozitiv. Plafonul e 2^53 − 1, ca pe web, deși `int` are 64 de biți pe Android.
7. **Rețea:** HTTPS obligatoriu în release (`network_security_config` fără trafic în clar; doar build-ul de debug permite `10.0.2.2` și `localhost`), `AppEnv.validate` refuză la pornire un build release cu HTTP, adresă locală sau date simulate. Redirecturile nu se urmează, ca un redirect către Cloudflare Access să fie recunoscut (`ApiErrorKind.accessWall`, mesajul din promptul Android §11).
8. **Idempotență și reîncercări:** fiecare `POST` primește un `Idempotency-Key` (UUID v4) o singură dată; reîncercările automate (doar erori de rețea, maximum două, doar pentru `GET`/`HEAD`/`PUT`/`DELETE` sau `POST` cu cheie) refolosesc aceeași cheie. Un răspuns de eroare al serverului nu se reîncearcă.
9. **Date simulate:** în Faza A toate ecranele cu cifre citesc din `core/data/mock_data.dart` și afișează banda „Date simulate”. Un build release nu poate porni cu date simulate. Dispar în Faza C.
10. **Fonturi incluse în aplicație** (OFL): Bricolage Grotesque și IBM Plex Sans ca fonturi variabile, IBM Plex Mono static. Greutatea se setează explicit prin `fontVariations`. Nu s-a verificat încă vizual pe un dispozitiv (nu există emulator pe hostul de dezvoltare): se confirmă la prima instalare pe telefon.
11. **Copii de siguranță dezactivate** (`allowBackup=false`, reguli de extragere goale): date financiare și, din Faza B, tokenul de sesiune nu pleacă în copiile Google.
12. **Construire:** pe hostul de dezvoltare nu se construiește APK (nu există Android SDK, memorie puțină). Analiza și testele rulează local într-un container cu Flutter; APK-ul se construiește doar în GitHub Actions. Semnarea release și publicarea (`android-release.yml`) vin în Faza E; până atunci tipul `release` e semnat cu cheia de debug și nu se distribuie.

## Ce nu face Faza A

Nu are autentificare, nu apelează API-ul și nu stochează nimic pe telefon. `FLAG_SECURE`, blocarea biometrică, statisticile de utilizare și `X-FINET-Client` sunt Faza B.
