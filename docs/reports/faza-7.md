# Raportul Fazei 7 — Extrase bancare, potrivire, abonamente (F7-A, F7-B)

Branch `phase/07-statements`. Datele, extracția, parserele și serviciile (F7-A) sunt descrise în ADR 0018 și în `docs/SECURITY_CHECKLIST.md` (secțiunea 21). Raportul de față descrie F7-B (ADR 0018 §11, ADR 0019) și starea de acceptare a fazei.

**Confidențialitate:** extrasele reale ale operatorului nu au intrat în repo, în teste, în documentație, în loguri sau în CI. Fixture-urile și datele E2E sunt SINTETICE. Verificarea de scurgeri (locală, în afara repo-ului) a rulat înaintea fiecărui commit: PASS pe tot ce s-a adăugat în F7-B.

## 1. Revizuirea de securitate F7-A: toate cele 8 constatări corectate

1. Cheia `fx` (și indicele ei de apariție) se calculează doar printre rândurile de schimb valutar. O rambursare obișnuită de aceeași sumă și dată nu mai e marcată duplicat.
2. Marcajele de secțiune scrise de plătitor în detalii (de exemplu „SUME BLOCATE”, „RULAJ ZI”, „Sold final …”, „Tranzacții în așteptare”, „Extras EUR”) se ignoră pe rândurile de continuare, la toate cele 4 bănci. Perioada și moneda se citesc o singură dată. Există 25 de teste adversariale, verificate că pică pe codul vechi.
3. Anularea evaluează „modificată” pe tot grupul unui transfer valutar.
4. Când piciorul unui transfer e într-un cont personal invizibil, anularea dă conflictul explicit `statement_import_counterpart_hidden`.
5. Cheile duplicate din același fișier (un `ID tranzacție` Revolut repetat) sunt marcate `duplicate` încă din previzualizare.
6. Contorul zilnic nu mai poate scădea (trigger în 0014). Cota se consumă înainte de parsare, într-o tranzacție proprie, câte o unitate pe fișier. Încărcarea are limită de cereri, iar workerul rulează un singur proces copil PDF odată.
7. IBAN-ul din fixture-ul Raiffeisen are acum cifra de control invalidă. Un test verifică că niciun IBAN din fixtures nu trece mod-97.
8. IBAN-urile tăiate pe mai multe rânduri sau scrise cu litere mici se elimină din descrieri.

## 2. Ce s-a implementat în F7-B

- **Migrația `0014_statement_uploads`:**
  - `statement_uploads` ține PDF-urile până la worker, cel mult 24 h. E un tabel separat de `documents` (ADR 0018 §11).
  - `receipt_match_rejections` memorează potrivirile respinse.
  - `recurring_suggestion_dismissals` memorează propunerile respinse.
  - Pe `receipts`: indexul unic „un bon per tranzacție” și triggerul `receipts_check_transaction` (bonul se leagă doar de o cheltuială vizibilă).
  - Triggerul de pe `statement_usage_daily`.
  - 5 funcții SECURITY DEFINER pentru coadă și curățare, care întorc doar identificatori.
- **Workerul:**
  - joburile `statement.sweep` și `statement.parse`, cu concurență 1, încercările plafonate la 3 și doar id-uri în `pgboss.job`;
  - curățarea e inclusă în `finet-admin cleanup-documents`: PDF-urile expirate sau eșuate și previzualizările neconfirmate mai vechi de 7 zile.
- **Serviciile:**
  - încărcarea (`uploads.service.ts`): CSV/XLSX cu mapare, fără stocare; PDF prin coadă; ZIP cu un rezultat pentru fiecare fișier;
  - potrivirea bon ↔ tranzacție (`src/modules/matching/`);
  - plățile recurente detectate (`src/modules/recurring/suggestions*.ts`).
- **API-ul `/api/v1`**, 16 operații noi, cu `docs/openapi.json` regenerat:
  - `/statements/uploads` (exclusă din proxy, cu `guardAccess` pe calea fixă), `/statements/uploads/{id}`;
  - `/statements/imports`, `/statements/imports/{id}`, `…/confirm` (cu Idempotency-Key), `…/cancel`;
  - `/statements/coverage`;
  - `/receipts/{id}/matches`, `/matches`;
  - `/recurring/suggestions`, `…/{signature}/accept` (cu Idempotency-Key), `…/{signature}/dismiss`.
- **Interfața:**
  - `/import` are filele „Bon fiscal” și „Extras bancar”; fila de extras include alegerea coloanelor și urmărirea PDF-ului în coadă;
  - `/statements`: lista importurilor, cu anulare și decizie explicită pentru tranzacțiile modificate;
  - `/statements/[id]`: soldurile, avertismentele, tranzacțiile în așteptare ignorate, tabelul cu duplicatele marcate, excluderea rândurilor, schimburile valutare și confirmarea cu Idempotency-Key;
  - `/statements/coverage`: conturi × 12 luni, cu text în fiecare celulă și avertizarea pentru lunile lipsă;
  - `/receipts/matches` (coada) și panoul de potrivire în `/receipts/[id]`;
  - propunerile de plăți recurente în `/recurring`;
  - „Extrase” în navigare.
- **E2E:** `e2e/statements.spec.ts`, proiectul `statements`. Utilizatorii `statements`, `statements2` și `statements3` sunt adăugați în `e2e/fixtures.ts` și în seed-ul CI.

## 3. Teste rulate local

Toate pe PostgreSQL 17 efemer (`finet-ci-pg-f7b`, `--memory=320m`, rețeaua `finet-ci-net-f7b`), cu procese Node plafonate la 0,9–1,4 GB.

| Comandă | Rezultat |
|---|---|
| `vitest run src/modules/statements/statements.test.ts` (15, inclusiv corecțiile F7-A) | PASS |
| `vitest run src/db/statement-uploads-rls.test.ts` (9) | PASS |
| `vitest run src/modules/statements/uploads.test.ts` (7, cu procesul copil PDF real) | PASS |
| `vitest run src/modules/matching/matching.test.ts` (6) | PASS |
| `vitest run src/app/api/v1/statements-api.test.ts` (5) + `src/proxy.test.ts` + `src/openapi/openapi.test.ts` | PASS (53) |
| `vitest run src/app/api/v1/idempotency.test.ts receipts-api.test.ts documents-api.test.ts` | PASS (27) |
| `vitest run src/db/migrate.test.ts` (36, inclusiv 0014 static și incremental) | PASS |
| `vitest run src/modules/statements/parsers.test.ts coverage-dedup.test.ts files.test.ts` | PASS |
| `vitest run src/modules/matching/score.test.ts src/modules/recurring/suggestions.test.ts src/app/_lib/statements-ui.test.ts src/app/a11y-rules.test.ts` | PASS |
| `vitest run src/modules/documents/retention.test.ts` | PASS rulat singur; o rulare sub încărcare a dat timeout (69 s) |
| pg_dump → restore pe PG17 după 0014: politici, constrângeri, funcții, triggere, indecși | identice; ACL-urile a trei tabele mai vechi apar altfel (nu țin de 0014) |
| Parserele pe cele 4 extrase reale, local, prin procesul copil real (doar agregate) | toate `balance: ok` după corecțiile F7-A |
| `node scripts/openapi.mjs --check` | PASS |
| `tsc --noEmit` țintit (tsconfig temporar) pe fișierele F7-B, inclusiv paginile și E2E | PASS |
| `eslint` + `prettier --check` pe fișierele atinse | PASS |
| `playwright test --list --project=statements` | 5 teste listate |
| E2E `statements` (browser) | NOT RUN local (memoria gazdei; rulează în CI; partea cu PDF și potrivire cere workerul + serverul AI fals) |
| `pnpm test` complet, `tsc` complet, `next build`, bugetul JS | NOT RUN local (memoria gazdei, ~1 GB; rulează în CI) |

## 4. Decizii F7-B (detalii în ADR 0018 §11 și ADR 0019)

- PDF-urile stau într-un tabel separat (`statement_uploads`), nu în `documents`. Motivele: vizibilitatea conturilor personale, coada AI a bonurilor și retenția bonurilor.
- CSV/XLSX sunt fără stare: cererea se retrimite împreună cu maparea, deci nu se păstrează nimic.
- Cota zilnică se consumă la încărcare, inclusiv pentru fișierele refuzate. Reîncărcarea aceluiași fișier consumă și ea.
- Curățarea e inclusă în `cleanup-documents`, deci nu e nevoie de cron nou. Rândurile de curățat se tratează prin funcții SECURITY DEFINER, ca să nu rămână fișiere orfane când autorul a plecat din gospodărie.
- Potrivirea caută doar printre cheltuielile din extras. Un bon deja salvat își pierde tranzacția duplicat la confirmare, dar doar dacă aceasta nu are etichete și nu e împărțită.
- Toleranțele propunerilor: ±10% la sumă; intervale de 6–8, 27–34 și 358–372 de zile; minimum 3 apariții (2 la anual).
- Importurile nu trimit evenimente live: un import atinge multe tranzacții.
- Revolut cu mai multe monede în același PDF se refuză (`multi_currency_statement`).

## 5. Puncte deschise pentru operator și coordonator

- **`0013` + `0014` pe Supabase** (INFRA 4l), cu verificarea dinainte a indexului unic pe `receipts`. Programarea `finet-cleanup` (4i) devine obligatorie: fără ea, PDF-urile neconfirmate rămân pe disc.
- **Istoricul git:** commit-ul `934c152` (F7-A, publicat) conține într-un comentariu, șters ulterior din fișier, un cuvânt care apare în extrasul BRD real. Cuvântul nu mai e nicăieri în tree. Decizia îi aparține coordonatorului.
- **Posibil defect latent în F6:** `receiveMultipart` (bonuri) folosește `parts: maxFiles + TEXT_FIELDS.length`, iar busboy semnalează `partsLimit` deja la atingerea plafonului. O cerere cu toate câmpurile și 4 fișiere ar putea fi refuzată. La extrase am folosit +1. De verificat separat.
- **Lista locală a leakcheck-ului:** am adăugat cuvinte românești și englezești generice din codul F7-B (în afara repo-ului).
- Băncile nu sunt „suportate” în sensul master promptului până nu există un fixture real anonimizat.
- Revizuirea `security` a F7-B.
