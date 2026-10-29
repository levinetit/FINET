# ADR 0021: export și ștergere GDPR, retenția evenimentelor, statistici, upgrade PostgreSQL

- **Stare:** propus (F9-B, branch `phase/09-hardening`). Deploy-ul îl face operatorul, după revizuiri (`docs/INFRA.md`, „4m”).
- **Legături:** master prompt 5.6 (ștergere), 6.3 („GDPR”), 6.5 (statistici, retenție), 3.5 (upgrade PostgreSQL), Faza 9 (acceptarea); ADR 0003 (M5: fără DELETE pe `users`, bootstrap-ul irepetabil al administratorului), 0013 (storage, chei de documente), 0016–0017 (familie: personal/comun, ultimul owner, istoric), 0020 (coada offline). ADR 0018–0019 sunt ale Fazei 7.
- **Migrația:** `0016_gdpr_stats` (numerele 0013–0015 sunt rezervate Fazei 7; `when` 1794600000000; jurnalul se reconciliază la merge).

## Context

Faza 9 cere exportul complet și ștergerea contului, retenția evenimentelor (13 luni → agregat), pagina „Statistici” pentru administrator, fără date financiare, și procedura de upgrade major PostgreSQL, încercată pe versiunea următoare. Constrângeri existente:

- `finet_app` nu are DELETE pe `users` (M5).
- `transaction_splits.payer_user_id`/`user_id` și `settlements.from_user_id`/`to_user_id` sunt `ON DELETE NO ACTION` (istoricul celorlalți membri).
- `accounts.owner_user_id ON DELETE SET NULL` ar transforma un cont PERSONAL în cont COMUN, adică o scurgere spre ceilalți membri.
- Conturile personale ale unui membru plecat rămân în gospodărie, invizibile pentru toți (ADR 0016).
- Protecția ultimului owner (L3) e impusă și de un trigger.
- Sub FORCE RLS, proprietarul (`finet_migrator`) nu vede nimic în afara politicilor dedicate.

## Decizii

### 1. Ștergerea contului (`POST /api/v1/me/delete`, `GET /api/v1/me/deletion`)

- **Reautentificare:** parola curentă (Argon2, în afara tranzacției) și confirmarea scrisă `ȘTERGE` (Zod strict). Un cont fără parolă (doar magic link) cere o sesiune creată în ultimele 15 minute (403 `reauth_required`). Limită proprie de rată (aceeași regulă ca schimbarea parolei). CSRF ca orice mutație cu cookie.
- **Fără fereastră de grație** (decizia mea): ștergerea e imediată și ireversibilă. Datele nu rămân „pe jumătate șterse” 30 de zile, iar UI-ul oferă exportul chiar deasupra. O fereastră de grație ar cere un job programat și o stare nouă pe `users`; se poate adăuga în `saas`.
- **Previzualizarea** (`GET /api/v1/me/deletion`), fără sume, arată:
  - gospodăriile care se șterg (e singurul membru);
  - cele din care iese (`unsettled`: are solduri nedecontate);
  - cele care blochează ștergerea (e ultimul owner și mai există alți membri);
  - `platformAdmin`.
- **Ultimul owner** cu alți membri: 409 `last_owner`, până transferă rolul (regula L3; triggerul `household_members_guard_owner` o impune oricum). **Administratorul platformei**: 409 `platform_admin`, cu gardă și în funcția din bază. Bootstrap-ul e irepetabil (M5), deci platforma ar rămâne fără administrator; operatorul îl înlocuiește întâi.
- **Gospodăria în care e singurul membru** se șterge cu tot conținutul (cascada din bază; politica `households_delete` a owner-ului). Cheile fișierelor se citesc în tranzacție, iar fișierele se șterg din storage DUPĂ commit, doar cheile acelei gospodării (`isKeyOfHousehold`).
- **Gospodăriile cu alți membri:** iese din ele ca la „Părăsește gospodăria”. Invitațiile create de el se revocă. Plecarea se auditează fără conținut (`household.member_left`, `accountDeleted: true`, `unsettled`), ÎNAINTE de ieșire. Soldurile nedecontate NU blochează (regula F8, M2).
- **Datele fără gospodărie** (sub RLS-ul lui):
  - se șterg evenimentele de utilizare (6.5: „se șterg sau se anonimizează”: aici se șterg), instalările, preferințele, sesiunile și conturile de autentificare (hash-ul parolei);
  - consimțămintele se revocă (și dispar odată cu rândul, dacă acesta se șterge).
- **Pasul final** `finet.erase_current_user()` (SECURITY DEFINER, `search_path = pg_catalog`, EXECUTE doar `finet_app`, întoarce doar `deleted`/`anonymized`/`not_found`). Garda: utilizatorul din context, fără nicio apartenență rămasă, nu e administrator. Apoi, în TOATE gospodăriile (inclusiv cele părăsite demult):
  1. jumătatea COMUNĂ a unui transfer personal ↔ comun devine o tranzacție obișnuită (`in` → venit, `out` → cheltuială, fără categorie), deci soldul contului comun rămâne neschimbat;
  2. tranzacțiile din conturile lui personale se șterg (cascadă: etichetele și împărțirile lor; ocurențele recurente și bonurile își pierd doar legătura);
  3. conturile lui personale se șterg (cascadă: regulile recurente; obiectivele își pierd contul), bugetele personale se șterg, descărcările devin anonime;
  4. rândul `users` se șterge. Dacă e referit de împărțiri sau decontări din istoricul altora, se **anonimizează**: nume „Cont șters”, email `deleted-<id>@deleted.invalid`, `status = disabled`, fără imagine. Nu se poate autentifica (sesiunile și parola au dispărut, contul e dezactivat), iar emailul real devine liber.
  - **Conturile personale nu devin niciodată comune:** la momentul în care `SET NULL` s-ar putea aplica, nu mai există niciunul.
- **Efecte acceptate (documentate în UI):**
  - Împărțirile cheltuielilor plătite din conturile lui personale dispar odată cu cheltuielile, deci datoriile altora față de el dispar.
  - Restul împărțirilor și decontărilor rămân în istoricul celorlalți, sub „Cont șters”.
  - Documentele încărcate de el într-o gospodărie comună rămân ale gospodăriei (erau deja vizibile tuturor membrilor), cu `uploaded_by` păstrat ca id anonim.
- **Limita încercărilor (revizuirea F9):** două limite de rată: pe IP de încredere + utilizator (regula schimbării parolei) și DOAR pe utilizator (5 pe oră, `accountDelete`), ca ghicirea parolei dintr-o sesiune furată să nu se poată împărți pe mai multe IP-uri.
- **Atomicitate și idempotență:** totul într-o singură tranzacție, cu lock pe utilizator. O eroare nu lasă nimic șters pe jumătate. După succes, sesiunea nu mai există (401), iar funcția întoarce `not_found`. Better Auth `deleteUser` nu e activat, deci nu există o a doua cale, nepăzită.
- **Fișierele rămase pe disc fără rând în bază** (ștergerea lor eșuează după commit): eșecul se numără în log, fără id-uri sau chei (`[gdpr] cont șters; … fișiere=N eșuate=M`); datele din bază NU revin. Fișierele orfane stau sub `households/<id gospodărie ștearsă>/` și nu sunt servite de nicio rută (fără rând nu există autorizare). Curățarea (revizuirea F9): `finet-admin cleanup-orphan-storage` — găsește directoarele `households/<uuid>/` fără gospodărie în bază (funcția `finet.existing_households(uuid[])`, SECURITY DEFINER, doar id-uri, cel mult 1000 pe apel), implicit DOAR raportează (dry-run), șterge doar cu `--yes`, plafonat (`--limit`, implicit 100, max. 1000), ignoră legăturile simbolice și numele ne-uuid, nu atinge nimic fără `STORAGE_DIR` montat sau fără `households/`, și refuză dacă NICIUN director nu are gospodărie (baza greșită). Rulare: INFRA 4m, pasul 5.
- **Coada offline (ADR 0020):** după ștergere, UI-ul golește IndexedDB (`clearOfflineScans`) și merge la login.

### 2. Exportul (`GET /api/v1/me/export`)

- **Arhivă ZIP în flux** (`src/lib/zip.ts`, fără dependență nouă): antet local cu descriptor după date, UTF-8, `deflate` pentru JSON/CSV și `store` pentru poze. Fără ZIP64 (sub 4 GiB și 65 535 de intrări, cu mult peste cota unei gospodării). Verificat independent cu Python `zipfile` și `unzip -t`. Tabelele mari se citesc pe pagini; pozele se copiază în flux din storage.
- **Conținut:**
  - `README.txt`;
  - `profil.json`: profilul, preferințele, consimțămintele, sesiunile (fără token), metodele de autentificare (fără parolă), instalările, evenimentele;
  - pe fiecare gospodărie: gospodăria (membrii doar cu id și rol, fără numele altora), conturi, categorii, etichete, tranzacții (JSON și CSV, prin exportul existent, protejat contra formula injection), etichetele tranzacțiilor, bugete, obiective, recurențe, bonurile LUI (documente fără cheia de storage, bonuri, linii), împărțirile și decontările în care e parte, acțiunile lui din audit, fișierele bonurilor lui.
- **Vizibilitatea:** fiecare interogare rulează ca `finet_app`, sub RLS-ul utilizatorului, gospodărie cu gospodărie, deci conturile personale ale altora (și tot ce derivă din ele) nu apar. Filtrele explicite de mai sus se adaugă peste RLS.
- **Excluse:** tokenuri, hash-uri (parolă, invitații), chei `Idempotency-Key`, chei de storage, jurnalul AI.
- **Limita arhivei (revizuirea F9):** fără ZIP64, arhiva are cel mult 4 GiB și 65 535 de intrări. ÎNAINTE de flux, serverul estimează arhiva (`estimateExport`, sub același RLS: dimensiunea fișierelor bonurilor lui din `documents.size_bytes`, 4 KiB pe tranzacție vizibilă pentru JSON + CSV, o rezervă de 64 MiB, 2 + 14 intrări pe gospodărie + câte una pe fișier) și răspunde `413 export_too_large` (JSON, cod fix) dacă depășește, în loc să întrerupă fluxul la jumătate. Un export de acest ordin (peste ~4 GiB de poze ale unui singur utilizator) îl face operatorul, din backup. Estimarea supraestimează textul; o depășire reală la mijloc rămâne posibilă doar teoretic (fluxul se oprește cu eroare, fără arhivă validă).
- **Limite:** 3 exporturi pe oră per utilizator. Cu cookie, doar `Sec-Fetch-Site: same-origin|none` (ca exporturile CSV, LOW-2 din Faza 3). Nume de fișier fix (`finet-export.zip`). Auditat fără conținut (`user.data_exported`, numărul de gospodării). Exportul nu e un instantaneu atomic; fiecare secțiune e consistentă în sine.

### 3. Retenția `app_events` (LOW-2)

- Tabelul nou `app_event_daily`: zi locală, nume, platformă (din instalare, altfel `unknown`), versiune, ecran, cod de eroare, număr. Fără utilizator, instalare sau gospodărie. RLS ENABLE și FORCE, NICIUN drept pentru `finet_app`.
- `finet.aggregate_app_events(limit)`: evenimentele mai vechi de 13 luni se agregă și se șterg, în loturi, serializat. Politica de DELETE a proprietarului e limitată tot la „mai vechi de 13 luni”. Comanda `finet-admin aggregate-events` scrie doar numărul (cron zilnic, INFRA 4m).

### 4. Statistici (`GET /api/v1/admin/stats`, `/settings/statistics`)

- **Acces:** doar `users.is_platform_admin` activ, verificat în `finet.usage_stats` (42501 → 403; pagina dă 404 altcuiva).
- **Conținutul** (din `client_installations`, sesiuni, login-urile auditate, `app_events`, `app_event_daily`, `app_downloads`, `ai_calls`): utilizatori activi pe zi, săptămână și lună pe platformă și din sesiuni; instalări pe versiune, cu `belowMinimum`/`outdated` față de ultima versiune Android (ADR 0020); descărcări; login-uri pe zi; evenimente și ecrane; erori pe versiune; AI pe furnizor și rezultat; costul AI lunar (costul de operare al platformei, nu o dată a utilizatorilor); evenimentele arhivate. În `personal`: lista membrilor cu ultima activitate, platforma și versiunea (6.5); în `saas`: `null`.
- **Nicio sumă, descriere sau comerciant al utilizatorilor:** funcția nu citește conturi, tranzacții, bonuri sau documente (testat cu o sumă și un text-santinelă).
- **Nedisponibile acum:**
  - eșecurile de autentificare agregate (nu se înregistrează; există doar limitarea ratei);
  - descărcările de pe GitHub (fără acces la API-ul GitHub; decizia operatorului).
  - Pagina le marchează ca nedisponibile.

### 5. Politicile proprietarului legate de `finet.definer_scope`

Ca în 0012: fiecare politică nouă e `TO finet_migrator` și cere variabila tranzacției setată numai de funcțiile de mai sus (`erase_user`, `events_retention`, `usage_stats`), resetată la ieșire. O variabilă setată de `finet_app` nu deschide nimic (politicile nu se aplică rolului aplicației; testat). O politică pe `transactions` nu poate interoga `transactions`, de aceea vizibilitatea la ștergere e „rânduri de transfer + gospodăriile cu conturi personale ale utilizatorului”. Postgres verifică rândul nou al unui UPDATE și față de politica SELECT.

### 6. Upgrade-ul major PostgreSQL (3.5)

- `ops/postgres/upgrade-test.sh`: dump în formatul backup-ului propriu (`pg_dump --format=custom`, schemele `finet` și `pgboss`) de pe versiunea curentă → roluri și scheme goale pe versiunea următoare → `pg_restore` ca `finet_migrator`, într-o tranzacție. Amprenta trebuie să fie identică:
  - tabele, rânduri și conținut;
  - RLS ENABLE/FORCE, politici, funcții (sursă, `SECURITY DEFINER`, `search_path`, ACL);
  - triggere, constrângeri și coloane, cu ACL-ul efectiv (`acldefault`);
  - valorile de control „numărul și suma tranzacțiilor pe gospodărie și monedă”.
  - Apoi `finet_app` rămâne supus RLS, migrațiile dau „aplicate acum 0”, iar testele rulează pe serverul nou.
- Date de control fictive: `ops/postgres/upgrade-seed.sql`. Workflow săptămânal: `.github/workflows/pg-next.yml` (testele pe `VERSION+1` + încercarea).
- **Constatări la încercarea 17 → 18:** PostgreSQL 18 păstrează NOT NULL ca rânduri în `pg_constraint` (`contype = 'n'`), iar `pg_dump` omite un ACL egal cu implicitul. Ambele diferențe sunt de catalog, nu de date sau de drepturi, și sunt normalizate în amprentă. Rezultatul: `docs/reports/faza-9.md` (F9-B).
- `ops/postgres/VERSION` NU se schimbă: CI urmărește versiunea proiectului Supabase. Pasul de după upgrade-ul real e al operatorului (INFRA §7). Imaginea de backup are nevoie de `postgresql<N>-client` de cel puțin versiunea serverului.

### 7. Auditul (accesibilitate, securitate)

- **Accesibilitate:** `axe-core` 4.14.0 devine dependență directă de dezvoltare. Exista deja în arbore, tranzitiv, deci nu se descarcă cod nou. Proiectul E2E `a11y` îl injectează cu `page.evaluate` (prin protocolul DevTools; un `<script>` adăugat ar fi refuzat de CSP, corect). Criteriul: zero încălcări WCAG 2.1 A/AA `serious`/`critical` pe paginile principale; cele minore apar în log.
- **Lighthouse ≥ 90:** NU rulează în CI (ar cere `lighthouse` și Chrome pe serverul de producție din spatele Access). Ținta și metoda manuală sunt în raport.
- **Securitate:** `docs/SECURITY_CHECKLIST.md`, secțiunea 22 (parcurgerea, dovezile, punctele deschise).
- **HSTS `preload`:** NU se activează (decizia operatorului). Consecințele sunt în lista de verificare.

### 8. Constatări informative ale revizuirii de securitate F9

Revizuirea de securitate a Fazei 9 (d68e17e) nu a găsit nimic critic, mare sau mediu. Au fost reparate: limita pe utilizator la ștergerea contului (§1), verificarea dimensiunii arhivei înaintea exportului (§2), comanda pentru fișierele orfane (§1). Punctul informativ al revizuirii (al patrulea) rămâne neschimbat, ca observație documentată. Textul lui nu a ajuns la programmer; coordonatorul îl completează aici.

## Consecințe

- **O migrație nouă (`0016`).** Nicio variabilă de mediu nouă și niciun secret nou.
- **O dependență de dezvoltare directă (`axe-core`):** exista deja în arbore, licență MPL-2.0, fără scripturi de instalare.
- **Rute noi:**
  - pagini: `/settings/privacy`, `/settings/statistics`;
  - API: `GET /api/v1/me/export`, `GET /api/v1/me/deletion`, `POST /api/v1/me/delete`, `GET /api/v1/admin/stats`.
  - Toate trec prin Cloudflare Access, fără excepții.
- **Comenzi noi:** `finet-admin aggregate-events` (cron zilnic, operatorul) și `finet-admin cleanup-orphan-storage` (manual sau săptămânal, dry-run implicit).
- **Rollback:** cel din antetul `0016_gdpr_stats.sql`. După rollback, ștergerea contului, statisticile și retenția nu mai funcționează. Exportul funcționează în continuare, fiindcă nu depinde de 0016.
