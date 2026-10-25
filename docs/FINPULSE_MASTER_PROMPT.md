# FINpulse România — MASTER PROMPT pentru Claude Code

## Misiune

Acționează ca arhitect software senior, dezvoltator full-stack, specialist în securitate și DevOps. Construiește FINpulse România: o aplicație web modernă de finanțe personale, cu interfață în română și RON ca monedă implicită, proiectată pentru extindere ulterioară către SaaS multi-utilizator. Inspiră-te din categoria produselor precum finpulse.day, fără a copia branding, texte sau cod protejat.

Repository-ul existent este sursa de adevăr. Nu presupune că proiectul este gol. Auditează înainte să modifici și păstrează arhitectura și convențiile existente dacă sunt adecvate.

## Reguli de execuție

1. Inspectează structura, README, codul, dependențele, migrațiile, testele, configurația Docker și starea Git.
2. Prezintă un plan etapizat, apoi continuă implementarea; nu te opri la un plan teoretic.
3. Lucrează incremental și verifică fiecare etapă prin teste/build/lint disponibile.
4. Nu pretinde că ai rulat verificări pe care nu le-ai executat.
5. Nu șterge date sau configurații și nu face operațiuni distructive fără aprobare.
6. Nu introduce secrete în cod, loguri, commit-uri sau documentație. Folosește variabile de mediu și `.env.example` fără valori reale.
7. Preferă tehnologii stabile, open-source și ieftine. Nu schimba stack-ul fără motiv tehnic.
8. Notează ipotezele, riscurile, fișierele modificate și rezultatele exacte.

## Etapa 1 — Audit și arhitectură

Evaluează structura repository-ului, frontend-ul, backend-ul, baza de date, autentificarea, autorizarea, validarea, gestionarea erorilor, testele, build-ul, containerele, CI/CD și documentația. Identifică vulnerabilități, cod duplicat și lacune. Recomandă un monolit modular înaintea microserviciilor premature. Documentează deciziile și criteriile de acceptare.

## Etapa 2 — Funcționalități MVP

### Autentificare și profil
- Înregistrare, login, logout, recuperare sigură a accesului și schimbare parolă.
- Profil, preferințe regionale, fus orar și monedă implicită RON.
- Sesiuni expirabile/revocabile și opțiuni de export/ștergere a datelor.

### Conturi
- Conturi de tip numerar, bancă și economii.
- Sold inițial, sold curent, arhivare și monedă.
- Transferuri între conturi care nu sunt contabilizate ca venituri sau cheltuieli.

### Tranzacții
- CRUD pentru venituri, cheltuieli și transferuri.
- Dată, sumă, cont, categorie, descriere, comerciant și note opționale.
- Căutare, sortare, filtrare, paginare și validare atât pe client, cât și pe server.
- Folosește tipul tranzacției explicit; nu reprezenta sumele monetare cu floating point.

### Categorii și bugete
- Categorii implicite în română și categorii personalizate.
- Bugete lunare pe categorie, progres, sumă rămasă și avertizări configurabile.

### Dashboard și rapoarte
- Solduri, venituri, cheltuieli și economii pe perioada selectată.
- Comparație cu perioada anterioară, grafice lizibile și distribuție pe categorii.
- Rapoarte lunare și export CSV UTF-8, limitat strict la datele utilizatorului autentificat.

### Recurențe
- Reguli recurente cu frecvență, următoarea dată și dezactivare.
- Procesare idempotentă pentru a evita tranzacțiile duplicate.

## Funcții ulterioare, după MVP

Import CSV cu previzualizare și deduplicare, OCR pentru bonuri/facturi, categorisire și rezumate AI, notificări prin e-mail/Telegram, obiective de economisire, PWA și funcții SaaS. Acestea sunt opționale și nu trebuie prezentate ca implementate până nu sunt construite și testate. OCR/AI trebuie să aibă limite de cost și să transmită date către terți numai cu informare și consimțământ adecvat. Nu pretinde că există sincronizare bancară fără integrare reală verificată.

## Arhitectură și model de date

Separă interfața, autentificarea/autorizarea, logica financiară, accesul la date, contractele API și joburile programate. Folosește validare strictă la limitele API, operațiuni atomice, erori coerente, paginare, indecși și loguri fără date financiare sensibile.

Adaptează următoarele entități la stack-ul existent:
- `users`: identitate, email unic normalizat, hash parolă sau furnizor de autentificare, status și timestamps.
- `user_preferences`: locale, timezone, default_currency și preferințe UI.
- `accounts`: user_id, nume, tip, monedă, sold inițial, archived_at.
- `categories`: user_id sau categorie de sistem, nume, tip tranzacție.
- `transactions`: user_id, account_id, category_id nullable, tip, sumă exactă, monedă, dată, descriere și transfer_group_id nullable.
- `budgets`: user_id, categorie, perioadă, sumă și monedă.
- `recurring_rules`: utilizator, cont, categorie, tip, sumă, monedă, frecvență, next_run_at, active și idempotency_key.
- `audit_events`: actor, acțiune, țintă, timestamp și metadate minime.
- Sesiuni, importuri și joburi numai când funcțiile respective sunt implementate.

Adaugă chei străine, constrângeri, indecși și reguli explicite de ștergere. Orice citire/scriere de date personale trebuie autorizată pe server pentru utilizatorul autentificat; nu te baza pe ID-uri trimise de client. Stochează banii ca DECIMAL/NUMERIC sau unități monetare minore întregi, niciodată float. Documentează rotunjirea, fusul orar și semantica transferurilor.

## Securitate și confidențialitate

Aplică principii OWASP:
- Hashing modern al parolelor, de exemplu Argon2id, sau furnizor matur.
- Cookie-uri Secure, HttpOnly și SameSite potrivite; protecție CSRF unde este necesară.
- Rate limiting pentru login, recuperare și endpoint-uri sensibile.
- Protecție IDOR/BOLA prin autorizare per resursă.
- Validare input, interogări parametrizate, protecție XSS, CORS strict și antete de securitate.
- Secrete numai în environment/secrets manager; fără credențiale în frontend.
- Verificare de dependențe, backup și procedură de restaurare testată.
- Minimizarea datelor, retenție documentată și ștergere/export al datelor utilizatorului.

Nu colecta credențiale bancare și nu stoca numere complete de card. Nu include date sensibile în URL-uri, analytics sau erori. Nu prezenta aplicația drept consultant financiar autorizat.

## API și experiență utilizator

Documentează endpoint-urile reale pentru autentificare, profil, conturi, tranzacții, transferuri, categorii, bugete, dashboard, rapoarte și export. Folosește coduri HTTP corecte, validare consistentă, erori uniforme și paginare. Adaugă OpenAPI dacă se potrivește stack-ului; nu documenta endpoint-uri inexistente.

Interfața trebuie să fie în română, cu diacritice corecte, formatare regională RON, design responsiv, accesibilitate de bază, stări de încărcare/eroare/goale și confirmări pentru operațiuni distructive. Datele demo trebuie marcate clar și separate de datele reale.

## Testare și criterii de acceptare

Adaugă teste potrivite stack-ului pentru:
- calcule monetare, solduri, bugete, transferuri și recurențe;
- autentificare, validare și izolare între utilizatori;
- export CSV, filtrare și paginare;
- idempotency și evitarea joburilor duplicate;
- build, lint și type-check.

MVP-ul este acceptabil când:
1. Utilizatorul se autentifică și își administrează conturile.
2. Veniturile, cheltuielile și transferurile sunt persistate și calculate corect.
3. Dashboard-ul, bugetele și rapoartele reflectă datele reale.
4. Un utilizator nu poate accesa datele altuia.
5. Exportul conține doar date autorizate.
6. Aplicația pornește din instrucțiuni documentate fără secrete în repository.
7. Rezultatele testelor/build-ului sunt raportate exact.

## Docker și deploy VPS

Dacă se potrivește stack-ului, configurează Dockerfile multi-stage, compose cu versiuni fixate, healthcheck-uri, volume persistente, rețele interne, utilizator non-root, restart policy și rotație de loguri. Folosește reverse proxy/TLS disponibil, nu expune baza de date public și nu include parole reale în compose. Documentează migrarea, upgrade/rollback, backup și restaurare. Nu considera backup-ul valid până când restaurarea nu a fost testată.

## Faze de implementare

1. Audit, plan, decizii arhitecturale și fundație.
2. Autentificare, profil și izolare per utilizator.
3. Conturi, categorii, tranzacții, transferuri și teste.
4. Dashboard, bugete, rapoarte și export.
5. Recurențe, hardening, performanță și accesibilitate.
6. Deploy VPS, backup/restore și documentație.
7. Import CSV, OCR, AI, notificări și SaaS doar după stabilizarea MVP-ului.

După fiecare fază, rulează verificările disponibile, actualizează documentația și notează ce este complet, parțial sau neimplementat.

## Livrabile

Actualizează sau creează dacă lipsesc:
- README și instrucțiuni de dezvoltare;
- document de arhitectură și decizii tehnice;
- migrații și descrierea schemei;
- `.env.example`;
- documentație API;
- teste automatizate;
- instrucțiuni Docker/VPS;
- checklist de securitate și lansare;
- proceduri backup/restore;
- roadmap cu starea reală a fiecărei funcții.

## Raport final obligatoriu

La final raportează:
1. ce ai implementat efectiv;
2. fișierele create/modificate;
3. comenzile de test/build rulate și rezultatele exacte;
4. instrucțiuni de pornire și deploy;
5. variabilele de mediu necesare, fără secrete;
6. riscuri și limitări rămase;
7. următorii pași prioritizați.

Începe acum prin auditarea repository-ului și stării Git. Implementează incremental și verifică fiecare rezultat. Nu declara o funcție finalizată fără verificare.
