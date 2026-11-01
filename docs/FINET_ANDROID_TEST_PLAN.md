# FINET Android — plan de testare

## Ce rulează automat (CI: `.github/workflows/android.yml`)

| Verificare | Ce dovedește |
|---|---|
| `dart format --set-exit-if-changed`, `flutter analyze` | cod formatat, fără erori de analiză |
| `flutter test` (peste 250 de teste) | logica clientului pe un server FINET simulat |
| APK debug + `verify-android-apk.sh debug` | `applicationId`, `minSdk`, fără permisiuni de cameră/stocare, filtre de partajare, pictogramă adaptivă |
| Release fără cheie trebuie să EȘUEZE | nu există APK release nesemnat sau semnat cu cheia de debug |
| Release cu cheie temporară + `verify-android-apk.sh release` | configurația release se construiește, se semnează, `apksigner verify` trece |

Testele de widget acoperă: sesiune și 401/403, blocare, statistici (fără câmpuri financiare), tranzacții (idempotență, paginare, filtre), bugete/obiective, rapoarte, recurențe, bonuri (octeți identici la reîncercare, ordinea câmpurilor multipart, dialog de duplicat, potriviri), extrase (sold nepotrivit, schimb valutar, PDF în coadă), partajare (pornire la rece, după login), actualizări (banner, versiune minimă), ascunderea sumelor pe fiecare ecran, **layout la font 200% și pe ecran mic/tabletă**, ghidurile Android de accesibilitate (ținte ≥ 48 dp, etichete, contrast).

## Ce NU rulează automat (manual, pe telefon)

Lista de verificare pentru primul telefon real (cere hostname, cont de test, WARP):

1. Instalare APK semnat; „Instalează aplicații necunoscute"; actualizare peste versiunea veche.
2. Login/logout pe backendul real; token absent din loguri; după logout nu rămân date.
3. Cifrele Acasă/Tranzacții/Bugete/Rapoarte identice cu aplicația web pe aceleași date.
4. Cameră: bon fotografiat → „De verificat" → confirmat → apare în tranzacții; același bon încărcat de două ori e recunoscut ca duplicat; poză rotită corect; EXIF absent; HEIC din galerie.
5. Partajare: PDF/CSV/imagine din altă aplicație deschide importul (pornire la rece și cu aplicația deschisă).
6. `FLAG_SECURE` (captură de ecran blocată), blocare cu amprentă, ascunderea sumelor.
7. TalkBack pe ecranele principale; font mărit în setările telefonului.
8. Conexiune slabă (mod avion intermitent): mesaje clare, nicio acțiune dublată.
9. Actualizare: o versiune nouă publicată apare ca „Versiune nouă disponibilă"; sub `minSupportedVersionCode` apare ecranul de actualizare.

Teste de integrare pe emulator (`integration_test`) nu există încă: cer un emulator în CI.
