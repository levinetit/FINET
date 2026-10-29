# Raportul Fazei 9 — Hardening, PWA și offline

Branch `phase/09-hardening` (din `main` 67b1c0c). Faza are două părți: **F9-A** (PWA, service worker, scanarea offline, ghidul, pagina Android; ADR 0020) și **F9-B** (export/ștergere GDPR, „Statistici”, upgrade Postgres, audit Lighthouse/a11y, dovezile din SECURITY_CHECKLIST). Acest document conține deocamdată secțiunea F9-A.

## F9-A — PWA, service worker, scanare offline, ghid, Android

### 1. Ce s-a implementat

- **Manifest și iconițe:** `public/manifest.webmanifest` (`start_url` `/dashboard`, `standalone`, `portrait`, `lang` `ro`, culorile temei, scurtătura „Scanează”), iconițe `any` + `maskable` 192/512 și `apple-touch-icon` 180 (opac), generate determinist de `scripts/make-pwa-icons.mjs` din simbolul logoului. `<link rel="manifest" crossOrigin="use-credentials">` scris manual în `src/app/layout.tsx` (cererea implicită nu trimite cookie-ul Access), `appleWebApp` și iconițele în metadate.
- **Service worker:** `src/pwa/sw-source.ts`, servit de `src/app/sw.js/route.ts` (`no-cache`, `Service-Worker-Allowed: /`), versionat cu `BUILD_ID`. Cache-first doar pentru asset-uri statice; navigări doar prin rețea, cu `/offline` la eșec de rețea; fără `respondWith` pe API/non-GET/alte origini; precache validat; curățarea versiunilor vechi; plafon de intrări; actualizare doar la clic (banner, `SKIP_WAITING`, amânată cu formular necomis).
- **`/offline`:** HTML static (`src/pwa/offline-page.ts`, `src/app/offline/route.ts`) + `public/pwa/offline.{css,js}`, compatibil cu CSP-ul cu nonce din cache; arată numărul scanărilor în așteptare.
- **Scanarea offline:** `src/app/_lib/offline-scans.ts` (logica pură), `offline-scans-idb.ts` (IndexedDB), `offline-scans-client.ts` (orchestrarea: pornire, `online`, Background Sync ca semnal, backoff, Web Locks); integrarea în `/import` (bannerul offline, „Păstrează pentru mai târziu”, lista „În așteptare pe acest dispozitiv” cu „Reîncearcă”/„Șterge”), `OfflineSync` în layout-ul autentificat, ștergerea bazei la deconectare (`app-nav.tsx`).
- **Server:** reîncercarea EXACTĂ a unui bon lung → 200 duplicat (`documents.service.ts`, `exactLongReceiptBatch`; `documents.repo.ts`, `countBatchDocuments`). Fără migrație.
- **Instalare și ghid:** invitația de instalare (`InstallPrompt`: Chromium/Android cu `beforeinstallprompt`, iOS cu instrucțiuni; închisă definitiv prin `localStorage`, în try/catch), `/help` (conturi, tranzacții, bonuri, extrase „în curând”, familie, instalare, întrebări frecvente), `/settings`, „Setări” și „Ajutor” în navigare.
- **Android:** `GET /api/v1/app/android/latest` (`src/app/api/v1/_lib/app-handlers.ts`, `src/modules/app-release/android.ts`; sursa `<STORAGE_DIR>/app/android-latest.json`), în OpenAPI (`getAndroidLatest`, tagul `app`) și `docs/API.md`; pagina `/settings/android` cu cod QR generat local (`src/lib/qr.ts`).
- **Documentație:** ADR 0020, SECURITY_CHECKLIST §21, PRIVACY_NOTES („PWA și scanarea offline”), INFRA 4l, API.md, ROADMAP.

### 2. Teste rulate local

Mediu: `node:24` în container (`--memory` 500–950 MB), PostgreSQL 17 efemer `finet-ci-pg-f9` (`--memory=256m`) pe rețeaua `finet-ci-net-f9`, șterse la final.

| Comandă | Rezultat |
|---|---|
| `vitest run src/pwa src/lib/qr.test.ts src/app/_lib/offline-scans.test.ts src/app/_lib/pwa-ui.test.ts src/app/api/v1/app-api.test.ts src/openapi src/proxy.test.ts src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/contrast.test.ts src/app/smoke.test.ts src/app/api/routes.test.ts src/app/_lib/chunk-recovery.test.ts` (cu PG) | PASS (14 fișiere, 143 de teste) |
| `vitest run src/modules/documents/documents.test.ts src/app/api/v1/documents-api.test.ts src/proxy.test.ts` (cu PG) | PASS (3 fișiere, 71 de teste) |
| `node scripts/openapi.mjs` apoi `--check` | PASS (`docs/openapi.json` regenerat, +1 operație) |
| `tsc --noEmit` pe un tsconfig temporar cu fișierele sursă F9-A (fără teste și E2E) | PASS |
| `eslint --max-warnings=0` pe fișierele atinse (inclusiv teste, E2E, `public/pwa/offline.js`) | PASS |
| `prettier --write` pe fișierele atinse | aplicat |
| `playwright test --list --project=pwa --project=access` | 6 teste `pwa` + 14 `access` listate |
| QR: vectori comparați modul cu modul cu python-qrcode 8.2 (7 cazuri, v1–v10, măști 0–7) | PASS |
| E2E `pwa` și `access` (browser / server de producție) | NOT RUN local (memoria gazdei; `next build` interzis local) — rulează în CI |
| `pnpm test` complet, `tsc` complet, `next build`, `check:bundle` | NOT RUN local (regula F9-COMUN; CI) |
| axe / Lighthouse pe paginile noi | NOT RUN (`@axe-core/playwright` nu e instalat; F9-B) |

### 3. Decizii („decizia mea”)

- Nicio excepție nouă de la Access; iconițele cerute fără cookie la instalare = risc acceptat, cu varianta de bypass exact documentată pentru operator (ADR 0020 §1).
- `/offline` ca HTML static, nu pagină React (nonce înghețat în cache, chunk-uri lipsă).
- În dezvoltare SW-ul nu pune în cache `/_next/static`.
- Fără `fake-indexeddb` (arbore `node_modules` comun cu Faza 7): abstracția `ScanStore` + `MemoryScanStore`; IndexedDB real în E2E.
- Plafoanele cozii: 10 încărcări, 50 MB, 7 zile, doar JPEG/PNG.
- Owner = utilizator + gospodăria activă; alți utilizatori → șterse la pornire; aceeași persoană, altă gospodărie → păstrate, încărcate după comutare; deconectare → `deleteDatabase`.
- Fără `Idempotency-Key` la încărcare (SHA-256); reîncercarea exactă a bonului lung devine 200 duplicat.
- Metadatele Android într-un fișier cu cale fixă sub `STORAGE_DIR` (fără variabilă nouă); 404 `android_release_unavailable` când lipsesc.
- Codul QR fără dependență (generator propriu, verificat cu o bibliotecă independentă).
- „Setări” = pagină nouă `/settings` (profilul rămâne `/profile`).

### 4. Puncte deschise

- Rularea E2E `pwa`/`access` și `check:bundle` în CI (componentele PWA sunt în layout → câțiva KiB pe toate rutele autentificate).
- Background Sync doar trezește paginile deschise; fără pagină deschisă, încărcarea are loc la următoarea deschidere.
- Linkul APK servit de FINET după autentificare (repository privat, promptul Android 12.1): nefăcut; `url` trebuie să fie https (GitHub Releases).
- Audit axe/Lighthouse și revizuirea `security`: F9-B / agenții de revizuire.
