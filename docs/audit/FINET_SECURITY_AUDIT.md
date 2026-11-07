# FINET — auditul de securitate al modernizării 2026 (2026-11-07)

Pasul C din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`. Acoperă starea de dinainte (controalele existente, `docs/SECURITY_CHECKLIST.md` §1–41) și codul adăugat în `feature/finet-modernization-2026` (ADR 0045–0051). Metoda: inventarul rutelor de scriere, citirea migrațiilor noi (RLS, GRANT, funcții definer), a handlerelor și a jobului de notificări, teste de izolare între gospodării pe fiecare modul nou, verificări punctuale (CSRF, descărcarea BCE, email). Nimic nu a fost rulat pe producție.

## 1. Autentificare și sesiuni
- Better Auth 1.7.18 (actualizat; 1.7.16 a închis sesiuni revocate rămase valide cu cache de cookie, linkuri de email legate de contul corect, `email_verified` ca șir la OAuth). FINET nu folosește cookie cache, deci era doar parțial expus. **OK.**
- Argon2id, sesiuni în bază, bearer pentru Android, rate limiting pe IP de încredere + email, magic link/resetare doar cu SMTP. **OK.**
- **L8 — ÎNCHIS** (ADR 0051): bearer invalid + cookie valid, fără `Origin`, dădea o mutație fără CSRF; acum cookie-ul e ignorat când există antet bearer → 401 (test în `me.test.ts`).
- **L6 — DESCHIS:** tokenul de resetare a parolei rămâne în clar în `auth_verifications` (Better Auth nu are `storeToken: "hashed"` pe resetare). 30 de minute, unică folosință. Re-verificat la 1.7.18: neschimbat.
- MFA: Better Auth are pluginul `twoFactor`; FINET nu îl activează. Risc acceptat în `personal` (un singur utilizator, în spatele Cloudflare Access); pentru `saas` public e o cerință înainte de expunere (recomandare, nu implementată aici: cere migrație și UI).

## 2. Autorizare, izolare între gospodării și tenanți
- Două straturi neschimbate: `withMember` + RLS `FORCE` pe toate tabelele. Modulele noi citesc doar prin `inHousehold`, cu filtru explicit pe `household_id`; nicio interogare pe rând nu primește id din body.
- Tabelele noi: `account_valuations` (politica cere contul vizibil sub RLS: evaluările conturilor personale ale altora sunt invizibile), `notifications`/`notification_preferences` (doar rândurile proprii; UPDATE doar pe marcaje), `fx_rates` (date globale, citire pentru oricine autentificat, fără DELETE). Toate cu `ENABLE` + `FORCE`, `revoke all from public`, GRANT-uri minime, testate în `migrate.test.ts`.
- Funcții `SECURITY DEFINER` noi: doar `finet.notification_targets(integer)` (id-uri, `search_path = pg_catalog`, execute explicit). **OK.**
- Teste de izolare pe fiecare modul nou (Ana vs Bogdan): scor, prognoză, consilier, avere netă (404 uniform pe contul altuia), plan, abonamente, notificări (404 la citire/ștergere străină), cursuri (globale, intenționat). **OK.**
- `saas`: funcțiile noi nu sunt încă `Feature`-uri în entitlements (toate planurile le au); `assertWritable` se aplică mutațiilor noi (evaluări), iar citirile notificărilor și simularea merg cu abonament expirat, intenționat. Plafoanele per gospodărie (LOW-4) sunt acum tehnice, independente de plan.

## 3. Intrări, injecții, XSS, SSRF
- Zod strict peste tot (chei necunoscute respinse); `readQuery` respinge parametrii nepermiși; id-urile din rută trec prin `routeId`. SQL doar prin Drizzle/parametri; `percentile_disc`, `to_char` etc. fără text din utilizator. **OK.**
- XSS: fără `dangerouslySetInnerHTML` în paginile noi; textele notificărilor sunt compuse în cod din șabloane fixe + sume formatate; emailul HTML escapează tot (`escapeHtml`). CSP cu nonce neschimbat. **OK.**
- SSRF: singura cerere externă nouă e descărcarea BCE: gazdă fixă (`www.ecb.europa.eu`), HTTPS, `redirect: "error"`, corp ≤ 2 MiB, termen 15 s, doar cu `FX_RATES=1`, doar în worker. Furnizorul Open Banking e doar `mock` (fără rețea). **OK.**
- Linkurile din notificări: CHECK în bază (`^/[a-z0-9/?=&._-]{0,200}$`, doar căi relative), deci nici un `javascript:`/URL extern nu poate ajunge în `href`. **OK.**

## 4. Fișiere, PDF, AI
- Neschimbate (ADR 0013/0014/0018): procese copil sub `prlimit`, validare după conținut, buget AI global. Extracția AI acceptă HUF/GBP în enum (fără efect de securitate).
- Consilierul NU trimite nimic la LLM (consimțământul existent nu acoperă sume/comercianți; ADR 0045 §13). **OK.**

## 5. Secrete, configurare, loguri
- Niciun secret nou. `FX_RATES` e un flag. Workerul primește mailer-ul din aceeași configurație SMTP (TLS obligatoriu în producție). `.env.example` și exemplele compose actualizate; `pnpm test:ops` verifică lipsa secretelor din exemple.
- Loguri: joburile noi (`notify.evaluate`, `fx.refresh`) loghează doar contoare și coduri; nicio sumă, id de utilizator sau conținut de notificare. **OK.**
- Emailul de notificări: conține titlurile și textele notificărilor (deci sume agregate: „ai cheltuit X din Y”) — aceleași ca în aplicație; **fără** linkuri de autentificare; trimis doar cu `email = true` (implicit oprit). Risc acceptat și documentat în ADR 0048; utilizatorul alege.

## 6. GDPR
- Exportul include notificările, preferințele și (prin tabelele existente) evaluările; ștergerea contului le elimină în cascadă (FK `ON DELETE CASCADE`). Datele de curs sunt globale, fără legătură cu utilizatorul. **OK.**
- Open Banking: cerințele (IBAN mascat, tokenuri la furnizor, consimțământ FINET revocabil) sunt scrise în evaluare pentru implementarea viitoare.

## 7. CI și lanțul de aprovizionare (pasul A)
- Acțiuni pe SHA, audit blocant HIGH+, CodeQL (fără constatări pe branch), gitleaks (curat pe istoric), Trivy (CVE-uri în imaginea de bază Node: `undici` DoS în npm-ul global al imaginii, neexploatabil în runtime-ul FINET; se rezolvă la următoarea imagine Node), digest pe imagine, hash pe pnpm. `claude-faza.yml` păstrează drepturi de scriere (necesare agentului), limitat la proprietar și la eticheta `faza`.

## 8. Constatări și stare

| # | Nivel | Constatare | Stare |
|---|---|---|---|
| S1 | MEDIUM | L8 bearer + cookie | **închis** (ADR 0051) |
| S2 | MEDIUM | LOW-4 plafoane per gospodărie (cu lacăt consultativ contra TOCTOU; bugetele numărate pe mulțimea vizibilă sub RLS) | **închis** (ADR 0051) |
| S3 | MEDIUM | lanț CI (SHA, audit, CodeQL, gitleaks, Trivy) | **închis** (pasul A) |
| S4 | LOW | L6 token de resetare în clar | deschis (dependență externă) |
| S5 | LOW | MFA absent pentru `saas` public | deschis (decizie de produs; cere migrație + UI) |
| S6 | INFO | `/settings/notifications` importa schema Drizzle în client (bundle, nu securitate) | închis |
| S7 | INFO | emailul de notificări conține sume agregate | acceptat (opt-in explicit) |
| S8 | INFO | `fx_rates` scris de `finet_app` din worker (nu de o funcție definer) | acceptat: tabel global fără date personale, fără DELETE |

Riscurile acceptate anterior (§22.4 din checklist) rămân valabile.
