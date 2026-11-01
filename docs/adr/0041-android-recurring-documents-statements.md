# ADR 0041: clientul Android — recurențe, bonuri, extrase și partajare (Faza Android D)

- **Stare:** propus în branch `feature/android-d`. Continuă ADR 0038–0040. Specificația: `docs/FINET_ANDROID_MASTER_PROMPT.md` §10, §8 (Faza D).
- **Legături:** `docs/API.md` (documents, receipts, matching, statements, recurring), `docs/openapi.json`.

## Decizii

1. **Telefonul nu citește nimic.** Fotografiază, pregătește, încarcă, urmărește și afișează. Verificările bonului (`issues`), suma liniilor (`linesSumMinor`), scorul, furnizorul (`providerUsed`) și motivul de rezervă (`fallbackReason`) vin de la server și se afișează cu aceleași texte ca pe web (`src/messages/ro.ts`). Cât timp liniile au modificări nesalvate, ecranul spune că suma „se actualizează după salvare"; clientul nu o recalculează.
2. **Fără permisiuni de cameră sau de stocare.** Camera folosește intentul sistemului (`image_picker`), galeria selectorul de poze, fișierele selectorul de documente (`file_picker`). Manifestul scoate explicit `CAMERA`, `READ/WRITE_EXTERNAL_STORAGE` (`tools:node="remove"`), iar CI verifică APK-ul construit (cu `if grep … exit 1`; un `! grep` ar fi fost ignorat sub `set -e`).
3. **Pregătirea pozelor:** JPEG, calitate 85, fără EXIF, rotirea din EXIF aplicată înainte de ștergere (`flutter_image_compress`), latura mare adusă la ~2000 px. Pluginul scalează după latura mică, deci minimul se calculează din dimensiunile din antet (`compressionMin`, testat). HEIC/HEIF se decodează nativ (Android 10+) și ies JPEG. PDF, CSV și XLSX se trimit neschimbate. Fără OCR local.
4. **Octeții de încărcat se pregătesc o singură dată și se refolosesc.** `POST /documents` nu are `Idempotency-Key`; serverul deduplică după SHA-256. O recodare la reîncercare ar crea un duplicat real. `FormData` e consumat la trimitere, deci cererile multipart sunt excluse din reîncercarea generică (`RetryInterceptor.noRetryKey`), iar `ReceiptsApi.upload` / `StatementsApi.upload` reconstruiesc corpul din aceiași octeți (cel mult două reîncercări, doar erori de rețea). Câmpurile text merg înaintea fișierelor (serverul citește fluxul); testele parsează corpul multipart brut și verifică ordinea.
5. **Duplicate:** octeți identici → `200` cu `duplicate: true` (ecranul de stare o spune). Un posibil duplicat la confirmare (`409 possible_duplicate`) cere un dialog; `allowDuplicate` se trimite doar după acordul explicit, cu o cheie nouă de idempotență.
6. **Urmărirea documentelor** (`GET /documents/{id}`) și a PDF-urilor de extras: flux `autoDispose` cu pauze crescătoare 2–8 s, oprit la stare finală sau de așteptare. `awaiting_consent` e o stare de așteptare explicată (consimțământul AI se activează din Profil în aplicația web), nu o încărcare.
7. **Recurențe:** listă cu contoare de la server, filtru pe stare, pauză/reluare (`409 recurring_completed` afișat), „Generează acum" cu `Idempotency-Key` per apăsare, propuneri (acceptă/respinge). Nu creează reguli (nu e în specificație).
8. **Extrase:** acoperire pe luni, încărcare PDF/CSV/XLSX, previzualizare, confirmare cu cheie, renunțare, anulare. Soldurile nepotrivite cer o bifă explicită (`acknowledgeBalanceMismatch`). Rândurile de schimb valutar cer decizie explicită (serverul refuză confirmarea fără ea): „Sari peste" sau „Ca tranzacție obișnuită". Transferul între conturi (`mode: transfer`) nu e disponibil.
9. **Partajare din alte aplicații** (`SEND`/`SEND_MULTIPLE` pe `image/*`, PDF, CSV, XLSX): `MethodChannel` mic în `MainActivity.kt`, fără dependență externă. Copiază doar URI-uri `content://` (nu `file://`, care ar putea arăta spre datele private ale aplicației) în `cache/finet_share`, în afara firului principal, cu plafon de siguranță de 64 MB. Fișierele așteaptă într-un provider cât timp utilizatorul nu e autentificat sau aplicația e blocată; după login/deblocare importul continuă. Poze → Scanează; CSV/XLSX → import de extras; un PDF → alegere bon/extras.
10. **Fișiere temporare:** șterse după ce serverul confirmă încărcarea, la anulare/scoatere și la deconectare (`finet_share`, `image_picker`, `file_picker`).
11. **Ascunderea sumelor:** totalurile bonurilor, sumele liniilor, recurențele, candidații de potrivire, rândurile și soldurile extraselor trec prin `displayMoney`; câte un test pe fiecare ecran. Câmpurile de editare ale sumelor arată valoarea editată (utilizatorul o modifică intenționat).
12. **Statistici:** `receipt_scan_started`, `receipt_uploaded`, `receipt_confirmed`, `statement_imported`, `share_import`, `recurring_generated`, ecranele `recurring`, `receipts`, `statements` (toate în enumerările serverului).

## Ce nu face Faza D

- **Limitele de încărcare (`MAX_UPLOAD_MB`, 20 MB la extrase) nu sunt expuse de API.** Clientul nu le scrie în cod; serverul răspunde `413 file_too_large`, afișat clar. Un endpoint pentru limite ar fi un PR de backend separat.
- Nu creează reguli recurente, conturi, categorii sau transferuri.
- Nu are asocierea coloanelor pentru CSV/XLSX necunoscut (`mapping_required`): spune să se facă din aplicația web.
- Nu are transfer între conturi la schimb valutar, nici alegerea rândurilor de sărit (`skipRows`) la import, nici politica `editedPolicy` la anularea unui import cu tranzacții editate (serverul răspunde `409`, mesajul se afișează).
- Nu are „Ordonează automat" pentru bonul lung cu poze în altă ordine (`suggestedOrder`): ordinea se alege la fotografiere.
- Nu are coada offline pentru poze (după MVP, conform specificației).
- **Neverificat pe dispozitiv:** camera, selectorul de galerie, rotirea/EXIF și decodarea HEIC, partajarea din alte aplicații, detectarea duplicatelor de către serverul real, citirea PDF-urilor de extras. Testele rulează pe un server FINET simulat; CI dovedește doar compilarea, permisiunile și existența filtrelor de intent în APK.
