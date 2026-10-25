# FINpulse România — MASTER PROMPT pentru Claude Code (v2)

> **Cum se folosește acest document**
> - Secțiunile 1–6 sunt **reguli permanente**: se aplică în fiecare sesiune. Copiază-le în `CLAUDE.md` la rădăcina repository-ului, ca să fie încărcate automat.
> - Secțiunea 7 descrie **fazele**. Rulează **o singură fază per sesiune**, pe un branch dedicat (`phase/NN-nume`), cu PR și revizuire umană înainte de faza următoare.
> - Prompt de pornire per sesiune: *„Citește `docs/FINPULSE_MASTER_PROMPT.md` și `docs/ROADMAP.md`. Execută Faza N. Oprește-te la criteriile ei de acceptare și raportează conform secțiunii 8.”*

---

## 1. Misiune

Acționează ca arhitect software senior, dezvoltator full-stack, specialist în securitate și DevOps. Construiește **FINpulse România** (nume de lucru — vezi riscul de branding din secțiunea 9): o aplicație web PWA de finanțe **personale și de familie**, cu interfață în română și RON ca monedă implicită, proiectată de la început pentru mai mulți membri pe aceeași gospodărie și pentru extindere ulterioară către SaaS.

Referința de categorie este finpulse.day. Inspiră-te din **funcționalități**, nu copia branding, logo, texte, culori distinctive sau cod.

## 2. Analiza produsului de referință (finpulse.day)

Verificat la 2026-10-25 din fișierele publice (`manifest.json`, `robots.txt`, `sitemap.xml`, `sw.js`) și din textul indexat al paginii principale. Aplicația după autentificare nu a putut fi inspectată; ce urmează este o descriere, nu o specificație de copiat.

| Aspect | Ce oferă finpulse.day | Decizia pentru FINpulse România |
|---|---|---|
| Poziționare | „Smart Personal & Family Financial Manager”, interfață în română | Identic ca segment; diferențiere prin specific RO (CUI, TVA, bănci RO) |
| Bonuri | Poză cu camera, Vision AI extrage produsele, bonuri lungi din 2–4 poze cu eliminarea duplicatelor | Faza 9 (după MVP), cu limite de cost și consimțământ |
| Extrase | Import PDF, Excel, CSV și ZIP cu mai multe fișiere | CSV/Excel în Faza 8, PDF/ZIP în Faza 10 |
| Familie | Spațiu comun, bugete comune și individuale, decontare automată 50/50, solduri reciproce, până la 6 membri | **Modelul de date pe gospodărie din Faza 1**; funcțiile de familie în Faza 6 |
| Module | Dashboard și bugete, bonuri și OCR, liste de cumpărături cu reconciliere, recurențe, obiective, rapoarte, import/export, setări, admin | MVP: dashboard, bugete, recurențe, rapoarte și export. Restul după MVP |
| Rute publice | `/`, `/pricing`, `/help`, `/terms`, `/privacy`, `/login`, `/join` (invitație sau recomandare) | Același set; `/join/[token]` pentru invitații în gospodărie |
| Platformă | PWA (standalone, portrait, `start_url: /dashboard`), temă închisă, service worker network-first care nu interceptează `/api/` | PWA în Faza 5; service worker-ul **nu pune în cache răspunsurile API cu date financiare** |
| Backend | Supabase (din `sw.js`) | Postgres self-hosted pe VPS (vezi secțiunea 3) |
| Planuri | Starter gratuit (2 bugete, 2 obiective, scanare de bază); Pro 4,99 €/lună (50 bonuri pe zi, extrase, nelimitat, export PDF/Excel); Family 8,99 €/lună (6 membri, 250 bonuri pe zi, decontări); recomandare = 30 de zile Pro | Faza 12. În MVP nu există plăți și nici limitări de plan |

## 3. Stack tehnic (decis — nu îl schimba fără un motiv tehnic documentat în `docs/adr/`)

- **Aplicație:** Next.js 15 (App Router) + TypeScript în mod `strict`. Monolit modular: un singur proiect, cu module separate pe domenii.
- **UI:** Tailwind CSS + shadcn/ui, grafice cu Recharts, iconițe lucide-react. Temă luminoasă și închisă.
- **Baza de date:** PostgreSQL 16, Drizzle ORM și migrații Drizzle Kit, versionate în repository.
- **Autentificare:** Better Auth cu email și parolă (hash Argon2id), sesiuni stocate în baza de date (expirabile și revocabile), verificare email, resetare parolă. Google OAuth este opțional, după MVP.
- **Validare:** Zod, cu aceleași scheme pe client și pe server.
- **Joburi programate:** pg-boss (coadă peste Postgres, fără Redis), rulat într-un proces worker separat din același cod.
- **Email:** SMTP prin Nodemailer. În dezvoltare, Mailpit în docker compose.
- **Teste:** Vitest pentru unit și integrare (pe un Postgres real în container), Playwright pentru E2E.
- **Calitate:** ESLint, Prettier, `tsc --noEmit`, plus GitHub Actions (lint, type-check, teste, build) pe fiecare PR.
- **Deploy:** Docker Compose pe VPS, cu Caddy ca reverse proxy (TLS automat).
- **Manager de pachete:** pnpm, cu versiunea de Node fixată în `.nvmrc` și în `package.json#engines`.

Structura recomandată:

```
src/
  app/                 # rute Next.js (UI + route handlers subțiri)
  modules/
    auth/ households/ accounts/ categories/ transactions/
    budgets/ recurring/ reports/ audit/
      *.schema.ts      # Zod
      *.service.ts     # logică de business (fără Next.js)
      *.repo.ts        # acces la date (Drizzle)
      *.test.ts
  lib/money.ts         # aritmetică monetară, formatare RON
  lib/authz.ts         # requireMember(householdId, role)
  db/schema.ts, db/migrations/
  worker/              # joburi pg-boss
```

Logica financiară stă în `modules/*/*.service.ts`, fără importuri din Next.js, ca să poată fi testată izolat.

## 4. Reguli de execuție

1. La începutul fiecărei sesiuni, inspectează starea Git, structura repository-ului, `docs/ROADMAP.md` și testele existente. Repository-ul este sursa de adevăr.
2. Lucrează pe branch-ul fazei, cu commit-uri mici și mesaje clare. Nu face push direct pe `main`.
3. Prezintă un plan scurt pentru faza curentă, apoi implementează. Oprește-te la sfârșitul fazei; nu începe faza următoare.
4. Rulează lint, type-check, teste și build după fiecare pas semnificativ. **Nu pretinde că ai rulat verificări pe care nu le-ai executat.** Raportează ieșirea exactă a eșecurilor.
5. Nu șterge date sau configurații și nu face operațiuni distructive (drop, reset, force push) fără aprobare explicită.
6. Nu introduce secrete în cod, loguri, commit-uri sau documentație. Folosește variabile de mediu și un `.env.example` cu valori fictive.
7. Fixează versiunile dependențelor (lockfile commis). Nu adăuga o dependență nouă fără să notezi motivul.
8. Notează ipotezele, riscurile, fișierele modificate și rezultatele în raportul fazei și în `docs/ROADMAP.md`.
9. Dacă o cerință din acest document e ambiguă sau intră în conflict cu codul existent, alege varianta mai sigură, documenteaz-o într-un ADR (`docs/adr/NNNN-titlu.md`) și semnalează-o în raport.

## 5. Reguli de domeniu (obligatorii)

### 5.1 Bani
- Sumele se stochează ca **`bigint` în unități minore** (bani: 1 RON = 100 bani) în coloana `amount_minor`, împreună cu `currency` (ISO 4217). Niciodată float, niciodată `number` pentru calcule intermediare cu zecimale.
- Toată aritmetica trece prin `lib/money.ts`. Împărțirile (de exemplu 50/50 sau procente) folosesc metoda **restului cel mai mare**, ca suma părților să fie exact totalul.
- `amount_minor` este întotdeauna **pozitiv**; semnul rezultă din `type` (`income`, `expense`, `transfer`). Constrângere CHECK în baza de date.
- **Monede multiple în MVP:** RON implicit, plus EUR și USD permise pe cont. Dashboard-ul afișează totalurile **separat pe monedă**; nu face conversii. Conversia cu cursul BNR vine după MVP.
- **Transfer între conturi:** două rânduri `transfer` legate prin `transfer_group_id`, create atomic într-o singură tranzacție DB. Nu se contează ca venit sau cheltuială. Între monede diferite se cer explicit ambele sume.

### 5.2 Date și timp
- Fusul orar implicit este `Europe/Bucharest`. `occurred_on` este de tip `date` (zi calendaristică locală), iar `created_at` și `updated_at` sunt `timestamptz` în UTC.
- Perioadele (luna, săptămâna) se calculează în fusul orar al gospodăriei. Săptămâna începe luni.

### 5.3 Formatare românească
- Sume: `1.234,56 lei` (`Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' })`). Date: `25.10.2026`.
- Inputurile de sumă acceptă atât virgula, cât și punctul ca separator zecimal și resping valorile ambigue.
- Interfața are diacritice corecte (ș și ț cu virgulă, nu cu sedilă).
- Exportul CSV este UTF-8 cu BOM, separator `;` și zecimale cu virgulă, ca să se deschidă corect în Excel cu setări românești. Valorile sunt protejate împotriva CSV injection (prefixează `=`, `+`, `-`, `@`).

### 5.4 Categorii implicite (sistem, traductibile, nu se pot șterge, dar se pot ascunde)
- **Cheltuieli:** Alimente, Restaurante și cafenele, Locuință (chirie/rată), Utilități (curent, gaz, apă), Internet și telefonie, Transport și combustibil, Sănătate și farmacie, Îmbrăcăminte și încălțăminte, Copii, Educație, Divertisment, Abonamente, Cadouri și donații, Taxe și impozite, Asigurări, Casă și întreținere, Animale de companie, Altele.
- **Venituri:** Salariu, Freelance/PFA, Chirii încasate, Dobânzi și dividende, Rambursări, Cadouri primite, Alte venituri.

### 5.5 Ștergere
- **Conturile** cu tranzacții se arhivează (`archived_at`); doar conturile goale se pot șterge.
- **Tranzacțiile** se șterg definitiv, cu confirmare în interfață și un `audit_event` fără sume.
- **Categoriile personalizate** folosite se pot șterge numai cu reasignarea tranzacțiilor.
- **Ștergerea contului de utilizator** cere reconfirmarea parolei. Dacă utilizatorul este singurul membru, gospodăria lui și toate datele ei se șterg.

## 6. Arhitectură, date și securitate

### 6.1 Proprietatea datelor: gospodăria (household)
Toate datele financiare aparțin unei **gospodării**, nu direct unui utilizator. Fiecare utilizator primește automat o gospodărie personală la înregistrare. Astfel funcțiile de familie (Faza 6) nu cer o refactorizare a schemei.

Entități (în MVP):
- `users`: id, email unic normalizat (lowercase, trim), name, email_verified_at, status, timestamps. Tabelele de sesiune și cont sunt cele cerute de Better Auth.
- `user_preferences`: user_id, locale (`ro-RO`), timezone, default_currency (`RON`), theme.
- `households`: id, name, default_currency, timezone, created_by, timestamps.
- `household_members`: household_id, user_id, role (`owner`, `member`), joined_at. Cheie unică pe (household_id, user_id).
- `accounts`: household_id, owner_user_id nullable (cont personal sau comun), name, type (`cash`, `bank`, `savings`, `credit_card`), currency, opening_balance_minor, archived_at.
- `categories`: household_id nullable (NULL = categorie de sistem), name, kind (`income`, `expense`), icon, color, hidden.
- `transactions`: household_id, account_id, category_id nullable, created_by_user_id, type, amount_minor, currency, occurred_on, description, merchant, notes, transfer_group_id nullable, recurring_rule_id nullable, timestamps.
- `budgets`: household_id, category_id, period (`monthly`), amount_minor, currency, alert_threshold_pct (implicit 80), scope (`household`, `personal`), user_id nullable.
- `recurring_rules`: household_id, account_id, category_id, type, amount_minor, currency, frequency (`daily`, `weekly`, `monthly`, `yearly`), interval, day_of_month, next_run_on, end_on nullable, active.
- `recurring_occurrences`: rule_id, occurrence_date, transaction_id. **Cheie unică pe (rule_id, occurrence_date)**: aceasta este garanția de idempotență.
- `audit_events`: household_id, actor_user_id, action, target_type, target_id, created_at, metadata minimă (fără sume, descrieri sau date personale).

Cerințe:
- Chei străine cu reguli explicite `ON DELETE`, constrângeri CHECK (sume pozitive, enum-uri), indecși pe `(household_id, occurred_on DESC)`, `(account_id)` și `(category_id)`.
- Soldul curent al unui cont se **calculează** (sold inițial + tranzacții). Nu se stochează denormalizat în MVP.
- Paginarea folosește cursor pe `(occurred_on, id)`, nu offset.

### 6.2 Autorizare
- Fiecare acces la date trece prin `requireMember(householdId, minRole)` pe server. `household_id` se ia din sesiune sau din ruta validată împotriva membership-ului, **niciodată din body fără verificare**.
- Fiecare query din `*.repo.ts` filtrează explicit după `household_id`. Testele de integrare verifică izolarea (utilizatorul A primește 404 la resursele gospodăriei B, nu 403, ca să nu se dezvăluie existența lor).

### 6.3 Securitate (OWASP ASVS nivel 2 ca referință)
- Argon2id pentru parole, minimum 10 caractere, verificare opțională împotriva parolelor compromise (k-anonymity HIBP).
- Cookie-uri `Secure`, `HttpOnly`, `SameSite=Lax`. Protecție CSRF pentru mutații (verificarea originii pentru route handlers și server actions).
- Rate limiting (tabel în Postgres sau in-memory pe instanța unică) pentru login, înregistrare, resetare parolă și invitații.
- Antete: CSP strictă, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. CORS închis (aceeași origine).
- Mesaje de eroare uniforme, fără stack trace în producție. Loguri structurate (pino) **fără** sume, descrieri, emailuri complete sau tokenuri.
- Nicio dată sensibilă în URL, analytics sau rapoartele de erori. Fără credențiale bancare și fără numere complete de card.
- `pnpm audit` în CI, plus Dependabot sau Renovate.
- GDPR: export complet al datelor utilizatorului (JSON + CSV), ștergerea contului, politica de retenție documentată în `docs/PRIVACY_NOTES.md`.
- Aplicația nu se prezintă drept consultant financiar autorizat (mențiune în footer și în termeni).

### 6.4 API și UX
- Mutațiile trec prin server actions sau route handlers care apelează serviciile din module. Erorile au format uniform `{ error: { code, message, fields? } }` și coduri HTTP corecte.
- Documentează în `docs/API.md` doar endpoint-urile care există.
- Interfața: responsivă mobile-first (navigare jos pe mobil), accesibilitate WCAG 2.1 AA de bază (etichete, focus vizibil, contrast), stări de încărcare, eroare și gol, confirmări pentru operațiunile distructive.
- Datele demo se creează doar printr-un script de seed explicit (`pnpm db:seed:demo`), într-o gospodărie marcată „Demo” și niciodată în producție.

## 7. Faze de implementare

Fiecare fază se termină cu: lint, type-check, teste și build verzi; `docs/ROADMAP.md` actualizat (complet, parțial, neimplementat); raportul din secțiunea 8.

### Faza 0 — Fundație
- Proiect Next.js + TypeScript strict, Tailwind, shadcn/ui, ESLint, Prettier, Vitest, Playwright.
- `docker-compose.dev.yml` cu Postgres 16 și Mailpit, `.env.example`, Drizzle configurat cu prima migrație goală.
- GitHub Actions: install, lint, type-check, test (cu Postgres ca serviciu), build.
- `lib/money.ts` complet, cu teste (parsare, formatare `ro-RO`, adunare, împărțire cu restul cel mai mare).
- `README.md` (pornire locală), `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/adr/0001-stack.md`.
- **Acceptare:** `pnpm install && pnpm dev` pornește aplicația cu instrucțiunile din README; CI e verde; testele pentru bani trec.

### Faza 1 — Autentificare, profil, gospodărie
- Înregistrare, verificare email, login, logout, resetare și schimbare parolă, listă de sesiuni active cu revocare.
- Crearea automată a gospodăriei personale la înregistrare, `user_preferences`, pagina de profil.
- `lib/authz.ts`, middleware pentru rutele protejate, rate limiting, antete de securitate.
- **Acceptare:** test E2E pentru înregistrare, verificare (Mailpit), login și logout; teste pentru rate limiting și expirarea sesiunilor.

### Faza 2 — Conturi, categorii, tranzacții, transferuri
- CRUD pentru conturi (cu arhivare), categorii de sistem (seed) și personalizate, tranzacții cu căutare, filtre (perioadă, cont, categorie, tip), sortare și paginare cu cursor.
- Transferuri atomice; soldul curent calculat.
- **Acceptare:** teste pentru solduri, transferuri (inclusiv rollback la eroare) și **izolarea între gospodării** pentru fiecare endpoint; test E2E pentru adăugarea unei cheltuieli și verificarea soldului.

### Faza 3 — Dashboard, bugete, rapoarte, export
- Dashboard pentru perioada selectată: venituri, cheltuieli, economii, solduri pe cont, distribuție pe categorii, comparație cu perioada anterioară. Totalurile sunt separate pe monedă.
- Bugete lunare pe categorie: progres, sumă rămasă, avertizare **în aplicație** la pragul configurat.
- Raport lunar și export CSV (regulile din 5.3), limitat strict la gospodăria curentă.
- **Acceptare:** teste pentru calculele de buget și de perioadă (inclusiv limitele de lună în `Europe/Bucharest`), pentru conținutul CSV și pentru faptul că exportul nu conține date din altă gospodărie.

### Faza 4 — Recurențe
- CRUD pentru reguli recurente; worker pg-boss care rulează orar și generează ocurențele scadente.
- Idempotență prin cheia unică `recurring_occurrences(rule_id, occurrence_date)` și o tranzacție DB per ocurență. Recuperarea ocurențelor ratate (catch-up) este limitată la un număr configurabil.
- Cazuri limită: ziua 31 în lunile scurte (se folosește ultima zi a lunii), 29 februarie, dezactivarea, `end_on`.
- **Acceptare:** teste care rulează jobul de două ori, sau în paralel, și verifică că nu apar duplicate; teste pentru cazurile limită de calendar.

### Faza 5 — Hardening, PWA, accesibilitate, performanță
- Manifest PWA, iconițe, service worker care pune în cache **doar asset-uri statice** (nu `/api/` și nu pagini cu date), plus pagina offline.
- Audit de accesibilitate și performanță (Lighthouse ≥ 90 la accesibilitate), revizuire de securitate pe checklist-ul `docs/SECURITY_CHECKLIST.md`.
- Export și ștergere GDPR pentru contul utilizatorului.
- **Acceptare:** checklist-ul de securitate completat cu dovezi; test E2E pentru exportul și ștergerea contului.

### Faza 6 — Familie (diferențiatorul principal)
- Invitații în gospodărie prin link cu token (`/join/[token]`, expirabil, de unică folosință), roluri, părăsirea gospodăriei și eliminarea unui membru.
- Conturi personale și comune, bugete comune și personale.
- Împărțirea cheltuielilor (`transaction_splits`: egal, procente, sume fixe), calculul soldurilor reciproce („cine cui datorează”), înregistrarea decontărilor (`settlements`).
- **Acceptare:** teste pentru împărțirea exactă (suma părților = total), pentru solduri reciproce cu 2 și 3 membri și pentru permisiunile pe roluri.

### Faza 7 — Deploy VPS, backup și restaurare
- Dockerfile multi-stage (utilizator non-root, imagine minimă), `docker-compose.prod.yml` cu versiuni fixate, healthcheck-uri, volume persistente, rețea internă (Postgres neexpus public), restart policy și rotație de loguri.
- Caddy cu TLS; migrațiile rulate ca pas separat înainte de pornirea aplicației.
- Backup zilnic cu `pg_dump`, criptat, copiat în afara VPS-ului, cu retenție. Script de restaurare **testat efectiv** într-un mediu separat.
- `docs/DEPLOY.md`: instalare, upgrade, rollback, backup și restaurare.
- **Acceptare:** restaurarea dintr-un backup real a fost executată și documentată, cu rezultatul.

### După MVP (câte o fază per funcție, în această ordine)
8. **Import CSV/Excel** cu previzualizare, mapare de coloane, profiluri per bancă (BT, BCR, ING, Raiffeisen, Revolut), deduplicare după (dată, sumă, descriere normalizată) și anularea unui import întreg.
9. **Bonuri cu AI și OCR:** consimțământ explicit înainte de prima trimitere la un furnizor extern, plus mențiunea furnizorului în politica de confidențialitate. Modelul se configurează din env, nu se scrie în cod. Răspunsul este JSON validat cu Zod (magazin, CUI, dată, produse, TVA 21% și 11%, total), cu verificarea că suma produselor egalează totalul și ecran de revizuire înainte de salvare. Bonurile lungi se combină din 2–4 poze, cu eliminarea duplicatelor. Limită zilnică per gospodărie și buget global de cost. Pozele se stochează criptat, cu retenție limitată.
10. **Import extrase PDF și ZIP** (procesare în worker, limite de dimensiune, protecție zip-bomb și path traversal).
11. Obiective de economisire, liste de cumpărături cu reconciliere din bonuri, notificări email sau Telegram, conversie de valută cu cursul BNR.
12. **SaaS:** planuri, Stripe (abonamente, perioadă de probă, portal), limite per plan aplicate pe server, program de recomandări, panou de administrare.

Nu prezenta aceste funcții ca implementate până nu sunt construite și testate. Nu pretinde sincronizare bancară fără o integrare reală verificată (de exemplu un agregator PSD2 licențiat).

## 8. Raport obligatoriu la finalul fiecărei faze

1. Ce ai implementat efectiv și ce a rămas parțial sau neimplementat.
2. Fișierele create sau modificate.
3. Comenzile de verificare rulate și rezultatele exacte (inclusiv eșecurile).
4. Instrucțiunile de pornire și, dacă e cazul, de deploy.
5. Variabilele de mediu noi (doar numele și scopul, fără valori).
6. Riscurile, limitările și ADR-urile noi.
7. Următorii pași prioritizați.

## 9. Riscuri cunoscute

- **Branding:** „FINpulse” este foarte apropiat de numele produsului de referință („FINpulse/day”). Înainte de lansarea publică alege un nume distinct și verifică disponibilitatea la OSIM și EUIPO și a domeniului. Până atunci, folosește un nume configurabil (`NEXT_PUBLIC_APP_NAME`).
- **Datele financiare sunt sensibile:** o scurgere de date înseamnă obligații GDPR de notificare. De aceea izolarea și logurile au testele lor dedicate.
- **Costul AI pe bon** trebuie măsurat înainte de stabilirea limitelor de plan.
- **Formatele extraselor** se schimbă fără anunț. Profilurile de bancă trebuie să aibă teste pe fișiere de exemplu anonimizate.

---

Începe prin a citi `docs/ROADMAP.md` (creează-l în Faza 0 dacă lipsește), apoi execută **doar** faza cerută în sesiunea curentă.
