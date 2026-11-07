# Open Banking (PSD2) pentru FINET — evaluare (2026-11-07)

Pasul L din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`; decizia: ADR 0050. Scop: sincronizarea conturilor și tranzacțiilor din băncile din România și UE printr-un **agregator licențiat (AISP)**, nu prin scraping (interzis de master prompt, §„Faze viitoare”, și de ToS-urile băncilor).

> Prețurile și limitele de mai jos sunt cele publice la data auditului, din paginile furnizorilor și din experiența comunității; **trebuie reconfirmate la semnarea contractului**. FINET nu are cont la niciun furnizor; nimic nu a fost testat live.

## Cadrul

- **PSD2 / RTS SCA:** accesul la conturi (AIS) doar printr-o entitate autorizată (AISP) înregistrată la o autoritate națională (în RO: BNR). Un dezvoltator fără licență folosește un agregator care deține licența și expune un API unic peste băncile din UE/SEE.
- **Consimțământul:** utilizatorul îl dă la bancă (redirect/OAuth), valabil **90 de zile** (RTS actual; PSD2 revizuită/PSR propune 180 de zile; unii furnizori expun deja 180 unde banca permite). După expirare, reautorizare. Fiecare bancă își definește și limita de interogări fără prezența utilizatorului (de regulă 4/zi per cont).
- **Datele:** IBAN, solduri, tranzacții (de obicei 90 de zile istoric la prima conectare, uneori 1–2 ani la BT/ING), nume contraparte. Sunt **date personale financiare**: contract de prelucrare cu agregatorul, menționare în `/privacy`, consimțământ explicit în aplicație (`consents.kind` nou), ștergere la revocare/ștergerea contului (GDPR export include istoricul sincronizărilor).

## Furnizori

| Furnizor | Acoperire RO | Model de preț (public, orientativ) | Consimțământ | Limitări notabile |
|---|---|---|---|---|
| **GoCardless Bank Account Data** (fost Nordigen) | BT, BCR, BRD, ING, Raiffeisen, Unicredit, CEC, Revolut, Alpha ș.a. (≈ 20 instituții RO) | Istoric gratuit „free tier” închis din 2024; azi plan comercial per conexiune de cont/lună (≈ 0,10–0,30 EUR/cont/lună în volume mici, minim lunar) | 90 de zile (180 unde banca permite) | API simplu (REST, JSON), sandbox cu „Sandbox Finance”; limită de 4 cereri/zi/cont la unele bănci; suport prin ticket |
| **Salt Edge** (AIS/Open Banking Gateway) | cele mai multe bănci RO, inclusiv cele mici | Enterprise: contract, minim lunar de ordinul sutelor EUR; „Partner” gratuit doar pentru dezvoltare/testare (date fictive sau conturi proprii) | 90/180 de zile | API bogat (categorisire proprie, „lead” per client), mai complex; cere revizuire a aplicației la trecerea în producție |
| **Enable Banking** | bănci RO principale; foarte bună în Nordice/Baltice | Per cont activ/lună (≈ 0,2 EUR) + abonament; sandbox gratuit | 90/180 | API PSD2 „pur” (cât mai aproape de Berlin Group), fără categorisire; necesită certificate eIDAS gestionate de ei |
| **Tink** (Visa) | RO acoperită parțial | Contract enterprise, nu self-service | 90 | Orientat spre volum mare; nu pentru un produs personal |
| **Plaid** | fără RO (UE vestică) | — | — | Nu e relevant pentru RO |
| **API-urile directe ale băncilor** (BT API, ING Developer, BCR API) | 1 bancă fiecare | gratuite pentru AISP-uri | 90 | Cer licență AISP proprie (BNR) + certificate eIDAS QWAC/QSealC: **nu e o opțiune** pentru FINET |

**Recomandare:** GoCardless Bank Account Data ca prim furnizor (API simplu, sandbox, acoperire RO bună, cost per cont mic), cu Enable Banking ca alternativă (date PSD2 „curate”, fără categorisire proprie, ceea ce se potrivește cu categorisirea FINET). Salt Edge dacă se merge pe `saas` cu volum. Indiferent de alegere, codul rămâne în spatele interfeței din `src/modules/banking/provider.ts`.

## Ce există deja în FINET și ce lipsește

Există: importul de extrase cu previzualizare, deduplicare după referința băncii, confirmare, acoperire pe luni (ADR 0018), potrivirea bon ↔ tranzacție (ADR 0019), consimțămintele (`consents`), workerul cu cozi (ADR 0011). Lipsesc: stocarea consimțămintelor PSD2 și a legăturii cont bancar ↔ cont FINET, jobul de sincronizare, ecranul de conectare, tratarea erorilor furnizorului (reautorizare, bancă indisponibilă), alertele de eșec (acum: `sync_failure` din ADR 0048 acoperă documentele; se extinde cu `banking_sync_failed`).

## Designul propus (pentru pasul următor, după alegerea furnizorului)

1. **Tabele (migrație nouă):** `bank_connections` (gospodărie, furnizor, instituție, consent id al furnizorului, stare, `expires_at`, `created_by`, fără tokenuri în clar: furnizorul le ține; noi doar id-ul), `bank_connection_accounts` (legătura cont furnizor ↔ `accounts.id`, IBAN mascat, `last_synced_on`), `bank_sync_runs` (jurnal: fereastra, rânduri, rezultat, cod de eroare). Toate cu RLS pe gospodărie.
2. **Flux:** `/banking` → alege instituția → `POST /api/v1/banking/connections` (consimțământ, `authorizeUrl`) → redirect la bancă → `/banking/return?ref=` → `GET consent` → alegerea conturilor și maparea pe conturi FINET existente sau noi → prima sincronizare (90 de zile) prin `toParsedStatement` → previzualizare (același ecran ca la extrase) → confirmare.
3. **Sincronizare:** job `banking.sync` zilnic (în limita de 4/zi/cont), doar `bookingDate > last_synced_on − 3 zile` (reconciliere), deduplicare după `bankReference`; eșecurile devin notificări `sync_failure`; consimțământul expirat → notificare + stare `expired`.
4. **Securitate:** secretele furnizorului doar în worker (`*_FILE`, ca AI), gazdă în allowlist, fără redirecționări, corp plafonat, log fără IBAN/sume; consimțământ FINET explicit (`consents.kind = "open_banking"`), revocare din aplicație (apel la furnizor + ștergerea legăturii), export GDPR cu conexiunile și jurnalul.
5. **Costuri estimate (personal, 2–4 conturi):** sub 2 EUR/lună la GoCardless/Enable; `saas`: cost per utilizator activ, de pus în planuri (`entitlements`: `banking.connections` ca limită).
