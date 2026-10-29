# Raportul Fazei 6 — Ingestia bonurilor (început: F6-A, F6-B)

- **Branch:** `phase/06-receipts` (din `main`, `a3c1479`). **Data:** 2026-10-29. **Autor:** programmer (F6-A, F6-B). F6-C (API, UI, E2E) completează raportul.
- **Decizii:** ADR 0013 (ingestie, stocare, preprocesare) și ADR 0014 (pipeline-ul AI).
- **Stare:** implementat în repo. Typecheck-ul complet, build-ul și suita completă rulează în CI. Migrațiile `0008`/`0009`, cheia LiteLLM și alias-urile sunt de făcut de operator (`docs/INFRA.md` 4h, 4h-bis).

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
