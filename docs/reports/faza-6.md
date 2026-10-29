# Raportul Fazei 6 — Ingestia bonurilor (F6-A, F6-B, F6-C)

- **Branch:** `phase/06-receipts` (din `main`, `a3c1479`). **Data:** 2026-10-29. **Autor:** programmer (F6-A, F6-B, F6-C).
- **Decizii:** ADR 0013 (ingestie, stocare, preprocesare), ADR 0014 (pipeline-ul AI) și ADR 0015 (API-ul public, paginile Import/Bonuri, retenția).
- **Stare:** implementat în repo. Typecheck-ul complet, build-ul și suita completă rulează în CI. Migrațiile `0008`–`0011`, cheia LiteLLM, alias-urile și programarea retenției sunt de făcut de operator (`docs/INFRA.md` 4h, 4h-bis, 4i).

## 1. Ce s-a implementat în F6-B

- `src/lib/ai/`:
  - clientul LiteLLM: anti-SSRF, timeout real, reîncercări limitate, citire plafonată, parsare cu plafoane;
  - estimarea costului în bigint;
  - serverul AI fals.
- `src/modules/receipts/`:
  - schema Zod strictă a răspunsului (sumele ca șiruri → bigint);
  - verificările 5.5 (sume, SGR, reduceri, CUI, dată, TVA după dată) și scorul calculat în cod;
  - normalizarea numelor și categorisirea (alias → reguli → LLM cu listă închisă);
  - unirea bonului lung, prompturile fixe.
- Migrația `0009_receipt_pipeline`:
  - pe `receipts`: `issues`, `duplicate_of_receipt_id`, `merge_report`, motivul `ai_unconfigured`;
  - `vat_rates` cu seed;
  - bugetul global `ai_budget_usage`, cu funcțiile SECURITY DEFINER `ai_budget_reserve` și `ai_budget_spent`;
  - `queued_document`.
- Workerul:
  - joburile `receipt.sweep` (la minut) și `receipt.process` (`exclusive`, pe document);
  - consimțământul verificat înaintea oricărui apel;
  - bonul salvat mereu „De verificat”;
  - deduplicarea după CUI + număr + dată + total;
  - termenul documentului de 12 minute.
- Configurația `AI_*` (cheia doar din fișier, doar în worker), secretul `finet_litellm_key` doar pentru `finet-worker`.
- Fixtures sintetice (`scripts/make-receipt-fixtures.mjs`, `fixtures/receipts/ground-truth.json`) și `pnpm eval:receipts`.

## 2. Evaluarea (doar pe date sintetice)

> **Bonurile sunt SINTETICE.** Acuratețea de aici NU înlocuiește evaluarea pe bonuri reale, care rămâne de făcut de operator. Abia după ea se aleg modelele (3.6).

| Mod | Bonuri | Total | Dată | CUI | Linii (F1) | Categorii | „De verificat” | Timp mediu | Cost estimat |
|---|---|---|---|---|---|---|---|---|---|
| **mock** (server AI fals, 2026-10-29) | 8 | 87,5% | 100% | 100% | 1,00 | 100% | 12,5% | ~230 ms (fără model) | 18 unități minore USD, din tokenii ficși ai serverului fals |
| **real** (LiteLLM, `AI_EVAL=1`) | — | NOT RUN | | | | | | | |

**Cum se citește modul mock:** serverul fals întoarce adevărul, cu o eroare intenționată pe `zgomot-estompat` (total +1 leu). Rezultatul măsoară traseul: preprocesarea (inclusiv PDF-ul în procesul copil), parsarea, unirea bonului lung cu suprapunere, verificările, scorul și categorisirea. Bonul cu eroarea intenționată e prins de verificarea sumei și trece „De verificat”. Modul mock nu spune nimic despre calitatea unui model.

**Modul real** nu a fost rulat: agentul nu atinge LiteLLM-ul real. Pașii operatorului sunt în INFRA 4h-bis, pasul 6.

## 3. Limite cunoscute

- Nu există bonuri reale de evaluare, iar alegerea modelului e amânată.
- `json_schema` nu e verificat pe LiteLLM → Gemini; plasa de siguranță e `AI_RESPONSE_FORMAT=json_object`.
- Cota de 5% e valabilă doar până la 2025-07-31, conform Legii 141/2025, deci diferă de brief. Detalii și surse în ADR 0014.
- Neimplementate:
  - salvarea automată;
  - notificarea administratorului la epuizarea bugetului;
  - unirea automată a încărcărilor separate cu același bon.

  Toate trei sunt în ROADMAP.
- Rezervarea pesimistă a bugetului consumă bugetul mai repede decât costul real (fail-closed).

## 4. Ce s-a implementat în F6-C (ADR 0015)

- **API `/api/v1`** (OpenAPI regenerat, `docs/API.md`):
  - documentele: `POST /documents` (ruta publică a handlerului F6-A), `GET /documents`, `GET /documents/{id}`, `GET /documents/{id}/file` (flux, antete fixe), `DELETE /documents/{id}`, `GET /ai/usage`;
  - bonurile: `GET /receipts` (filtre, căutare după magazin/produs/sumă, cursor), `GET /receipts/{id}`, `PATCH` (verificările recalculate, `product_aliases`), `POST …/confirm` (→ o tranzacție `source=receipt`), `POST …/reprocess` (consumă limita zilnică), `DELETE`;
  - `PUT /me/consents` cu `externalAi` pune în coadă documentele care așteptau; `Transaction.documentId`;
  - SQLSTATE 22021 → 400 cu mesaj fix (cererea coordonatorului).
- **Proxy-ul și încărcarea:** `/api/v1/documents` exact e exclusă din matcher-ul `src/proxy.ts` (Next 16 ar copia corpul în memorie și l-ar trunchia la 10 MB), iar ruta refăce aceeași verificare Cloudflare Access și aceleași antete (`src/lib/access-guard.ts`), înainte de sesiune și de corp.
- **UI:** `/import` (zona de încărcare, contorul zilei, „Mod bon lung” cu reordonare prin butoane, mesajul de consimțământ, starea pe document cu polling blând), `/receipts` („De verificat” sus, istoricul cu toate categoriile, căutarea, acțiunile), `/receipts/[id]` (ecranul de verificare), comutatorul „Citirea bonurilor cu AI” în `/profile`, insigna „din bon” și „Vezi bonul”, „Scanează” în bara de jos pe telefon (în locul lui „Bugete”, mutat în „Mai mult”).
- **Retenția:** migrația `0011_document_retention` (`expired_documents`, SECURITY DEFINER) și `admin cleanup-documents` (originalele expirate, apoi fișierele temporare orfane) în serviciul one-shot `finet-cleanup` (singurul cu storage-ul în scriere în afara web-ului).
- **Workerul:** raportul unirii bonului lung păstrează și numele liniilor eliminate (≤ 80 de caractere), afișate tăiate pe ecranul de verificare; `queueAwaitingConsent` nu mai pune în coadă documente al căror original a fost șters la retenție.
- **E2E:** proiectul `receipts` (`e2e/receipts.spec.ts`) cu serverul AI fals ca proces (`e2e/ai-mock-server.mjs`) și workerul real, pornite de CI în fundal cu secrete fictive; `access.spec.ts` verifică ruta exclusă din proxy pe serverul de producție.

## 5. Teste F6-C

Gazda avea ~0,9–1,1 GB RAM liber: nimic din `next build`, `tsc` complet, suita completă sau E2E nu a rulat local (CI).

| Comandă (în `node:24`, PostgreSQL 17 efemer `--memory=256m`, rețea privată) | Rezultat |
|---|---|
| `vitest run` pe 33 de fișiere (API documente/bonuri, documente, ledger, tranzacții, me, recurring, planning, rute, OpenAPI, proxy, UI, reguli UI/a11y, serverul AI fals, CLI admin, migrații, grant-uri) | **PASS** — 33 fișiere, 430 de teste |
| `receipts-api.test.ts` (12 teste: izolare, căutare „45,90”/„45.90”, corectare, confirmare, duplicat, reprocesare + limită, ștergere, 11 MB → `file_too_large`, paginare) | **PASS** |
| `retention.test.ts`, `migrate.test.ts` (0011 de la zero, incremental peste 0000–0010, idempotent) | **PASS** |
| `node scripts/openapi.mjs` + `openapi.test.ts` | **PASS** (`docs/openapi.json` regenerat) |
| `sh ops/docker/test-env-examples.sh` | **PASS** (115 verificări) |
| `eslint --max-warnings=0` + `prettier --check` pe fișierele atinse | **PASS** |
| `playwright test --list --project=receipts --project=access` | **PASS** (7 + 13 teste listate) |
| `playwright test` (E2E real), `next build`, `pnpm check:bundle`, `tsc --noEmit`, suita completă | **NOT RUN** local (memoria gazdei); rulează în CI |

## 6. Decizii F6-C (detalii în ADR 0015)

- Excluderea rutei din proxy în loc de `proxyClientMaxBodySize ≈ 41 MB` (memoria web-ului; corpul ar fi stat în memorie pentru orice rută).
- O tranzacție per bon; categoria = cea aleasă sau cea cu suma cea mai mare; diferența linii/total nu blochează confirmarea; duplicatul cere confirmare explicită.
- Reprocesarea consumă limita zilnică și are limită proprie de cereri.
- Ștergerea bonului șterge și pozele; tranzacția rămâne.
- Previzualizarea prin `data:` (CSP neschimbat, fără `blob:`).
- „Scanează” în locul lui „Bugete” pe telefon.
- `finet-cleanup` separat de `finet-admin` (privilegiul minim pe storage).
- E2E-ul bonurilor doar în modul `personal`.

## 7. Riscuri și puncte deschise (F6-C)

- E2E-ul bonurilor depinde de cron-ul `receipt.sweep` (un minut): plafoane de câteva minute pe test; o rulare lentă în CI poate depăși (reluare automată o dată).
- Bugetul JavaScript al paginilor noi (`/receipts/[id]` are cel mai mare client) e verificat doar în CI.
- Unirea automată a două încărcări separate cu același bon nu există (se folosește „Mod bon lung”).
- Programarea `finet-cleanup` (cron) e la operator; până atunci originalele cu EXIF/GPS rămân pe disc după retenție.
- Revizuirea `security` a F6-C: de făcut.

