# FINET — note de confidențialitate (modul `personal`)

Notă internă, nu politică de confidențialitate publică (aceea vine în `saas`, Faza 11). Datele prelucrate sunt financiare și sensibile pentru familie.

## Împuterniciți (procesatori)

| Furnizor | Ce vede / stochează | Regiune | Stare |
|---|---|---|---|
| **Cloudflare** (Tunnel, Access, WARP, DNS) | Decriptează traficul HTTPS la marginea rețelei, deci **vede datele în tranzit** (pagini, răspunsuri API, fișiere încărcate). Vede emailurile familiei (login Access, înrolare WARP) și metadate (IP, dispozitiv, ore). | Global (rețeaua Cloudflare); nu se garantează procesarea doar în UE pe planul gratuit | De confirmat de operator: planul, termenii DPA Cloudflare acceptați |
| **Supabase** | Baza de date PostgreSQL (toate datele financiare) și, din Faza 6, fișierele (bonuri, extrase) în bucket privat | UE, Irlanda (`eu-west-1`) | Proiect creat la 2026-10-27; SSL obligatoriu, acces la bază doar de la IP-ul VPS-ului; bucket privat `finet-docs` (gol) |
| **VPS-ul docker-apps** (operatorul) | Containerele FINET, fișierele temporare și, cu `STORAGE_DRIVER=local`, fișierele în `/srv/finet/storage`; secretele ca fișiere în `/srv/finet/secrets/` (`1000:1000 0400`, director root 700), montate prin `secrets:` | Locația VPS-ului: de completat de operator | `/srv/finet/` e în afara backup-ului hostului (vezi mai jos); din T7 secretele FINET nu mai ajung în configurația containerelor din arhiva necriptată a `/home/docker` |
| **Google Drive** (backup-ul hostului, rclone) | Tot `/home`, zilnic: o copie criptată (`GdriveCrypt:home`) și una **necriptată** (`Gdrive:vpnde/home`), plus duminica o arhivă necriptată a `/home/docker` | Google (global) | FINET nu mai are date sub `/home`; vezi „Backup-ul hostului” |
| **Telegram** sau furnizorul SMTP | Doar textul notificărilor operaționale (fără sume, fără date ale familiei) | Furnizorul ales | Canalul nu e configurat |
| **Google (Gemini) prin LiteLLM-ul de pe gazdă** (`litellm-apps`, alias-urile `finet-vision-external`, `finet-text-external`) | Doar cu consimțământul `external_ai` activ al celui care încarcă și în bugetul lunar: **imaginea preprocesată a bonului** (JPEG re-encodat, fără EXIF/GPS/metadate, max. 2048 px) sau, pentru PDF cu text, **textul bonului** (≤ 12 000 de caractere); pentru categorisire, **numele normalizate ale produselor** și **numele categoriilor** gospodăriei. Niciodată: originalul, numele fișierului, emailul, id-uri, alte tranzacții. LiteLLM (pe VPS) vede aceleași date în tranzit. | Google (regiunea modelului, de confirmat de operator); LiteLLM pe VPS | Implementat în F6-B (ADR 0014); `AI_MONTHLY_BUDGET=0` (nimic nu pleacă) până la decizia operatorului |

## Măsuri existente în cod (Faza 0)
- Fără Data API Supabase și fără chei `anon`/`service_role` în FINET (configurare: `ops/supabase/`).
- JWT Access verificat în aplicație (fail closed), deci cererile care ocolesc Cloudflare nu primesc date.
- `/api/health` nu întoarce versiuni, căi, host sau mesaje de eroare.
- Mesajele de eroare ale configurației nu conțin valori (nici conținutul sau calea fișierelor `*_FILE`); niciun secret în `NEXT_PUBLIC_*` (scanare în CI).
- Secretele intră în containere ca fișiere (`*_FILE`), nu ca variabile de mediu (N1).
- TLS spre Supabase cu `sslmode=verify-full` și CA-ul Supabase impus din cod (`DATABASE_CA_FILE`).
- Notificările nu includ date financiare (regulă pentru scripturile care vor folosi `ops/notify/notify.sh`).

## Backup-ul hostului (constatare F2, 2026-10-27)
- Scripturile de backup ale hostului (`backup_home_gdrive.sh`, criptat, și `backup_home_gdrive_clar.sh`, **necriptat**) fac `rclone sync /home` pe Google Drive cu un filtru care nu exclude nimic FINET. Un director FINET sub `/home` (bonuri, extrase, fișiere `.env`) ar ajunge zilnic pe Drive, inclusiv în clar.
- **Decizia:** datele și secretele FINET stau în `/srv/finet/` (`env/`, `storage/`, `compose/`, `ca/`), în afara `/home`. Backup-ul propriu, criptat (restic: `pg_dump` + fișiere), vine în Faza 3.
- **N1, închis tehnic (T7):** arhiva săptămânală necriptată a `/home/docker` conține `config.v2.json` al fiecărui container. Secretele FINET (URL-urile bazei, tokenul de sănătate) sunt acum fișiere montate prin `secrets:`, deci în `config.v2.json` apare doar calea lor, iar `env_file` are doar valori nesecrete.
- **Rămâne deschis (operator, în afara FINET):** aceeași arhivă conține mediul **altor** containere de pe host și logurile `json-file` (inclusiv ale FINET, fără secrete). Variante: excluderea `/home/docker/containers` din arhivă sau criptarea arhivei.
- Verificare după deploy: `sudo rclone ls Gdrive:vpnde/home | grep -i finet` (și `GdriveCrypt:home`) nu arată fișiere FINET.

## Statistici de utilizare și URL-uri (Faza 2, revizuirea F2)
- `client_installations` și `app_events` se scriu doar cu consimțământul `usage_stats` activ; la revocare (`PUT /api/v1/me/consents` cu `usageStats: false`) instalările și evenimentele utilizatorului se **șterg**. Cel mult 20 de instalări per utilizator.
- **Retenția evenimentelor (Faza 9, F9-B, ADR 0021):** 13 luni; apoi comanda zilnică `finet-admin aggregate-events` le agregă pe zi, nume, platformă, versiune, ecran și cod de eroare (fără utilizator, instalare sau gospodărie: agregat anonim) și le șterge. La revocarea `usage_stats` și la ștergerea contului, evenimentele utilizatorului se șterg.
- **Căutarea în URL (LOW-3):** parametrul `q` din `GET /api/v1/transactions` (și din pagina de tranzacții) e în URL. Aplicația nu loghează URL-uri sau query string-uri (logurile ei au doar mesaje fixe), dar Cloudflare (tunel/Access), Traefik și eventualele proxy-uri pot înregistra URL-urile complete în jurnalele lor. Recomandare pentru operator: fără jurnale de acces cu query string pe hostname-ul FINET. Alternativă într-o fază viitoare: `POST /api/v1/transactions/search`.

## Documente încărcate (Faza 6, F6-A)
- **Ce se stochează:** fișierul original (poză sau PDF) în `/srv/finet/storage/households/<gospodărie>/documents/<id>`, pe VPS (driverul local; bucket-ul Supabase rămâne gol). Originalul **păstrează EXIF-ul, inclusiv locația GPS**, până la ștergere sau retenție (decizia mea: originalul se păstrează pentru exportul GDPR „fișierele originale”); doar copia trimisă la AI e fără metadate. În bază: tipul detectat, dimensiunea, SHA-256, hash-ul perceptual (dHash, nu permite reconstruirea imaginii), stările; nu se stochează numele fișierului.
- **Retenția:** `RECEIPT_IMAGE_RETENTION_DAYS` (implicit 180; 0 = niciodată) setează `expires_at` la încărcare; după expirare se șterge **doar fișierul** (datele extrase rămân). Jobul care o aplică: `admin cleanup-documents` (F6-C, ADR 0015), rulat zilnic de operator prin serviciul `finet-cleanup` (INFRA 4i); până la programarea lui, originalele rămân pe disc.
- **Fără consimțământ `external_ai`:** documentul se stochează, nu pleacă nicăieri (nu există model local în Faza 6), rămâne „așteaptă consimțământul”; bonul se poate introduce manual. Retragerea consimțământului oprește trimiterile viitoare.
- **Ștergerea** (5.6): rândul și bonul extras, apoi fișierul; tranzacțiile create din bon rămân, fără legătură. Auditul nu conține nume de fișiere sau conținut.
- **Jurnalul AI** (`ai_calls`): doar metadate (sarcina, modelul, durata, costul estimat, rezultatul), fără imagini sau text.
- **Afișarea (F6-C):** originalul se servește DOAR membrilor gospodăriei, prin `GET /api/v1/documents/{id}/file` (sesiune + RLS, `no-store`, `attachment`, nume generat de server); niciun link public sau semnat. Browserul nu trimite numele fișierului (formularul îl înlocuiește cu `bon-<n>`). Corecturile de categorie ale utilizatorului se păstrează ca alias pe numele normalizat al produsului (`product_aliases`, în gospodărie), ca bonurile următoare să le folosească.
- **Consimțământul în interfață (F6-C):** comutatorul „Citirea bonurilor cu AI” din `/profile` explică ce pleacă și către cine; pagina `/import` arată când lipsește.
- **Backup:** fișierele din `/srv/finet/storage` intră în backup-ul restic criptat al FINET (ADR 0009), nu în backup-ul `/home` al hostului.

## Pipeline-ul AI (Faza 6, F6-B; ADR 0014)
- **Ce pleacă, către cine:** Google (Gemini), prin LiteLLM-ul de pe gazdă (`litellm-apps`, cheie virtuală per aplicație, `finet_litellm_key`). Pleacă:
  - poza preprocesată (fără metadate);
  - sau textul unui PDF, plafonat la 12 000 de caractere. **Atenție:** un bon electronic poate avea tipărite date personale (numele clientului, numărul cardului de fidelitate, ultimele cifre ale cardului bancar); pleacă așa cum sunt pe bon;
  - pentru categorisire, numele normalizate ale produselor și numele categoriilor de cheltuieli ale gospodăriei.
- **Condiții:** consimțământul `external_ai` al celui care a încărcat (verificat la procesare, sub lock; retragerea oprește trimiterile următoare), bugetul lunar global `AI_MONTHLY_BUDGET` > 0 și neepuizat, plus AI configurat (`AI_BASE_URL` + cheia).
- **Ce rămâne local:** bonul extras (`receipts`, `receipt_lines`, `ocr_text`: textul PDF-ului sau numele citite, pentru căutare) în Supabase. `ai_calls` și `ai_budget_usage` țin doar metadate (sarcină, model, tokeni, cost estimat, durată, rezultat), fără conținut. Logurile workerului au doar coduri și contoare.
- **Retenția la furnizor:** după termenii Google/LiteLLM. De confirmat de operator: dacă LiteLLM înregistrează corpurile cererilor (jurnalele/spend logs cu conținut), opțiunea trebuie oprită pentru cheia FINET.

## Vizibilitatea între membrii unei gospodării (Faza 8, F8-A; ADR 0016)
- **Conturile personale** (`owner_user_id` = membrul) și tot ce ține de ele (tranzacții, transferuri — mai puțin jumătatea din contul comun —, etichete, reguli recurente, sumele din dashboard, rapoarte, bugete și exporturi) sunt vizibile DOAR proprietarului, impus în bază (RLS). Conturile comune le văd toți membrii.
- **Excepții încă vizibile tuturor membrilor în bază (nu prin interfață):** jurnalul de audit (`audit_events`: acțiunea, tipul și id-ul obiectului, fără sume sau texte, deci și id-urile obiectelor personale) și răspunsurile salvate ale cheilor de idempotență (`idempotency_keys.response`, 24 h; prin API se obțin doar cu cheia exactă, aleatoare). Restrângerea lor la autor e amânată (ADR 0016, punctul 10, m3).
- **Împărțirile și decontările** (cine a plătit, cât datorează fiecare, decontările și notele lor) le văd toți membrii gospodăriei, ca soldurile să fie aceleași pentru toți; descrierea, comerciantul și contul cheltuielii împărțite rămân private plătitorului.
- **Rămân vizibile tuturor membrilor (amânat):** documentele și bonurile încărcate (comerciant, total, produse), chiar dacă bonul a fost confirmat pe un cont personal; obiectivele; existența numelui unui cont personal (un nume deja folosit nu mai poate fi ales de alt membru). Recomandare: bonurile private nu se încarcă în gospodăria comună.
- **Invitațiile:** în bază se păstrează doar hash-ul tokenului, cine a invitat, rolul și datele; nu se stochează emailul invitatului. Linkul în clar se arată o singură dată celui care invită.
- **Decontările înregistrate de un owner** (risc acceptat, ADR 0016 §10): un owner poate stinge o datorie dintre alți doi membri; dacă apoi îl elimină pe creditor, acesta nu mai poate anula decontarea. Dialogul de eliminare arată decontările active ale membrului.
- **Plecarea / eliminarea:** nu sunt blocate de solduri; soldurile și decontările rămân în istoric, cu cel plecat marcat ca fost membru. Datele din conturile comune rămân gospodăriei; conturile personale ale celui plecat rămân în gospodărie, invizibile tuturor, și se șterg doar odată cu gospodăria (de revăzut la ștergerea contului, master prompt 5.6).

## Familia în interfață și actualizările live (Faza 8, F8-B; ADR 0017)
- **Ce vede fiecare membru pe `/family`:** numele și rolurile membrilor (fără emailuri), soldurile reciproce și decontările (cu notele), împărțirile (cine a plătit, cât datorează fiecare; fără descrierea cheltuielii), numele conturilor și bugetelor COMUNE și ale propriilor conturi/bugete personale. Foștii membri apar în solduri doar ca „fost membru”, fără nume.
- **Invitațiile:** linkul se arată o singură dată celui care invită, doar în pagină (nu se salvează în browser); înainte de acceptare, pagina de invitație nu arată numele gospodăriei. Tokenul apare în calea URL-ului, deci poate rămâne în istoricul browserului și în jurnalele de acces ale Cloudflare/Traefik (unică folosință, expiră în ≤ 7 zile).
- **Actualizările live (SSE):** evenimentele conțin doar tipul și id-ul obiectului, nu sume, nume sau descrieri; o tranzacție dintr-un cont personal nu generează eveniment pentru ceilalți membri. Evenimentele nu se stochează (memoria procesului web).

## Extrase bancare (Faza 7; ADR 0018, 0019)
- **Ce se păstrează:** pentru fiecare import doar contul, banca, formatul, perioada, soldurile, contoarele, codurile de avertisment și amprenta SHA-256 a fișierului; rândurile parsate (dată, sumă, descriere, referința băncii). **Fișierul extrasului NU se păstrează** (nici numele lui): un PDF stă doar temporar, până îl citește workerul (vezi mai jos). Din descrieri se elimină IBAN-urile, numerele de card și `CNP/CF`; rămân numele contrapărții și detaliile operațiunii. IBAN-ul și titularul din antet nu se stochează (doar ultimele 4 caractere ale IBAN-ului sunt întoarse în previzualizare, ca indiciu pentru alegerea contului).
- **Vizibilitatea:** un import pe un cont personal (și rândurile lui) îl vede doar proprietarul contului (RLS, ca tranzacțiile din 0012); pe un cont comun îl văd toți membrii.
- **Fișierele PDF (F7-B; ADR 0018 §11):** se păstrează TEMPORAR, doar cât să le citească workerul: în storage-ul aplicației (`households/<id>/documents/…`, fără numele original), cel mult 24 h, și se șterg imediat după confirmarea sau renunțarea la previzualizare (altfel de `cleanup-documents`). Sunt vizibile doar membrilor care văd contul (un cont personal: doar proprietarului). CSV/XLSX nu se păstrează deloc. Previzualizările neconfirmate se șterg după 7 zile.
- **Exportul și ștergerea contului (Faza 9):** exportul GDPR conține `extrase.json` (importurile create de utilizator, cu rândurile lor; fără fișiere); ștergerea contului șterge și PDF-urile temporare de extras din gospodăriile șterse și de pe conturile personale ale utilizatorului (rândurile dispar în cascadă).
- **Potrivirea bon ↔ extras și plățile recurente (ADR 0019):** se calculează în aplicație, fără AI; respingerile memorează doar identificatori, respectiv amprenta propunerii (nu textul comerciantului).
- **Fără AI:** extrasele nu se trimit la niciun furnizor (nici local, nici extern) în Faza 7; consimțământul `external_ai_statements` nu e încă folosit. Parsarea PDF-urilor se face în procesul copil al workerului, pe server.
- **Extrasele reale de test ale operatorului** nu intră în repo, în teste, în documentație sau în CI: fixture-urile sunt sintetice (generate de `scripts/make-statement-fixtures.mjs`), iar verificarea pe extrasele reale s-a făcut doar local, cu raportare agregată.
- **Ștergere:** o previzualizare neconfirmată se șterge cu rândurile ei; un import anulat rămâne în istoric (fără tranzacții); ștergerea gospodăriei șterge tot (cascadă).

## PWA și scanarea offline (Faza 9, F9-A; ADR 0020)
- **Ce rămâne pe dispozitiv:** doar fișierele aplicației în cache-ul service worker-ului (cod JavaScript/CSS compilat, iconițe, manifestul, pagina „fără conexiune”). Nicio pagină cu date, niciun răspuns API.
- **Pozele scanate fără rețea:** stau în IndexedDB-ul browserului (baza `finet-offline`), cu id-ul utilizatorului și al gospodăriei, până când serverul confirmă încărcarea; apoi se șterg. Plafoane: 10 încărcări, 50 MB, 7 zile (după 7 zile se șterg neîncărcate).
- **Alt utilizator pe același browser:** pozele unui utilizator nu se încarcă niciodată în contul sau gospodăria altuia; la pornirea aplicației pentru alt utilizator ele se șterg, iar la **deconectare** se șterge toată baza.
- **Pagina „fără conexiune”** afișează doar numărul încărcărilor în așteptare (nu pozele).
- **Invitația de instalare:** se păstrează local doar preferința „nu mai arăta” (`localStorage`).
- **Aplicația Android:** pagina de descărcare arată metadatele versiunii (fără date personale); codul QR se generează pe server, fără serviciu extern.

## Export și ștergere GDPR, statistici (Faza 9, F9-B; ADR 0021)
- **Exportul** (Setări → Datele mele, `GET /api/v1/me/export`): o arhivă ZIP cu profilul, preferințele, consimțămintele, sesiunile (data, expirarea, IP-ul și browserul, fără tokenuri), metodele de autentificare (fără parolă), instalările și evenimentele proprii; pe fiecare gospodărie: tot ce vede utilizatorul în aplicație (conturi, categorii, etichete, tranzacții în JSON și CSV, bugete, obiective, recurențe), bonurile încărcate de el cu fișierele lor, împărțirile și decontările în care e parte, acțiunile lui din jurnalul de audit. **Nu** conține conturile personale ale altor membri, numele sau emailurile altora, parole, tokenuri sau chei. 3 exporturi pe oră; auditat fără conținut. Limita arhivei: 4 GB și 65.535 de fișiere (formatul ZIP fără ZIP64); peste ea serverul refuză dinainte (413) și exportul îl face operatorul, din backup.
- **Ștergerea contului** (Setări → Datele mele): cu parola și confirmarea „ȘTERGE”; imediată, fără fereastră de grație. Se șterg: gospodăriile în care era singurul membru (cu toate datele și fișierele), conturile lui personale din toate gospodăriile (cu tranzacțiile lor), bugetele personale, sesiunile, parola, preferințele, instalările, evenimentele; consimțămintele se revocă. Din gospodăriile cu alți membri iese; datele comune (conturile comune, tranzacțiile lor, documentele încărcate în gospodăria comună) rămân celorlalți. Dacă împărțiri sau decontări din istoricul celorlalți îl menționează, rândul lui rămâne **anonimizat** („Cont șters”, email înlocuit, cont dezactivat), altfel se șterge complet. Ultimul proprietar al unei gospodării cu alți membri transferă întâi rolul; administratorul platformei nu se poate șterge din aplicație (operatorul desemnează întâi altul). Pe dispozitiv, coada offline (IndexedDB) se golește.
- **Fișierele** gospodăriilor șterse se șterg din storage după ștergerea din bază; o eroare rară de disc poate lăsa fișiere orfane (neservite de nicio rută), curățate de operator cu `finet-admin cleanup-orphan-storage` (ADR 0021).
- **Backup-urile** (restic, Faza 3) păstrează datele șterse până la expirarea instantaneelor (7 zilnice, 4 săptămânale, 12 lunare): ștergerea nu rescrie backup-urile vechi. De menționat în politica de confidențialitate (`saas`).
- **Statisticile** (Setări → Statistici, doar administratorul platformei): numere agregate (utilizatori activi, instalări și versiuni, login-uri, evenimente, ecrane, erori, apeluri AI și costul lor de operare); în `personal` și lista membrilor cu ultima activitate, platforma și versiunea aplicației. **Nicio** sumă, descriere, comerciant sau alt conținut financiar.

## Prețuri, inflație, rapoarte de micro-cheltuieli (Faza 10, F10-B; ADR 0023)
- **Ce se calculează:** prețuri pe produs și comerciant, inflație personală și rapoarte pe nume de produse, toate din liniile bonurilor tale confirmate. Sunt date derivate din bonuri: aceleași reguli de acces ca bonurile. Nu se folosește LLM și nu pleacă nimic la furnizori externi.
- **Conturi personale:** liniile bonurilor legate de contul PERSONAL al altui membru nu intră în agregatele tale (nici în totaluri, nici în acoperirea proiecției). Un bon fără tranzacție legată se tratează ca bon comun, cum era deja vizibil în `/receipts`.
- **Definițiile de rapoarte** (`report_definitions`) conțin reguli de nume (text liber, ≤ 60 de caractere) create de utilizator; cele ale gospodăriei sunt vizibile membrilor, cele de sistem tuturor. Exportul GDPR include rapoartele create de utilizator (`rapoarte-micro-cheltuieli.json`), nu pe cele de sistem.
- **Exportul CSV al unui raport** conține liniile potrivite (nume de produse, sume, date): același regim ca exporturile CSV existente. Fără statistici între gospodării.
- **Loguri:** fără nume de produse sau reguli în loguri, audit sau mesaje de eroare (coduri fixe).

## TODO (operator / faze viitoare)
- **Retenția:** pozele bonurilor au `RECEIPT_IMAGE_RETENTION_DAYS` (implicit 180, F6-A; jobul de ștergere `cleanup-documents`, F6-C); extrasele PDF cel mult 24 h (F7-B); rămân de decis: extrasele, pentru loguri (`json-file` 3×10 MB pe container acum) și pentru backup-uri (Faza 3) — **TODO**.
- **Ștergerea:** regulile din master prompt 5.6 — implementate (Fazele 2–9; ștergerea contului în F9-B). Rămâne de decis expirarea datelor șterse din backup-uri (mai sus).
- Loguri fără date sensibile: de verificat la fiecare fază (încă nu există loguri de aplicație).
- Dacă aplicația trece în `saas`: politică publică, DPA-uri, lista împuterniciților, cookie-uri.
