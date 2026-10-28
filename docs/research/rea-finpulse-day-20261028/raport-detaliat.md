# Raport detaliat REA – https://finpulse.day/

**Data:** 2026-10-28
**Instrument:** skill `reverse-engineer-anything` (repo `morluto/rea`, commit `b9a8f8e9`), CLI `rea-agents` 6.8.0, Node 22.23.4 (nvm, user `claude`)
**Operație:** `analyze-javascript-application`, `--detail summary`, o rulare per fișier
**Completează:** `raport.md` din același director (analiza inițială a celor 6 fișiere ale aplicației)

## 1. Rezumat

finpulse.day este o aplicație Next.js (App Router) de finanțe personale și de familie, cu bonuri procesate de AI, bugete, obiective, rapoarte și abonamente plătite prin Stripe. Autentificarea și datele trec prin Supabase. Interfața e bilingvă (română și engleză), iar prețurile sunt în RON și EUR.

Pagina e un shell client-side (HTML-ul spune doar „Loading…"), deci aproape toată logica se vede în bundle-urile JS. Din ele rezultă:

- 4 planuri de abonament cu prețuri și limite exacte (secțiunea 4).
- 5 endpoint-uri `/api/*` apelate din browser (secțiunea 3).
- Un client Supabase cu cheie `anon` publică, ca în orice aplicație Supabase de browser.
- Cod de server în bundle-ul de browser: biblioteca Stripe pentru Node și configurația planurilor, care citește `STRIPE_SECRET_KEY` (secțiunea 6).

Totul e **analiză statică** a unor fișiere publice. Nu s-a executat cod, nu s-a apelat niciun `/api/*`, nu s-a interogat Supabase și nu s-a făcut autentificare.

## 2. Acoperire

Au fost descărcate 22 de fișiere statice și 6 pagini HTML publice (`/`, `/pricing`, `/help`, `/terms`, `/privacy`, `/login`).

| Fișier | Module | Constatări | Rol (observat sau dedus) | Evidence ID |
|---|---|---|---|---|
| `app/layout`, `app/page`, `app/error`, `app/global-error`, `webpack`, `main-app` | 18 | 272 | codul aplicației și runtime-ul webpack. Analizat în `raport.md` | `ev_46025368375baf712d86a6b9864ac96d98685a6e111df752d730a25924e13ac1` |
| `1255-60d8dc7c…` | 145 | 465 | bibliotecă partajată, neidentificată | `ev_636dd47f64bd77b6…` |
| `2560-b6e5bb1c…` | 1 | 4 | biblioteca Stripe pentru Node (observat, secțiunea 6) | `ev_bac6e008bc6b990c…` |
| `2619-04bc32f0…` | 7 | 21 | cod partajat, neidentificat | `ev_029b6703e61c5dab…` |
| `445-820b1955…` | 17 | 37 | client Supabase (55 de apariții „supabase", „GoTrue") | `ev_4790f5bb75593158…` |
| `44530001-5660b368…` | 1 | 13 | client Supabase (14 apariții „supabase", „GoTrue") | `ev_14d69d994e51b27a…` |
| `4648-f4151b61…` | 1 | 11 | conține „xlsx" (6×), „i18n" și „tallyo" (1× fiecare); biblioteca nu e identificată | `ev_26474cdd3cccc486…` |
| `4799-15e210ca…` | 5 | 41 | clientul Supabase al aplicației și configurația planurilor | `ev_e749ee6a801016984…` |
| `5747-45ec2ffd…` | 2 | 44 | widget de recomandări (referrals) | `ev_8b0aa222edfbf406…` |
| `app/pricing/page` | 6 | 44 | pagina de prețuri și apelul de plată | `ev_3f90ef7181953bb1…` |
| `app/login/page` | 7 | 45 | autentificare | `ev_f1ec2a8b228027e4…` |
| `app/help/page` | 2 | 10 | pagina de ajutor | `ev_a996969a10a083ee…` |
| `app/privacy/page` | 2 | 6 | politica de confidențialitate | `ev_a7a7277046d9f0a6…` |
| `app/terms/page` | 2 | 6 | termenii și condițiile | `ev_9629712c1ed286d2…` |

**Neanalizat:**
- `4bd1b696-100b9d70…` (173 KB). Conține mesajele de eroare React (`react.dev/errors`), deci este cel mai probabil React DOM. Analiza a expirat după 300 s (`Analysis operation timed out after 300000ms`), la a doua încercare nu s-a mai insistat.
- `polyfills-42372ed1…` (112 KB), omis intenționat.
- Chunk-urile rutelor private (`/dashboard`, `/receipts`, `/reports` etc.) nu sunt linkate public, așa că nu au fost descărcate. Nu am ghicit URL-uri pentru ele.

Fișierele `.evidence.json` complete (zeci de MB) sunt în scratchpad, deci temporare. Rezumatele de 6–12 KB per chunk sunt în `rezumate-chunkuri/`.

## 3. Apeluri de rețea din browser (observat)

| Endpoint | Metodă | Unde | Observații |
|---|---|---|---|
| `/api/checkout` | POST, corp JSON `{tier, interval, currency}`, antet `Authorization: Bearer <token Supabase>` | pagina de prețuri și fereastra de upgrade | răspunsul are `url`, iar browserul navighează la ea (pagina de plată Stripe); la eroare se afișează `error` |
| `/api/upload-queue` | `fetch`, răspuns JSON | `layout` (2 locuri) | coada de încărcare a bonurilor; ce confirmă `FINET_MASTER_PROMPT.md` din repo-ul FINET |
| `/api/feedback` | `fetch`, răspuns JSON | `layout` | formular de feedback |
| `/api/bug-reports` | `fetch`, răspuns JSON | `layout` | raportare de erori |
| `/api/referrals/me` | GET | widgetul de recomandări | întoarce `referralLink`; dacă lipsește, linkul devine `<origin>/pricing` |

În plus, există un apel `fetch` fără endpoint literal în `pricing` și `4799`. REA nu l-a putut rezolva static.

**Acces direct la baza de date din browser** (prin clientul Supabase, `.from(...).select`):
- `processing_batches` (2 citiri)
- `user_subscriptions` (2 citiri)

Nu există apeluri `.rpc(...)` și nici bucket-uri `storage`. Încărcarea bonurilor trece deci prin `/api/upload-queue`, nu prin Supabase Storage direct din browser.

## 4. Planuri și prețuri (observat, din `4799-15e210ca…`, modulul `21694`)

Limitele sunt cele din cod. Verificarea lor pe server nu s-a testat.

| | Free (Starter) | Pro (Personal) | Family | Ultra (Power User) |
|---|---|---|---|---|
| Preț lunar | 0 | 19,99 RON / 4,99 EUR | 34,99 RON / 8,99 EUR | 49,99 RON / 11,99 EUR |
| Preț anual | 0 | 189 RON / 49 EUR | 329 RON / 89 EUR | 479 RON / 119 EUR |
| Documente AI pe zi | 1 | 50 | 250 | 500 |
| Mărime fișier max | 5 MB | 10 MB | 15 MB | 25 MB |
| Membri | 1 | 2 | 6 | 10 |
| Bugete | 2 | nelimitat (999) | nelimitat (999) | nelimitat (999) |
| Obiective | 2 | nelimitat (999) | nelimitat (999) | nelimitat (999) |
| Furnizor AI (`aiProvider`) | `groq` | `openai` | `openai` | `openai` |
| Coadă prioritară | nu | da | da | da |
| Export | CSV | CSV, XLSX, PDF | CSV, XLSX, PDF | CSV, XLSX, PDF |
| Tipuri de fișier | JPEG, PNG, CSV | + PDF, XLSX, ZIP | toate | toate |

Funcții menționate în textele planurilor:
- **Free:** istoric de bonuri 3 luni, procesare „Groq / Gemini".
- **Pro:** 6 rapoarte predefinite („Sacoșe, SGR, Impuls, Menaj etc."), arhivă permanentă cu căutare OCR în text, Google Gemini 2.5 Flash.
- **Family:** împărțirea cheltuielilor (Splits) și calcul de decontare a datoriilor, bugete pe membru și bugete de familie, export contabil, suport prioritar.
- **Ultra:** generator de rapoarte personalizate pe orice articol din bonuri, analiză de prețuri și inflație per comerciant, raport AI la cerere în limbaj natural, suport „24/7".

**Neconcordanță observată în cod:** textul planului Pro spune „Procesare AI … cu Google Gemini 2.5 Flash", dar câmpul `aiProvider` al aceluiași plan este `openai`. REA nu poate spune care furnizor rulează de fapt. Asta se decide pe server.

Moneda implicită depinde de limbă: română → RON, altfel EUR. Planul curent e marcat „✓ pricing.currentPlan" în butoane.

## 5. Autentificare și stocare locală (observat)

- Pagina de login folosește clientul Supabase: `signInWithPassword`, `signUp` și `signInWithOAuth` (providerul OAuth e o variabilă, nu un literal; REA nu l-a rezolvat), plus `getSession`.
- La plată, dacă nu există sesiune, utilizatorul e redirecționat la `/login?redirect=/pricing`.
- Proiect Supabase: `<id-proiect-redactat>`, URL `https://<id-proiect-redactat>.supabase.co`.
- Cheia din cod este JWT cu `role: anon`, emitent `supabase`, și este cheia publică menită pentru browser. Nu e un secret.
- Chei `localStorage` / `sessionStorage` găsite în cod: `finpulse_cookie_consent`, `finpulse_last_chunk_reload`, `finpulse_pwa_dismissed`, `finpulse_ref_share_dismissed`, `tallyo_family`, `tallyo_ref_code`, `tallyo_test_user`, `tallyo_theme`, `supabase.gotrue-js.locks.debug`.
- Prefixul `tallyo_` apare alături de `finpulse_`, ceea ce sugerează o redenumire a produsului (dedus; nu există dovadă directă).
- Consimțământ pentru analytics: Google Analytics `G-CDYQVCCGQ0` pornește cu Consent Mode v2 pe `denied`. Devine `granted` doar dacă `finpulse_cookie_consent` conține `{"analytics": true}`. Reclamele (`ad_storage`, `ad_user_data`, `ad_personalization`) rămân `denied`.
- Aplicația se reîncarcă singură la o eroare de încărcare de chunk (maximum o dată la 8 secunde).
- Manifest PWA: `/manifest.webmanifest`.

## 6. Constatări de atenție

Acestea sunt observații tehnice din cod public, nu teste de securitate.

1. **Cod de server în bundle-ul de browser (observat).**
   - Chunk-ul `2560-b6e5bb1c…` conține biblioteca Stripe pentru Node: `api.stripe.com`, `connect.stripe.com`, `files.stripe.com`, `meter-events.stripe.com`, mesaje despre „webhook signing secret" și variabile de mediu ale agenților de cod (`CLAUDECODE`, `CODEX_CI`, `CURSOR_AGENT` ș.a.).
   - Modulul de planuri (`21694`) face `process.env.STRIPE_SECRET_KEY || ""` și instanțiază clientul Stripe. Importă modulul `62560` și apelează `new l.Ay(cheie, {apiVersion: "2025-02-24.acacia"})`, deci probabil biblioteca Stripe din chunk-ul `2560` (dedus din potrivirea formei apelului; identitatea modulului `62560` nu a fost verificată).
   - În browser, Next.js înlocuiește doar variabilele `NEXT_PUBLIC_*`, deci valoarea este aproape sigur `""` (dedus; nu s-a verificat la rulare).
   - Am căutat în toate fișierele descărcate tipare de chei secrete (`sk_live_`, `sk_test_`, `rk_`, `whsec_`, chei AWS, chei Google). Singurul rezultat este cheia Supabase `anon`.
   - Rămâne o problemă de arhitectură: configurația de planuri și SDK-ul de server ajung la clienți și măresc inutil bundle-ul.
2. **Limitele de plan se verifică probabil pe server (dedus).** Limitele sunt în cod client, dar asta nu arată dacă serverul le impune. `/api/upload-queue` ar trebui să le aplice. Neverificat.
3. **Securitatea datelor depinde de RLS din Supabase (necunoscut).** Cu cheia `anon` publică, accesul la `processing_batches` și `user_subscriptions` depinde de politicile Row Level Security din baza de date. Ele nu sunt vizibile din bundle și nu au fost testate.
4. **CSP slab (din anteturile HTTP, nu din REA).** Politica are doar `frame-ancestors`, `object-src`, `base-uri` și `form-action`, fără `script-src`. Nu restricționează sursele de scripturi.
5. **Plată prin redirect (observat).** Browserul trimite `tier`, `interval` și `currency` către `/api/checkout` și navighează la `url` din răspuns. Validarea prețului trebuie să fie în serverul `/api/checkout`, care nu apare în bundle.

## 7. Legătura cu FINET

`/srv/finet/src/docs/FINET_MASTER_PROMPT.md`, secțiunea 2, descrie finpulse.day ca produs de referință. Constatările de aici o susțin:

| În finpulse.day (observat) | În FINET |
|---|---|
| bonuri prin `/api/upload-queue` și `processing_batches` | planificat în faza 6; documentul citează aceleași nume |
| planuri Free / Pro / Family / Ultra cu limite pe zi | FINET nu are încă planuri de abonament în rutele din cod |
| bugete, obiective, rapoarte, export CSV / XLSX / PDF | faza 3 (în lucru) |
| împărțire cheltuieli (Splits) și decontare | nu apare în rutele actuale |
| liste de cumpărături | faza 10 |
| autentificare Supabase | FINET folosește Better Auth peste Postgres Supabase, nu clientul Supabase din browser |

`FINET_ANDROID_MASTER_PROMPT.md` interzice numele „FINpulse" în aplicația FINET.

## 8. Necunoscute și limite

- Nu se știe ce face serverul: validări, autentificare pe `/api/*`, logica `/admin`, politicile RLS din Supabase.
- Rutele private (`/dashboard`, `/receipts`, `/reports`, `/shopping-lists`, `/recurring`, `/goals`, `/import`, `/export`, `/settings`, `/admin`) apar în codul client, dar conținutul lor nu a fost analizat (chunk-uri nepublicate în HTML-ul public).
- Metodele HTTP și corpurile cererilor sunt cunoscute doar pentru `/api/checkout`. Pentru `upload-queue`, `feedback`, `bug-reports` și `referrals/me` REA a recuperat doar endpoint-ul.
- Bibliotecile din `1255`, `2619` și `4648` nu sunt identificate. Concluziile despre ele ar fi presupuneri.
- Textul din paginile `help`, `terms` și `privacy` stă în dicționare de traduceri (funcția `t(...)`) și nu a fost extras. Doar planurile (modulul `21694`) au fost citite integral.
- Nimic nu a fost observat la rulare. Graful semantic are mii de elemente nerezolvate. Absența unei constatări nu dovedește absența din cod.
- Existența unei rute sau a unui câmp în cod nu dovedește că funcționează sau că e accesibil.

## 9. Pași următori posibili

1. Extragerea dicționarelor de traduceri (RO/EN) ca să se obțină textul complet din `help`, `terms` și `privacy`.
2. Identificarea bibliotecilor din `1255`, `2619` și `4648`.
3. Repetarea analizei pe `4bd1b696` cu limită mai mare, doar pentru completitudine (React DOM).
4. Captură de browser (`capture_browser_scenario`) pentru metode HTTP, corpuri de cerere și storage. Se face doar dacă site-ul e al utilizatorului sau există permisiune explicită de testare.
5. Actualizarea secțiunii 2 din `FINET_MASTER_PROMPT.md` cu planurile și limitele de mai sus (modificare în repo, cere `sudo` și commit; o fac doar la cerere).

## 10. Fișiere

- Raport: `/home/claude/rapoarte/rea-finpulse-day-20261028/raport-detaliat.md`
- Raport inițial: `/home/claude/rapoarte/rea-finpulse-day-20261028/raport.md`
- Rezumate REA per chunk: `/home/claude/rapoarte/rea-finpulse-day-20261028/rezumate-chunkuri/`
- Evidențe complete, bundle descărcat și script de rulare: `/tmp/claude-1009/-home-docker-apps/167bc42c-6b9a-4aa7-95a1-b76de57d2633/scratchpad/finpulse/` (temporar)
