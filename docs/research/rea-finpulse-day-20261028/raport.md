# Raport REA – https://finpulse.day/

**Data:** 2026-10-28
**Instrument:** skill `reverse-engineer-anything` (repo `morluto/rea`, commit `b9a8f8e9`), CLI `rea-agents` 6.8.0, Node 22.23.4 (nvm, doar pentru user `claude`)
**Operație:** `analyze-javascript-application`, `--detail summary`
**Evidence ID (părinte):** `ev_46025368375baf712d86a6b9864ac96d98685a6e111df752d730a25924e13ac1`
**Digest SHA-256 al intrării analizate:** `12339b69aa58278f127be95d53de02e914eed0f7654962e017915609740be060`

## 1. Domeniu și metodă

- Analiză **statică**. Codul JavaScript și HTML-ul au fost parsate ca text inert, nimic nu a fost executat.
- S-au descărcat doar resurse publice, aceleași pe care le încarcă un browser: pagina `/`, 17 fișiere din `/_next/static/` (aprox. 1,4 MB) și `robots.txt`.
- Nu s-a apelat niciun endpoint `/api/*` și nu s-a făcut nicio autentificare.
- Prima rulare pe toate cele 17 fișiere a expirat după 400 s, la fișierul 8 din 17, pe un host cu puțină memorie liberă. A doua rulare a acoperit doar fișierele specifice aplicației, cu heap Node plafonat la 1,5 GB:

| Analizat (6 fișiere + `index.html`) | Neanalizat |
|---|---|
| `app/layout-*.js`, `app/page-*.js`, `app/error-*.js`, `app/global-error-*.js`, `webpack-*.js`, `main-app-*.js` | 11 chunk-uri vendor/partajate (`4648-*`, `2560-*`, `445-*`, `4bd1b696-*`, `1255-*`, `44530001-*`, `polyfills-*`, `4799-*`, `5747-*`, `2619-*`) |

- Statistici: 18 module, 272 constatări, 25.416 noduri AST vizitate, 170.226 octeți de text citiți, 0 erori de parsare.

## 2. Constatări observate

### 2.1 Aplicație

- Framework: Next.js, App Router. Răspunsul are `x-powered-by: Next.js` și `x-nextjs-prerender: 1`.
- Front: Cloudflare (`server: cloudflare`).
- Titlu: „FINpulse/day – Financial Pulse & Management".
- Descriere: „FINpulse/day – Smart Personal & Family Financial Manager".

### 2.2 Rute în codul client (20)

`/`, `/admin`, `/dashboard`, `/export`, `/goals`, `/help`, `/import`, `/login`, `/pricing`, `/privacy`, `/receipts`, `/recurring`, `/reports`, `/settings`, `/shopping-lists`, `/terms`, `/manifest.json`, `/favicon.ico`, `/favicon-32.png`, `/apple-touch-icon.png`.

Inventarul de rute acoperă doar sursele furnizate. REA îl marchează ca parțial pentru rutele de aplicație.

### 2.3 Apeluri de rețea (`fetch`), toate în `app/layout-*.js`

| Endpoint | Apariții | Răspuns |
|---|---|---|
| `/api/upload-queue` | 2 | citit ca JSON |
| `/api/feedback` | 1 | citit ca JSON |
| `/api/bug-reports` | 1 | citit ca JSON |

Metoda HTTP, corpul cererii și anteturile nu au fost recuperate static.

### 2.4 Consimțământ și analytics

- Cheie de consimțământ cookie: `finpulse_cookie_consent`.
- Google Analytics 4: `G-CDYQVCCGQ0`. ID-ul e public prin natura lui.

### 2.5 Timere

| Întârziere | Fișier |
|---|---|
| 5000 ms (de 2 ori) | `layout`, lângă apelurile `/api/upload-queue` |
| 120000 ms | `webpack` |
| 350 ms, 600 ms, 4500 ms | `layout` |

### 2.6 Alte elemente

- Granițe de date: 11 coerciții (`String`, `parseInt`) și 1 `JSON.parse` în `layout`.
- Fără IPC, fără punți de context, fără procese copil și fără module native. Aceste categorii sunt specifice Electron/Node și nu se aplică unui site web.

### 2.7 Anteturi HTTP ale paginii principale (din `curl`, nu din REA)

- `x-frame-options: DENY`
- `x-content-type-options: nosniff`
- `strict-transport-security: max-age=63072000; includeSubDomains; preload`
- `referrer-policy: strict-origin-when-cross-origin`
- `permissions-policy: camera=(self), microphone=(), geolocation=()`
- `content-security-policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`. Politica nu are `script-src`, deci nu restricționează sursele de scripturi.

### 2.8 `robots.txt`

Permite `/`, `/pricing`, `/help`, `/terms`, `/privacy`. Interzice `/api`, `/dashboard`, `/receipts`, `/reports`, `/shopping-lists`, `/recurring`, `/goals` și alte secțiuni private.

## 3. Deducții (neconfirmate)

- `/api/upload-queue` pare o coadă de încărcare a bonurilor. Indiciile sunt numele rutei, ruta `/receipts` și timerul de 5 s, care sugerează reîncercări sau polling.
- Timerele de 350, 600 și 4500 ms sunt probabil debounce și afișare de notificări în interfață. Culorile și emoji-urile de severitate din `layout` susțin ipoteza.
- Rutele `/receipts`, `/shopping-lists`, `/recurring`, `/goals`, `/reports`, `/import` și `/export` indică funcții de bonuri, liste de cumpărături, cheltuieli recurente, obiective, rapoarte și import/export de date.

## 4. Necunoscute și limite

- Cele 11 chunk-uri vendor nu sunt analizate. Biblioteci, apeluri suplimentare de rețea și folosirea storage-ului (`localStorage`, IndexedDB) pot fi acolo.
- Cele 9 scripturi inline din `index.html` nu sunt analizate. Endpoint-uri sau storage din ele lipsesc din evidență.
- Nu se știe ce face `/admin`. Pagina e doar referită în codul client, iar logica de acces e pe server.
- Backend, autentificare, validări și model de date nu apar în bundle.
- Nu s-a observat comportament la rulare: nicio cerere trimisă, nicio sesiune, niciun răspuns de server.
- Graful aplicației are acoperire parțială: 1 necunoscut în graful aplicației și 5233 în graful semantic. Absența unei constatări nu dovedește absența din cod.
- Existența unei rute în cod nu dovedește că e accesibilă sau funcțională.

## 5. Pași următori posibili

1. Analiza celor 11 chunk-uri vendor, pe rând, ca să nu depășească memoria hostului.
2. Analiza celor 9 scripturi inline din `index.html`.
3. Captură de browser (`capture_browser_scenario`) pentru metode HTTP, corpuri de cerere și storage. Se face doar dacă site-ul e al utilizatorului sau există permisiune de testare.

## 6. Fișiere

- Rezumat REA: `/home/claude/rapoarte/rea-finpulse-day-20261028/rea-app-summary.json`
- Evidența completă (31 MB): `/tmp/claude-1009/-home-docker-apps/167bc42c-6b9a-4aa7-95a1-b76de57d2633/scratchpad/finpulse/evidence-app.json`. E în scratchpad, deci temporară.
- Bundle descărcat: `…/scratchpad/finpulse/site/`. Subsetul analizat: `…/scratchpad/finpulse/app-only/`. Ambele sunt temporare.
