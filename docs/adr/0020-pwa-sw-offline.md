# ADR 0020 — PWA, service worker și scanarea offline

- **Stare:** propus (F9-A, branch `phase/09-hardening`). Deploy: operatorul, după revizuiri (`docs/INFRA.md`, „4l”).
- **Legături:** master prompt Faza 9 (7), 3.1 (Cloudflare Access), 6.3 (antete, CSP), 6.4 (API); promptul Android 12.1; ADR 0003 (CSP cu nonce), 0010 (recuperarea chunk-urilor), 0013–0015 (documente, bonuri). ADR 0018–0019 sunt rezervate Fazei 7.

## Context

Faza 9 cere: manifest PWA, iconițe și ghid de instalare (iOS, Android), invitație de instalare care se poate închide definitiv, un service worker care pune în cache DOAR asset-urile statice și pagina `/offline` (care trebuie să existe), scanarea bonurilor fără rețea (IndexedDB, încărcare automată la reconectare, ștergere locală după confirmarea serverului, starea „în așteptare” vizibilă), ghidul `/help`, pagina „Setări → Aplicația Android” și `GET /api/v1/app/android/latest`.

Constrângeri: CSP cu nonce per cerere (ADR 0003), Cloudflare Access pe TOATE căile (fail closed, `src/lib/access.ts`), fără dependențe noi care cer instalare în arborele `node_modules` comun (alt agent lucrează în paralel; memoria gazdei ~1 GB).

## Decizii

### 1. Cloudflare Access: nicio excepție nouă

Toate fișierele PWA (`/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/offline`, `/pwa/*`) și `GET /api/v1/app/android/latest` trec prin `src/proxy.ts` ca orice cale: fără JWT Access → 403 (testat în `src/proxy.test.ts` și în `e2e/access.spec.ts`, pe serverul de producție). Analiza cererilor browserului:

| Cerere | Cookie-ul Access (`CF_Authorization`) | Concluzie |
|---|---|---|
| scriptul SW (`register`, verificarea de actualizare) | da: cerere same-origin, credențiale `same-origin` | merge prin Access |
| precache-ul de la instalare (`fetch` din SW) | da (`credentials: "same-origin"`) | merge; instalarea are loc cât utilizatorul e logat |
| `<link rel="manifest">` | **nu**, implicit (`credentials: omit`) | rezolvat cu `crossOrigin="use-credentials"` (legătura e scrisă manual în `src/app/layout.tsx`; `metadata.manifest` din Next pune atributul doar pe Vercel preview) |
| iconițele din manifest (instalarea în Chromium), `apple-touch-icon` (iOS) | depinde de browser (nu e garantat) | **limitare acceptată**: dacă browserul le cere fără cookie, primește pagina Access / 403 și folosește o iconiță generică; datele nu sunt afectate. Dacă operatorul vrea iconițele garantat, poate adăuga în Cloudflare o politică *Bypass* DOAR pe căile exacte `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-192.png`, `/icons/icon-maskable-512.png`, `/icons/apple-touch-icon.png` și `/manifest.webmanifest` (fișiere statice, fără date); aplicația ar cere atunci și o excepție exactă în `isRequestAllowed` (GET/HEAD, listă fixă, teste pentru variantele codificate) — NU e făcută acum (decizia mea: fără slăbirea verificării înainte de o nevoie dovedită). |
| `/offline` afișată fără rețea | nu există cerere: răspunsul vine din cache-ul SW | nimic de deschis |

### 2. Service worker (`/sw.js`)

- **Sursa:** `src/pwa/sw-source.ts` (JavaScript simplu, ca text), servit de ruta `src/app/sw.js/route.ts` cu `Content-Type: text/javascript`, `Cache-Control: no-cache`, `Service-Worker-Allowed: /`; înregistrat cu `updateViaCache: "none"`. Testele (`src/pwa/sw.test.ts`) rulează EXACT textul servit într-un `node:vm`.
- **Versiunea** = `BUILD_ID`-ul Next (`.next/BUILD_ID`, prezent și în `standalone`), deci fiecare deploy schimbă octeții scriptului → actualizare detectată; în dezvoltare `dev`. Cache-ul static: `finet-static-<versiune>`; la activare se șterg celelalte cache-uri `finet-*`; plafon de 400 de intrări.
- **Rutare** (testată caz cu caz):
  - fără `respondWith` (rețeaua directă): orice non-GET, altă origine, `/api` și `/api/**` (inclusiv încărcarea multipart și SSE), RSC, orice cale necunoscută;
  - cache-first: `/_next/static/**` (DOAR în producție; în dezvoltare fișierele nu sunt imuabile), iconițele, manifestul, `/pwa/offline.{css,js}` (fără query);
  - navigări: doar rețea (cu navigation preload); la eșec de REȚEA → `/offline` din cache; un 4xx/5xx al serverului ajunge neschimbat la pagină;
  - în cache intră doar răspunsuri `200`, `basic`, neredirecționate, fără `no-store`/`private` și care nu sunt HTML (excepția: `/offline`). `Set-Cookie` nu e vizibil în SW (antet interzis): paginile cu sesiune sunt excluse după tip (navigare), după `Cache-Control` (Next pune `private, no-store` pe paginile dinamice) și după conținut (HTML), iar `/offline` nu citește sesiunea.
- **Precache la instalare:** `/offline`, `/pwa/offline.css`, `/pwa/offline.js`, manifestul, iconițele. Toate se validează ÎNAINTE de orice scriere; un răspuns nepotrivit (de exemplu pagina de login Access) oprește instalarea, browserul reîncearcă la următoarea vizită.
- **Actualizare controlată:** fără `skipWaiting()` automat. Versiunea nouă rămâne `waiting`; bannerul „Versiune nouă a aplicației disponibilă” (`ServiceWorkerRegistration`, `src/components/app/pwa.tsx`) trimite `SKIP_WAITING` doar la clic; cu un formular necomis (`data-dirty`, ADR 0010) cere întâi salvarea. Pagina se reîncarcă la `controllerchange` doar dacă reîncărcarea a fost cerută. Prima instalare preia pagina (`clients.claim`), fără banner.
- **CSP:** neschimbat. Înregistrarea (`worker-src` → `script-src 'self'`), manifestul (`default-src 'self'`) și pagina `/offline` (doar fișiere externe `'self'`) funcționează cu CSP-ul cu nonce.

### 3. Pagina `/offline`

HTML static (`src/pwa/offline-page.ts`, ruta `src/app/offline/route.ts`), în română, fără `<script>`/`<style>` inline și fără `style=` (un răspuns din cache are nonce-ul „înghețat”; testat), cu `/pwa/offline.css` și `/pwa/offline.js`. Scriptul citește din IndexedDB DOAR numărul încărcărilor în așteptare/cu eroare (nu creează baza, nu citește pozele, nu face cereri) și reîncarcă pagina la `online`.

### 4. Scanarea offline (`src/app/_lib/offline-scans*.ts`)

- **Depozit:** IndexedDB `finet-offline` / `scans`, o intrare = O cerere de încărcare (bonul lung își păstrează pozele și ordinea), pozele ca `Blob`. Abstracția `ScanStore` are două implementări: IndexedDB (browser) și `MemoryScanStore` (teste). Decizia mea: fără `fake-indexeddb` (dependență nouă în arborele comun; logica e testată pe abstracție, iar IndexedDB-ul real în E2E).
- **Când:** la `/import`, cu `navigator.onLine === false` sau dacă trimiterea eșuează cu eroare de rețea (Wi-Fi-ul magazinului poate „minți”). Doar JPEG/PNG (PDF-urile și WebP se încarcă online), fiecare sub `MAX_UPLOAD_MB`.
- **Plafoane (decizia mea):** 10 încărcări în așteptare, 50 MB în total, 7 zile (TTL). La `QuotaExceededError` scrierea (o tranzacție) e anulată întreagă; se curăță intrările expirate și ale altor utilizatori și se reîncearcă o dată; altfel mesaj „nu mai e spațiu”.
- **Sincronizare:** la pornire (componenta `OfflineSync` din layout-ul autentificat, pe toate paginile), la `online`, la mesajul Background Sync al SW (doar un semnal, unde există; coada nu depinde de el) și după pauza de reîncercare. O singură trecere odată: în filă (indicator), între file (Web Locks, dacă există).
- **Decizia după răspuns** (`decide`, testată):

| Răspuns | Acțiune |
|---|---|
| 2xx (201 nou; 200 duplicat) | ștergere locală |
| 401, 403 (sesiune sau Access expirate) | rămâne; trecerea se oprește, mesaj „autentifică-te” |
| rețea, 408, 429, 5xx | rămâne; reîncercare la 2 s, 4 s, 8 s … ≤ 5 min |
| 409 `daily_document_limit` | rămâne; reîncercare peste o oră |
| 400, 404, 409 (cota, bon lung parțial duplicat), 413, 415, 422 | „Nu a putut fi încărcat”, cu motivul; „Reîncearcă” / „Șterge” |

- **Fără `Idempotency-Key`:** încărcarea documentelor e idempotentă prin SHA-256 (ADR 0013), deci o retrimitere după un răspuns pierdut întoarce 200 `duplicate: true`. Pentru bonul lung, serverul răspundea 409 `long_receipt_duplicate`; F9-A adaugă **reîncercarea exactă**: aceleași poze, în aceeași ordine, același lot complet → 200 cu documentele existente (`created: 0`, același `batchId`); orice altă suprapunere rămâne 409 (`src/modules/documents/documents.service.ts`, `exactLongReceiptBatch`, testat pe PostgreSQL).
- **Confidențialitate (decizia mea):** fiecare intrare poartă `userId` și `householdId`; se încarcă DOAR când ambele coincid cu sesiunea (gospodăria activă). La pornire se șterg intrările altor utilizatori; intrările aceluiași utilizator pentru altă gospodărie rămân (vizibile, cu „Șterge”; se încarcă după comutarea înapoi). La **deconectare** baza `finet-offline` se șterge complet (`deleteDatabase`). Pozele nu trec prin cache-ul SW.

### 5. Instalare și ghid

- Manifest static (`public/manifest.webmanifest`: `start_url` `/dashboard`, `standalone`, `portrait`, `lang` `ro`, iconițe `any` și `maskable` 192/512, scurtătura „Scanează”), `apple-touch-icon` 180 px opac, `appleWebApp`. Iconițele sunt generate determinist de `scripts/make-pwa-icons.mjs` (sharp) din simbolul logoului (linia + moneda), fără text; varianta `maskable` în zona sigură.
- Invitația (`InstallPrompt`): Android/Chromium prin `beforeinstallprompt` (amânat), iPhone/iPad cu instrucțiunile Safari; nu apare în aplicația instalată; „Nu, mulțumesc” o închide definitiv (`localStorage`, în try/catch).
- `/help` (în zona autentificată, și în `personal`): conturi, tranzacții, bonuri, extrase („în curând” până la Faza 7), familie, instalarea PWA, întrebări frecvente (`<details>`). `/settings`: ghidul de instalare + legături (Android, profil, ajutor).

### 6. Aplicația Android

- `GET /api/v1/app/android/latest` (sesiune cookie sau bearer, ca tot `/api/v1`) → `{ data: { versionName, versionCode, minSupportedVersionCode, url, sha256, sizeBytes, notes, publishedAt } }`; fără versiune → 404 `android_release_unavailable`.
- Sursa: fișierul `<STORAGE_DIR>/app/android-latest.json`, scris de operator (sau de workflow-ul de release), citit la fiecare cerere (≤ 16 KiB), validat strict (https, sha256 hex, semver, `minSupportedVersionCode ≤ versionCode`); invalid → „indisponibil” și un log fără conținut. Decizia mea: o cale fixă sub `STORAGE_DIR` (existent pe ambele drivere de storage), deci fără variabilă de mediu nouă; APK-ul nu e în repository.
- `/settings/android`: versiunea, dimensiunea, suma, notele, butonul de descărcare, codul QR al aceluiași link și pașii de instalare. Codul QR e generat pe server de `src/lib/qr.ts` (fără dependență: mod byte, nivel M, versiunile 1–10), randat ca SVG `<path>` fără JavaScript; verificat modul cu modul față de python-qrcode 8.2 (vectori în `src/lib/qr.test.ts`).

## Consecințe

- Fără migrație nouă (nici `0014`), fără variabile de mediu noi, fără dependențe noi.
- Bugetul JS: componentele PWA și coada (`OfflineSync`) sunt în layout, deci pe toate rutele autentificate (câțiva KiB); `check:bundle` le verifică în CI.
- Limitări: iconițele pot lipsi la instalare dacă browserul le cere fără cookie Access (punctul 1); Background Sync doar trezește paginile deschise; fără pagini deschise, încărcarea are loc la următoarea deschidere a aplicației.
