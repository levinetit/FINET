# ADR 0015 — Bonurile: API-ul public, paginile Import și Bonuri, retenția originalelor

- **Stare:** propus (F6-C, branch `phase/06-receipts`). Migrația `0011`, redeploy-ul și programarea curățării: operatorul (`docs/INFRA.md`, „Faza 6 pe producție”).
- **Legături:** master prompt Faza 6 (7: paginile „Import”, „Bonuri”, ecranul de verificare), 3.4 (navigare), 3.6 (corecturile utilizatorului au prioritate), 5.3 (sume și date), 5.5, 5.6 (ștergere), 6.3, 6.4; ADR 0005 (API), 0006 (UI registru), 0013 (ingestie), 0014 (pipeline AI).

## Context

F6-A a stocat și preprocesat documentele, F6-B le citește cu AI-ul și pune bonul „De verificat”. F6-C expune totul utilizatorului: încărcarea, verificarea, corectarea și confirmarea care creează tranzacția. Constrângerile: corpul unei încărcări poate avea ~41 MB, proxy-ul Next 16 îl copiază în memorie și îl trunchiază fără eroare la 10 MB, iar verificarea Cloudflare Access nu are voie să slăbească; CSP-ul cu nonce rămâne neschimbat; nimic nu devine tranzacție fără confirmarea utilizatorului.

## Decizii

### 1. Încărcarea ocolește proxy-ul, nu verificarea Access

- `src/proxy.ts`: matcher-ul exclude **exact** `/api/v1/documents` (`/((?!_next/static/|api/v1/documents$).*)`). Testat cu `unstable_doesMiddlewareMatch`: sub-căile (`/{id}`, `/{id}/file`), `/api/v1/documents/`, `documentsX`, `documents.json`, variantele codificate și cu majuscule trec în continuare prin proxy.
- Ruta (`GET`, `HEAD` = GET, `POST` și `OPTIONS`) e înfășurată în `guardAccess` (`src/lib/access-guard.ts`): **aceeași** funcție `isRequestAllowed`, același verificator JWKS (memorat, extras din proxy), aceleași antete de securitate (CSP cu nonce nou, `nosniff`, HSTS…), ÎNAINTE de sesiune și de citirea corpului. Celelalte metode (PUT, PATCH, DELETE) nu sunt exportate: Next răspunde 405 fără corp, înaintea oricărui handler. Fail closed (configurație invalidă, chei indisponibile → 403). `HEALTH_TOKEN` nu deschide ruta.
- Alternativa respinsă: `experimental.proxyClientMaxBodySize ≈ 41 MB`. Ar fi ținut corpul în memoria serverului web (512 MB) pentru **orice** rută și orice cerere, inclusiv cele JSON refuzate apoi la 16 KB. Excluderea păstrează fluxul (busboy → `putStream`).
- Dovezi: `src/proxy.test.ts` (matcher + `guardAccess` în producție: 403 pe GET/HEAD/POST/OPTIONS fără JWT, cu JWT nevalidabil, cu `HEALTH_TOKEN`; handlerul nu e apelat), `e2e/access.spec.ts` (serverul de producție real), `receipts-api.test.ts` și E2E: un fișier de 11 MB ajunge întreg la handler și e refuzat cu `413 file_too_large`, nu `400 invalid_multipart` (care ar arăta o trunchiere).

### 2. API-ul (`/api/v1`, aceleași reguli ca ADR 0005)

- `GET /documents` (`status`, `since`, `limit`; cu `receiptId`), `GET /documents/{id}`, `GET /documents/{id}/file`, `DELETE /documents/{id}`, `GET /ai/usage` (`{used, limit, remaining}`, fără costuri sau buget).
- **Fișierul**: flux din storage, plafonat la dimensiunea înregistrată; antete fixe: tipul DETECTAT (niciodată HTML/SVG), `Content-Disposition: attachment; filename="bon-<id>.<ext>"` (nume generat de server), `nosniff`, `Cache-Control: private, no-store`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`. Străin, inexistent sau șters la retenție → 404 uniform.
- `GET /receipts` (filtre: `status`, `q`, `merchant`, `dateFrom`/`dateTo`, `amountMinMinor`/`amountMaxMinor`, `categoryId`, `tagId`; cursor opac pe `(created_at, id)` cu microsecunde, ca text), `GET /receipts/{id}` (liniile, problemele, `providerUsed`, `fallbackReason`, scorul, liniile eliminate la unire, `suggestedOrder`), `PATCH /receipts/{id}`, `POST /receipts/{id}/confirm` (`Idempotency-Key`), `POST /receipts/{id}/reprocess`, `DELETE /receipts/{id}`.
- **Căutarea** (decizia mea): `q` caută în comerciant și în liniile bonului (numele brut și cel normalizat), iar dacă `parseAmount(q)` reușește („45,90”, „45.90”, „45”) și în total sau în suma unei linii. `LIKE` cu escape (`escapeLike`). **Eticheta**: liniile nu au etichete; `tagId` filtrează bonurile a căror tranzacție are eticheta.
- **Subinterogările corelate** referă coloanele exterioare explicit (`finet.receipts.id`): Drizzle scrie coloanele fără tabel într-un `select` pe o singură tabelă, iar `l.receipt_id = "id"` ar fi legat `id`-ul liniei (găsit și reparat în testul pe PostgreSQL real).
- Erori noi cu cod fix (409 `reason`): `receipt_saved`, `receipt_already_saved`, `possible_duplicate`, `total_required`, `date_required`, `currency_mismatch`, `duplicate_receipt`, `file_deleted`, `document_rejected`, `daily_document_limit`. `translateDbError` tratează și SQLSTATE 22021 (caracter invalid/NUL în text) ca 400 cu mesaj fix (cererea coordonatorului).
- Auditul: `receipt.corrected|confirmed|reprocessed|deleted`, `documents.expired`: doar contoare și id-uri, fără sume, nume de produse sau comercianți (testat).
- **OpenAPI**: `multipart/form-data` pentru încărcare, răspuns binar pentru fișier, `200` suplimentar la încărcarea doar din duplicate; `assertContract` verifică și antetele fișierului.

### 3. Corectarea (`PATCH`)

- Zod strict; sumele DOAR ca întregi `…Minor` (UI-ul parsează textul cu `parseAmount`), cantitatea și cota TVA ca text zecimal; CUI-ul normalizat (`RO` + 2–10 cifre).
- **Liniile se înlocuiesc integral** (ordinea = poziția). `id` păstrează o linie existentă a ACESTUI bon (altfel 400). Categoriile: doar de cheltuieli, vizibile în gospodărie.
- Se **recalculează în cod**: verificările (`checkReceipt`, cu `vat_rates` din bază), scorul, numele normalizate și cheia de deduplicare. O coliziune a cheii cu alt bon marchează bonul „posibil duplicat” (nu dă eroare). Rămân din pipeline doar problemele care nu se pot recalcula (`possible_duplicate_image`, `long_receipt_mismatch`); `extraction_failed`/`ai_unavailable`/`budget_exceeded` dispar după corectare (datele sunt acum ale utilizatorului).
- **`product_aliases`** (3.6): o categorie aleasă pe o linie de produs, nouă sau schimbată, devine alias-ul numelui normalizat (upsert), folosit de worker înaintea regulilor și a LLM-ului la bonurile următoare.
- După confirmare, bonul nu se mai modifică (409 `receipt_saved`).

### 4. Confirmarea → tranzacție

- O tranzacție de cheltuială per bon (decizia coordonatorului): suma = totalul bonului (total lipsă sau 0 → 409), data = cea trimisă sau a bonului, moneda contului = moneda bonului (altfel 409; fără conversie), `source = receipt`, `document_id` = primul document (bon lung: poza 1), comerciantul pe `merchant`.
- **Categoria tranzacției** (decizia mea): cea trimisă (`categoryId`, inclusiv `null`) sau categoria cu cea mai mare sumă pe liniile de produs. Categoriile liniilor rămân pe `receipt_lines` (rapoartele pe produse pot veni ulterior).
- O diferență între suma liniilor și total **nu** blochează (utilizatorul a văzut-o pe ecran); un „posibil duplicat” cere `allowDuplicate: true` (override-ul manual din ADR 0014).
- Bonul blocat `FOR UPDATE` (o a doua confirmare → 409 `receipt_already_saved`; blocarea serializează și cererile paralele), `Idempotency-Key` pentru reluări, garda 2^53 pe sold, documentele → `done`.

### 5. Reprocesarea

- Costă un nou apel AI, deci (decizia mea): limita proprie de cereri (10 / 10 min / utilizator), **consumă limita zilnică** (contorul `document_usage_daily` doar crește), resetează `attempts` la 0. Refuzată pentru un bon salvat, un fișier șters la retenție sau un document refuzat.
- Bonul extras se șterge, iar documentele revin în `queued`; consimțământul îl verifică workerul (fără el: `awaiting_consent`). `order` (doar bon lung) aplică „Ordonează automat” (ordinea propusă de unire): ordinele se golesc întâi (unicitatea lot+ordine), apoi se scriu.

### 6. Ștergerea

- `DELETE /receipts/{id}` șterge bonul, documentele lui (rândurile și fișierele) și lotul; tranzacția creată rămâne, cu `document_id` golit de cheia `SET NULL` (5.6). `DELETE /documents/{id}` (F6-A) rămâne pentru documentele fără bon.

### 7. Consimțământul `externalAi`

- Comutatorul din `/profile` (`#external-ai`), cu textul din `PRIVACY_NOTES` (ce pleacă, către cine). După acord, `PUT /me/consents` mută în coadă documentele utilizatorului care îl așteptau (au fost numărate deja la încărcare; nu se mai numără).

### 8. Interfața

- **`/import`**: o singură zonă (alegere sau drag & drop, ≤ 4 fișiere), contorul „X din Y documente azi”, comutatorul explicit „Mod bon lung (2–4 poze)” cu lista ordonată de sus în jos și reordonare **cu butoane** (accesibil, nu doar drag), previzualizarea, refuzul explicit al extraselor (Faza 7), mesajul pentru consimțământ lipsă (link la Profil și la introducerea manuală), starea fiecărui document cu polling blând (3 s, +50% la fiecare pas, plafon 20 s, oprit la stările finale și după ~12 minute, suspendat cât tab-ul e ascuns), fără biblioteci.
- **Previzualizarea fără `blob:`** (decizia mea): CSP-ul are `img-src 'self' data:`; previzualizarea folosește `FileReader` → `data:` (doar imagini ≤ 6 MB), deci CSP-ul nu se schimbă. Numele fișierelor nu se trimit (formularul pune `bon-<n>`) și nu se folosesc nicăieri.
- **`/receipts`**: „De verificat” mereu sus (interogare separată, evidențiat), apoi istoricul cu data, comerciantul, TOATE categoriile, totalul `0,00 lei`, starea și acțiunile (vezi, reprocesează, șterge cu confirmare); căutarea e un GET simplu (merge și fără JavaScript). Butonul „Scanează” duce la `/import`.
- **`/receipts/[id]`**: pozele DOAR prin ruta autentificată (`<img src="/api/v1/documents/{id}/file">`; PDF: link), câmpurile și liniile editabile, câmpurile/liniile cu probleme evidențiate, problemele traduse din coduri stabile, furnizorul AI și motivul fallback-ului, liniile eliminate la unire tăiate (`<del>`, cu numele de pe bon — scris de worker în `merge_report`, plafonat la 80 de caractere —, poza și rândul), suma liniilor față de total, bannerul „Posibil duplicat al bonului X” + „Nu e duplicat”, „Ordonează automat”, „Confirmă și salvează” (corecturile întâi, apoi confirmarea cu `Idempotency-Key`).
- **Navigarea** (decizia mea): pe desktop „Import” și „Bonuri” în meniul lateral; pe telefon „Scanează” (`/import`) ia locul lui „Bugete” în bara de jos, iar „Bugete” trece în „Mai mult”: bonul se fotografiază pe loc, în magazin, iar bugetele se consultă mai rar.
- Tranzacțiile din bonuri au insigna „din bon” în listă (filtrul `source=receipt` exista) și „Vezi bonul” pe pagina tranzacției.
- Regulile existente: fără `style=`, fără `dangerouslySetInnerHTML`, sume doar prin `money.ts` (`ui-rules.test.ts`), câmpuri etichetate, `aria-live` pe stări.

### 9. Retenția originalelor (`cleanup-documents`)

- Migrația `0011_document_retention`: `finet.expired_documents(p_limit)` (SECURITY DEFINER, proprietar `finet_migrator`, `search_path = pg_catalog`, EXECUTE doar `finet_app`, doar identificatori; politica `documents_migrator_expired` îi arată proprietarului DOAR documentele expirate cu fișier; documentele `queued`/`processing` sunt omise).
- `admin cleanup-documents [--temp-hours N]` (`src/modules/documents/retention.ts`): ca membrul întors de funcție, sub RLS, rândul re-citit și blocat, **întâi fișierul**, apoi `storage_key = NULL` + `file_deleted_at`; o eroare între cele două lasă rândul de reluat (nu un original orfan cu GPS pe disc). Apoi `cleanupTemp` (fișierele `*.tmp-*` mai vechi de N ore, implicit 24; închide F9). Ieșirea: doar contoare. Datele extrase și tranzacțiile rămân.
- **Siguranța montajului**: fără `STORAGE_DIR` → eroare; directorul fără `households/` (storage nemontat) → nu se marchează nimic (altfel lipsa fișierului ar fi luată drept „deja șters”).
- **Privilegiul minim** (decizia mea): serviciul one-shot nou `finet-cleanup` (profilul `cleanup`) e SINGURUL cu storage-ul în scriere în afara serverului web; `finet-admin` (create-user, reset-password) rămâne fără storage.

## Consecințe

- Pe producție: migrația `0011`, redeploy-ul web, un cron zilnic pentru `finet-cleanup` (INFRA).
- E2E-ul bonurilor rulează în CI cu workerul real și serverul AI fals (`e2e/ai-mock-server.mjs`, răspunsuri după lățimea pozei); doar în modul `personal` (decizia mea: timpul jobului; worker-ul și pipeline-ul nu depind de mod).
- **Rămân deschise:**
  - unirea automată a două încărcări separate cu același CUI și număr (ADR 0014) nu e implementată: utilizatorul folosește „Mod bon lung”;
  - salvarea automată a bonurilor fără probleme rămâne oprită (ADR 0014);
  - bugetul JavaScript al paginilor noi e măsurat doar în CI (`pnpm check:bundle`).
