# ADR 0028: feedback, anunțuri, monitorizarea erorilor și panoul de administrare (Faza 11-B)

- **Stare:** propus (Faza 11-B, branch `phase/11-admin`). **Migrația `0020_admin_feedback`** (3 tabele, 6 funcții). Doar modul `saas`: în `personal` toate rutele și paginile răspund 404; nu schimbă nimic pe producția personală (migrația se aplică totuși pe Supabase doar la acordul operatorului, ca orice migrație; tabelele rămân goale).
- **Legături:** master prompt Faza 11 (feedback și bug-uri din aplicație fără date financiare, anunțuri de la administrator, panou de administrare cu acțiuni auditate, monitorizarea erorilor; acceptare: rutele de admin dau 404 pentru non-administratori și în `personal`); ADR 0021 (statistici, `is_platform_admin`), 0027 (site-ul public).
- **Decizia operatorului (2026-10-31):** monitorizarea erorilor e INTERNĂ (tabel + panou), fără Sentry/GlitchTip.

## Decizii

### 1. Date: trei tabele mici, nicio dată financiară

- **`feedback`** (utilizator, tip `feedback|bug`, mesaj 3–2000, ruta paginii, versiune, stare `new|seen|closed`). RLS ENABLE + FORCE: autorul își vede rândurile, administratorul pe toate; INSERT doar pentru sine și doar cu `status = 'new'`; UPDATE (doar coloana `status`) doar administratorul. Se șterge odată cu contul (`ON DELETE CASCADE`: textul liber poate conține date personale).
- **`announcements`** (titlu ≤ 100, text ≤ 500, nivel `info|warn`, perioadă, arhivat). Orice utilizator autentificat vede cele active (nearhivate, începute, neexpirate); administratorul vede și scrie pe toate.
- **`app_errors`** (amprentă, tip `client|server`, RUTA ca formă, un COD, digest, versiune, contor, prima/ultima apariție). Fără mesaje, fără stive, fără date: rutele devin `/transactions/[id]`, codul e numele erorii. Citit doar de administrator; scris doar prin `finet.record_app_error` (SECURITY DEFINER, `search_path = pg_catalog`, doar identificatori), care ignoră valorile invalide fără să arunce și păstrează cel mult 500 de erori distincte.
- CHECK-uri PLATE; migrația generată de drizzle-kit (DDL) plus partea scrisă de mână (RLS, drepturi, funcții). `finet.is_platform_admin()` (SECURITY DEFINER, stabilă) e folosită în politici și în funcții.

### 2. Panoul de administrare nu vede date financiare

Listele vin din funcții SECURITY DEFINER care verifică administratorul (`42501` altfel) și întorc doar coloane nefinanciare: `admin_users` (id, email, nume, stare, administrator, creat, nr. de gospodării), `admin_households` (id, nume, nr. de membri, creat), `admin_jobs` (numele cozii, starea, contorul din `pgboss.job`; fără conținut), pagini de cel mult 200. `admin_set_user_status` activează/dezactivează un cont (nu pe al administratorului însuși); un cont dezactivat nu mai are sesiune validă (regulă existentă).

### 3. 404 uniform, nu 403

Toate rutele noi (inclusiv feedback, anunțuri și raportarea erorilor) există doar în `saas`: în `personal` → 404. Rutele `/admin/*` și pagina `/admin` răspund 404 și utilizatorilor care nu sunt administratori (verificarea e prima operație a serviciului), deci panoul nu se dezvăluie. `GET /api/v1/admin/stats` (Faza 9) rămâne cum era (403 pentru non-administratori, funcționează și în `personal`): neschimbat aici ca să nu se strice clienții existenți; de aliniat într-o fază viitoare.

### 4. Audit

Acțiunile de schimbare (starea unui cont, starea unui feedback, crearea și modificarea unui anunț) se scriu în `audit_events` în gospodăria CURENTĂ a administratorului (tabelul e pe gospodărie), doar cu id-ul țintei și starea nouă, fără conținut. Dacă administratorul nu are gospodărie, evenimentul se omite. Limită cunoscută: membrii acelei gospodării pot vedea evenimentul (metadate minime).

### 5. Interfață

`/feedback` (formular, doar `saas`), bannerul de anunțuri și legătura „Trimite feedback” în layout-ul aplicației (doar `saas`, doar cu sesiune), pagina `/admin` (feedback cu schimbarea stării, anunțuri cu creare/arhivare, utilizatori cu activare/dezactivare, gospodării, cozi, erori). Erorile interfeței se raportează din `error.tsx`/`global-error.tsx` (rută generalizată, numele erorii, digest), fire-and-forget; în `personal` cererea primește 404 și se ignoră.

### 6. Ce NU face

Nu trimite nimic în afara aplicației; nu stochează mesajele erorilor sau stivele; nu adaugă roluri (administrator vs. utilizator rămâne `users.is_platform_admin`, setat prin CLI); nu raportează erorile serverului automat (ruta există; cablarea handlerelor 500 e amânată); erorile paginilor publice (fără sesiune) nu se raportează (ruta cere sesiune).

## Consecințe

- Aplicarea pe producție (doar dacă se dorește tabelele goale în Supabase): backup, migrația `0020`, redeploy `finet-web`; fără variabile noi.
- Rollback: antetul fișierului `0020`, manual, cu backup.
