# FINET Android — MASTER PROMPT pentru Claude Code (v1)

Client Android pentru FINET România · Flutter · API REST `/api/v1` · APK

> **Cum se folosește acest document**
> - Aplicația Android e un client al backendului FINET. Regulile din `docs/FINET_MASTER_PROMPT.md` (bani, timp, formatare, securitate, gospodărie) se aplică și aici; documentul de față le adaugă doar pe cele specifice mobilului.
> - Rulează **o singură fază per sesiune**, pe un branch dedicat (`feature/android-<fază>`), cu PR și revizuire umană înainte de faza următoare.
> - Prompt de pornire per sesiune: *„Citește `docs/FINET_ANDROID_MASTER_PROMPT.md`, `docs/FINET_MASTER_PROMPT.md` și `docs/ROADMAP.md`. Execută Faza Android X. Oprește-te la criteriile ei de acceptare și raportează conform secțiunii 16.”*

---

## 1. Misiune

Construiește **FINET Android**, aplicația mobilă oficială a sistemului FINET România.

FINET (aplicația Next.js) este sursa autoritativă pentru date, reguli de business, autentificare, autorizare, gospodării și procesarea documentelor. FINET Android este un client Flutter care comunică securizat cu backendul FINET prin API-ul versionat `/api/v1/`.

Nu transforma clientul într-un backend financiar independent. Nu duplica baza de date, regulile de calcul sau autentificarea.

Obiectivul primei versiuni: un APK funcțional, testat și instalabil pe un telefon Android, pentru varianta `personal` a FINET (familia ta, server propriu). Publicarea în Google Play vine odată cu varianta `saas`.

Numele: aplicația se numește **FINET**, cu logo-ul și culorile din secțiunea 3.4 a `docs/FINET_MASTER_PROMPT.md`. Nu folosi numele „FINpulse” nicăieri: este numele produsului de referință (finpulse.day).

## 2. Dependența de fazele FINET

Clientul nu poate depăși backendul. Fiecare fază Android are o fază FINET minimă:

| Fază Android | Ce face | Are nevoie de FINET |
|---|---|---|
| A — Fundație | Proiect Flutter, temă, navigare, client API, ecrane pe date simulate | Doar contractul `docs/openapi.json`; până există, un contract provizoriu în `mobile/test/fixtures/`, marcat ca atare |
| B — Autentificare | Login, sesiune, profil, gospodării | Faza 1 (Better Auth + plugin `bearer`) |
| C — Funcții de bază | Dashboard, conturi, tranzacții, bugete, obiective | Fazele 2 și 3 |
| D — Recurențe și documente | Recurențe, foto bon, încărcare, verificare, extrase, potriviri | Fazele 5, 6 și 7 |
| E — Stabilizare și livrare | Teste de integrare, securitate, conexiune slabă, APK semnat | Faza 9 (hardening) recomandată |

Dacă o fază FINET necesară nu e gata, Faza Android corespunzătoare nu începe. Se poate lucra doar pe ecrane cu date simulate, marcate explicit ca simulate.

## 3. Regula zero: auditul

Înainte de orice cod:

1. Verifică repository-ul FINET: branch-ul, commitul curent, `git status`.
2. Citește `CLAUDE.md`, `docs/FINET_MASTER_PROMPT.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/API.md` și `docs/openapi.json`. Pentru fiecare fișier care lipsește, notează asta; nu presupune conținutul.
3. Inspectează codul real din `src/app/api/v1/`, `src/modules/`, `src/db/`: endpointurile implementate, configurația Better Auth (inclusiv dacă pluginul `bearer` e activ), schema și migrațiile.
4. Separă ce e implementat de ce e doar planificat, pe baza `docs/ROADMAP.md` și a codului.
5. Inspectează mediul de build: Flutter, Dart, Java (JDK 17), Android SDK, spațiul pe disc. Pe containerul LXC al FINET spațiul nu ajunge (Android SDK + Flutter + Gradle depășesc 10 GB). Construiește pe alt calculator sau în GitHub Actions (secțiunea 12).
6. Verifică felul în care telefonul ajunge la server (secțiunea 11). Nu inventa domenii, tokenuri sau credențiale; cere-le operatorului.
7. Nu modifica backendul și nu instala pachete de sistem înainte de a prezenta planul.

Livrabil: `docs/FINET_ANDROID_AUDIT.md`, cu starea reală a backendului, endpointurile disponibile, ce lipsește, compatibilitatea autentificării, accesul de rețea, mediul de build, riscurile și planul fazelor.

Dacă backendul nu e accesibil, continuă cu Faza A pe date simulate, dar nu pretinde că integrarea reală funcționează.

## 4. Arhitectură

### 4.1 Backendul (neschimbat)

Aplicația Next.js FINET, cu TypeScript strict, PostgreSQL, Drizzle și Better Auth. Rămân neschimbate: modelul pe gospodărie și izolarea prin `household_id` (aplicație + RLS), serviciile de business, schema și migrațiile, procesarea documentelor (pg-boss, AI local), modurile `personal` și `saas`, `entitlements`.

Nu introduce FastAPI, Supabase, Firebase ca bază de date sau o a doua bază de date pentru comoditatea clientului.

Dacă lipsește un endpoint, el se adaugă în FINET, în `src/app/api/v1/`, apelând serviciile existente, cu validare Zod, OpenAPI actualizat și teste. Regula se schimbă în serviciu, nu în endpoint.

### 4.2 Clientul

- **Flutter** (canalul stable, versiune fixată în `mobile/.fvmrc` sau în README) și **Dart**.
- **Material 3**, cu `ColorScheme` construit din tokenii FINET (secțiunea 3.4 din promptul FINET), temă luminoasă și întunecată.
- **Riverpod** (state), **go_router** (navigare), **Dio** (HTTP, cu interceptori pentru autentificare, `Idempotency-Key` și reîncercări), **flutter_secure_storage** (tokenul de sesiune), **intl** (`ro_RO`, `Europe/Bucharest` prin pachetul `timezone`).
- Model de date: **freezed** + **json_serializable**, ideal generat din `docs/openapi.json`, ca tipurile clientului să urmeze contractul.
- Cameră și fișiere: `image_picker` sau `camera`, `file_picker`, `flutter_image_compress`. Grafice: `fl_chart`. Blocare cu amprentă: `local_auth`.
- Teste: `flutter_test`, `mocktail`, `integration_test`.

Înainte de a adăuga o dependență: versiunea stabilă curentă, licența, ultima actualizare și compatibilitatea cu restul. Motivul se notează.

Structura în repository: `mobile/` la rădăcina repo-ului FINET (proiect Flutter cu `applicationId` stabilit în audit, de exemplu `ro.finet.app`), fără să atingă structura aplicației web.

### 4.3 Comunicare

`Android (Flutter) → HTTPS → FINET /api/v1 → servicii FINET → PostgreSQL / storage / worker`

Telefonul nu se conectează niciodată direct la PostgreSQL, la fișierele serverului, la LiteLLM, la Ollama sau la vreun furnizor AI.

## 5. Contractul API mobil

Contractul e definit în FINET (secțiunea 6.4 din promptul principal) și publicat în `docs/openapi.json`. Clientul îl consumă, nu îl inventează.

Convenții (din FINET):
- prefix `/api/v1/`;
- erori `{ error: { code, message, fields? } }`;
- paginare cu cursor `{ data, nextCursor }`;
- sume `amountMinor` (întreg) plus `currency`;
- datele calendaristice `YYYY-MM-DD`, momentele în ISO 8601 UTC;
- `Idempotency-Key` pe fiecare `POST`.

Grupuri de endpointuri țintă (se confirmă în audit, nu se declară existente fără verificare):
- **Sesiune:** login, logout, sesiunea curentă, profil, gospodăriile utilizatorului.
- **Conturi și tranzacții:** conturi și solduri; tranzacții paginate și filtrate (perioadă, cont, categorie, etichetă, sumă); creare, modificare, ștergere; transferuri; categorii; etichete.
- **Dashboard și bugete:** sumarul perioadei, evoluția lunară, bugete cu starea semaforului, obiective.
- **Recurențe:** reguli, scadențe, generarea la cerere (serviciul idempotent existent).
- **Documente:** încărcare, starea procesării, rezultatul extras, corectarea liniilor, confirmarea bonului, extrase importate, sugestii de potrivire și decizia asupra lor, acoperirea extraselor.

Pentru fiecare endpoint nou: metodă, autentificare, permisiuni (rolul minim în gospodărie), schemă de intrare și ieșire, paginare, erori, teste de integrare (inclusiv acces din altă gospodărie → 404).

## 6. Autentificare și securitate mobilă

**Mecanismul:** pluginul `bearer` din Better Auth (prevăzut în Faza 1 FINET). Clientul trimite emailul și parola la endpointul Better Auth, primește tokenul de sesiune și îl trimite apoi în antetul `Authorization: Bearer …`. Sesiunea are aceeași expirare și revocare ca pe web și apare în lista de sesiuni. Dacă auditul arată că pluginul nu se potrivește versiunii instalate, propune alternativa (OAuth 2.1 + PKCE prin pluginul OIDC al Better Auth) într-un ADR și așteaptă aprobarea. Nu construi un mecanism paralel care ocolește Better Auth.

Login prin magic link pe mobil: doar după ce există deep links verificate (Android App Links pe domeniul FINET). Până atunci, parolă.

Cerințe:
- HTTPS obligatoriu în release; fără dezactivarea validării TLS; `network_security_config` care interzice traficul HTTP în release.
- Tokenul doar în `flutter_secure_storage` (Android Keystore). Niciodată în loguri, URL-uri, rapoarte de erori sau analytics.
- Fără parole, chei sau secrete în APK sau în repository. Valorile `--dart-define` nu sunt secrete.
- La 401: sesiune expirată → ecranul de login, cu datele locale șterse. La 403: mesaj clar, fără reîncercări.
- Logout: cerere de revocare către server, ștergerea tokenului și a cache-ului local, revenire la login.
- **`FLAG_SECURE`** pe ferestrele cu date financiare, ca sumele să nu apară în lista aplicațiilor recente sau în capturi de ecran.
- **Blocare opțională cu amprentă sau PIN** (`local_auth`) la deschiderea aplicației și după N minute în fundal.
- **Ascunderea sumelor** printr-un comutator în bara de sus (afișează „••••”).
- Fără date financiare în notificări.
- Fără credențiale bancare și fără acces direct la conturi bancare.

## 7. Bani și consistența datelor

Se aplică integral secțiunea 5 din `docs/FINET_MASTER_PROMPT.md`. Pe mobil, concret:

- Sumele sunt `int` în unități minore (Dart are întregi pe 64 de biți pe Android), într-o clasă `Money(amountMinor, currency)`. Niciodată `double` pentru bani.
- Parsarea sumelor introduse urmează aceleași reguli ca pe web: virgulă sau punct zecimal, „1.234” respins ca ambiguu, maximum două zecimale. Testele folosesc aceleași cazuri ca web-ul.
- Formatare: `1.234,56 lei`, date `25.10.2026`, săptămâna începe luni, perioadele în `Europe/Bucharest`.
- Monede diferite nu se adună; totalurile se afișează pe monedă.
- Transferurile nu apar ca venituri sau cheltuieli.
- Soldurile, totalurile, bugetele și împărțirile vin din backend. Clientul poate afișa o valoare provizorie imediat după o acțiune, marcată vizual și înlocuită de răspunsul serverului.
- Fiecare `POST` are un `Idempotency-Key` (UUID) generat o singură dată per acțiune și păstrat la reîncercări, ca o tranzacție sau o încărcare repetată pe semnal slab să nu se dubleze.

## 8. Faze

### Faza A — Fundație
- Proiect Flutter în `mobile/`, `applicationId`, `minSdk 26`, `targetSdk` ultima versiune cerută de Google Play.
- Temă Material 3 din tokenii FINET, logo-ul FINET ca widget, fonturile incluse în aplicație.
- go_router cu navigarea de jos: Acasă, Tranzacții, Scanează (buton central), Rapoarte, Mai mult.
- Client Dio cu interceptori (autentificare, `Idempotency-Key`, reîncercări doar pentru erori de rețea și doar pentru cereri idempotente), modelul de erori, stări de încărcare, gol și eroare.
- Configurație pe medii (`API_BASE_URL` prin `--dart-define`), verificată la pornire.
- Ecranele de bază pe date simulate, marcate „Date simulate”.
- CI: `flutter analyze`, `flutter test` și un APK de debug în GitHub Actions.
- **Acceptare:** aplicația pornește în emulator, navigarea funcționează, testele pentru `Money` și pentru parsarea sumelor trec, CI e verde.

### Faza B — Autentificare și profil
- Login cu parolă, sesiune bearer, logout cu revocare, gestionarea 401 și 403.
- Profil, lista gospodăriilor și alegerea celei active.
- Blocare cu amprentă (opțională), `FLAG_SECURE`.
- **Acceptare:** login și logout pe backendul real de test; tokenul nu apare în loguri; după logout nu mai rămân date locale; test de integrare pentru sesiune expirată.

### Faza C — Funcții de bază
- Dashboard (venituri, cheltuieli, sold net, număr de tranzacții, cheltuieli pe categorii, evoluție, garanții SGR, familie), conturi și solduri.
- Tranzacții: listă paginată, filtre, căutare, adăugare rapidă (buton vizibil), editare, ștergere cu confirmare, etichete.
- Bugete cu semafor, obiective cu progres, raport lunar.
- **Acceptare:** cifrele din aplicație sunt identice cu cele din web pentru aceeași gospodărie și perioadă (test pe date de test cunoscute); o tranzacție trimisă de două ori cu aceeași cheie apare o singură dată.

### Faza D — Recurențe și documente
- Recurențe: listă, stări, pauză și reluare, generare la cerere.
- Bon: foto din aplicație (permisiunea de cameră cerută doar atunci), comprimare înainte de încărcare (latura maximă ~2000 px, JPEG), EXIF eliminat, previzualizare, anulare, mod bon lung (2–4 poze, ordine, reordonare), încărcare cu `Idempotency-Key`, urmărirea stării, ecranul de verificare cu corectarea liniilor și categoriilor, confirmarea potrivirii cu extrasul.
- **Partajare din alte aplicații:** FINET apare în meniul „Partajează” al Android pentru imagini, PDF și CSV (de exemplu un extras exportat din aplicația băncii) și deschide direct importul.
- Extrase importate, acoperirea pe luni, sugestii de potrivire.
- **Acceptare:** un bon fotografiat ajunge la „De verificat” și, după confirmare, apare în tranzacții; același bon încărcat de două ori e recunoscut ca duplicat de server; partajarea unui PDF din altă aplicație deschide importul.

### Faza E — Stabilizare și livrare
- Comportament pe conexiune slabă: timeouturi, reîncercări sigure, mesaje clare, nicio acțiune dublată.
- Teste de integrare pentru fluxurile principale, verificare de securitate pe `docs/FINET_ANDROID_SECURITY.md`.
- Accesibilitate (TalkBack, mărimi de font, contrast), ecrane mici și mari.
- APK release semnat, verificat și instalat pe telefon.
- **Acceptare:** criteriile din secțiunea 15.

După MVP, fiecare într-o fază separată: coadă offline pentru poze (stocare locală criptată, sincronizare documentată), notificări push (fără sume în conținut), widget pe ecranul principal, publicare în Google Play (doar `saas`).

## 9. UI

În română, Material 3, temă luminoasă și întunecată, aceleași fluxuri și termeni ca în demo-ul `docs/demo/finet-demo.html`.

Ecrane: login; Acasă; Tranzacții și formularul de tranzacție; Scanează și Import; verificarea bonului; Bonuri; Rapoarte; Recurențe; Bugete și obiective; Familie; Setări și profil.

Cerințe: navigare cu degetul mare (bara de jos, butonul „Scanează” central), stări distincte de încărcare, gol, eroare și succes, confirmare la operațiunile distructive, contrast WCAG AA, etichete pentru TalkBack, suport pentru font mărit, sume formatate românește, comutator de ascundere a sumelor, nicio dată simulată afișată ca reală.

## 10. Documente și OCR

Procesarea rămâne pe serverul FINET. Telefonul doar fotografiază, pregătește, încarcă, urmărește și afișează.

- Permisiuni cerute doar la folosire; refuzul are o explicație și o alternativă (alegerea unui fișier).
- Validarea tipului și a mărimii înainte de încărcare, aceleași limite ca serverul (venite din API, nu scrise în aplicație).
- Fără OCR local în paralel cu cel de pe server.
- Telefonul nu trimite imagini către furnizori AI. Consimțământul pentru AI extern e gestionat de FINET și afișat din setările contului.
- Pozele temporare se șterg din telefon după confirmarea serverului.

## 11. Configurare, medii și rețea

- `API_BASE_URL` injectat la build (`--dart-define`), câte o valoare pentru test și pentru producție. URL-urile reale vin de la operator, nu se inventează.
- Release: doar HTTPS, fără `localhost` și fără HTTP.
- **Accesul telefonului la server în modul `personal`:** serverul LXC nu se expune pe internet. Telefonul ajunge la el printr-o rețea privată (recomandat Tailscale, sau WireGuard), cu HTTPS pe numele intern, de exemplu certificatul Tailscale sau unul emis pentru un subdomeniu. Alternativ, dacă FINET rulează pe Vercel, URL-ul public al aplicației.
- Emulator: `10.0.2.2` pentru backendul de pe calculatorul de dezvoltare, doar în build-urile de debug.
- Nicio modificare de configurare a serverului FINET fără aprobare.

## 12. Build și semnare

**Unde se construiește:** pe un calculator Debian cu cel puțin 15 GB liberi sau în GitHub Actions. Nu pe containerul LXC al FINET.

Verificări de mediu: `flutter doctor -v`, `flutter --version`, `java -version` (JDK 17), `git status`.

Ordinea comenzilor:
1. `flutter pub get`
2. `dart format --output=none --set-exit-if-changed lib test`
3. `flutter analyze`
4. `flutter test`
5. `flutter test integration_test`, dacă există un emulator sau un telefon
6. Debug: `flutter build apk --debug --dart-define=API_BASE_URL=<URL de test primit de la operator>`
7. Release: `flutter build apk --release --dart-define=API_BASE_URL=<URL de producție primit de la operator>`

**Semnare:** cheia release (`upload-keystore.jks`) se generează o singură dată, de către operator, și se păstrează în afara repository-ului, cu backup. În CI, cheia și parolele stau în GitHub Secrets. `key.properties` și `*.jks` sunt în `.gitignore`. Release-ul nu se construiește dacă URL-ul, rețeaua sau semnarea nu sunt pregătite.

**Verificarea artefactului:** există, are o mărime plauzibilă, `apksigner verify --print-certs` arată certificatul așteptat, iar `aapt dump badging` arată `applicationId` și versiunea.

**Instalare:** `adb devices`, apoi `adb install -r build/app/outputs/flutter-apk/app-release.apk`. Pentru familie, APK-ul semnat se distribuie direct (sideload), cu instrucțiuni de instalare din surse necunoscute.

## 13. Documentație

În `docs/`, fără să mute sau să redenumească documentele FINET existente:
- `FINET_ANDROID_AUDIT.md`
- `FINET_ANDROID_ARCHITECTURE.md`
- `FINET_ANDROID_SECURITY.md`
- `FINET_ANDROID_TEST_PLAN.md`
- `FINET_ANDROID_BUILD.md`

Contractul API rămâne în `docs/API.md` și `docs/openapi.json` (comune web și mobil). Deciziile importante se notează ca ADR în `docs/adr/`. `docs/ROADMAP.md` are o secțiune Android cu starea fiecărei faze.

## 14. Git și protejarea FINET

- Branch separat per fază (`feature/android-a`, …), niciodată direct pe `main`.
- `git status` înainte și după; nu suprascrie modificări locale; fără force push.
- Schimbările de backend necesare clientului se fac în PR-uri separate de cele ale clientului, cu teste de regresie pentru web.
- Nicio modificare de schemă sau migrație fără justificare scrisă.
- Munca nu e declarată livrată înainte de verificarea artefactului.

## 15. Criterii de acceptare pentru MVP

1. Aplicația pornește, navigarea funcționează.
2. Autentificarea folosește Better Auth (`bearer`), verificat pe backendul real.
3. Datele vin din backendul real; orice date simulate sunt marcate și există doar în build-urile de test.
4. Un utilizator nu poate accesa datele altei gospodării (test prin API).
5. Cifrele (tranzacții, totaluri, bugete) sunt identice cu cele din aplicația web.
6. Nicio acțiune repetată (reîncercare, dublu tap) nu dublează tranzacții, încărcări sau scadențe.
7. Release-ul folosește doar HTTPS.
8. Nu există secrete în APK sau în repository (verificat).
9. `flutter analyze` fără erori; testele clientului și testele de regresie ale backendului raportate.
10. APK-ul release e semnat și verificat.
11. Instalarea pe un telefon real e testată, sau blocajul e documentat.
12. Documentația și `docs/ROADMAP.md` sunt actualizate.

## 16. Raport la finalul fiecărei faze

1. Faza și ce s-a implementat efectiv; ce a rămas parțial sau neimplementat.
2. Deciziile și ADR-urile noi.
3. Endpointurile folosite, adăugate sau modificate.
4. Fișierele create sau modificate.
5. Comenzile rulate și rezultatele exacte, cu testele reușite, eșuate, blocate și neexecutate raportate separat.
6. Rezultatul verificărilor de securitate.
7. Calea exactă a APK-ului, mărimea și certificatul.
8. Instrucțiunile de instalare.
9. Problemele rămase și ce depinde de operator (URL-uri, rețea, cheia de semnare).

---

## Prima sarcină

Execută **doar auditul** (secțiunea 3) și livrează `docs/FINET_ANDROID_AUDIT.md` cu planul fazelor. Dacă backendul FINET nu are încă API-ul, spune-o clar și propune ordinea: Faza A pe date simulate acum, Faza B după Faza 1 FINET. Continuă cu Faza A doar dacă mediul de build e pregătit și nu există decizii arhitecturale critice nerezolvate. Oprește-te la criteriile de acceptare ale fazei și raportează rezultatele reale.
