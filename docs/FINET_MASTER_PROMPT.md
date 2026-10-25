# FINET România — MASTER PROMPT pentru Claude Code (v3)

> **Cum se folosește acest document**
> - Secțiunile 1–6 sunt **reguli permanente**: se aplică în fiecare sesiune. Copiază-le în `CLAUDE.md` la rădăcina repository-ului, ca să fie încărcate automat.
> - Secțiunea 7 descrie **fazele**. Rulează **o singură fază per sesiune**, pe un branch dedicat (`phase/NN-nume`), cu PR și revizuire umană înainte de faza următoare.
> - Prompt de pornire per sesiune: *„Citește `docs/FINET_MASTER_PROMPT.md` și `docs/ROADMAP.md`. Execută Faza N. Oprește-te la criteriile ei de acceptare și raportează conform secțiunii 8.”*

---

## 1. Misiune

Acționează ca arhitect software senior, dezvoltator full-stack, specialist în securitate și DevOps. Construiește **FINET România** (identitatea vizuală în secțiunea 3.4; verificarea numelui în secțiunea 9): o aplicație web PWA de finanțe **personale și de familie**, cu interfață în română, RON ca monedă implicită și **bonurile fiscale românești ca problemă centrală**, nu ca detaliu.

Aceeași bază de cod livrează **două variante**, alese prin configurare (secțiunea 3.3):
- **`personal`**: unealtă privată pentru o familie, găzduită pe infrastructura proprie. Fără plăți, fără înregistrare publică, fără pagină de prezentare.
- **`saas`**: produs public, cu înregistrare, planuri, plăți Stripe, recomandări și panou de administrare.

Varianta `personal` se livrează prima. Varianta `saas` se construiește peste ea, fără rescriere și fără să o strice.

Principiu director: **nu construim o clonă.** Mai puține funcții la start, dar fiecare dusă până la capăt, iar ingestia de documente (bonuri, extrase, potrivire) tratată ca miezul produsului. Referința de categorie este finpulse.day. Inspiră-te din **funcționalități**, nu copia branding, logo, texte, culori distinctive sau cod.

## 2. Analiza produsului de referință (finpulse.day)

Surse, toate publice și fără autentificare: verificările proprii din 2026-10-25 (`manifest.json`, `robots.txt`, `sitemap.xml`, `sw.js`, textul indexat al paginii) și rapoartele „Radar” din aceeași zi (antete HTTP, fișiere JavaScript publice). Afirmațiile din rapoartele Radar nu au fost verificate independent. Rândurile marcate **(C)** provin din dashboard-ul unui cont gratuit propriu, gol, văzut pe 25.10.2026; fluxurile cu date (bonuri, potriviri, decontări) nu au fost încă văzute. Ce urmează este o descriere, nu o specificație de copiat.

### 2.1 Ce oferă

| Modul | Ce face la referință | Unde intră la noi |
|---|---|---|
| Dashboard | Total lunar, pe categorii, trend, comparație cu luna anterioară; onboarding în 3 pași (importă, setează buget, creează obiectiv). **(C)** Totul pe o singură pagină: carduri Venituri, Cheltuieli, Sold net, Număr de tranzacții; widget de împărțire „Ai de dat / Ai de primit”; obiective active; bugete lunare cu selector de lună (ultimele 12 luni); grafice „Cheltuieli pe categorii”, „Evoluție lunară”, „Trend zilnic”; filtre avansate (interval de date, comerciant, tip, sumă minimă și maximă, categorie, etichete); lista de tranzacții cu „Adaugă cash / manual” | Faza 3 (împărțirea: Faza 8) |
| Clasificare **(C)** | Două dimensiuni: 17 categorii pe tranzacție (Cumpărături, Haine, Alimente, Mâncare, Restaurante, Transport, Utilități, Asociație / Întreținere, Chirie / Rată, Sănătate & Farmacie, Educație, Divertisment, Vacanțe, Casă & Reparații, Copii, Abonamente, Altele) plus 25 de etichete (de exemplu Igiena casei, Igienă personală, Băuturi & Cafea, Farmacie & Suplimente, Carburant, Familie, Copii, Personal, Animale) | Categorii plus etichete (5.4), cu categorii care nu se suprapun |
| Bugete | General sau pe categorie, comune și individuale, semafor verde/galben/roșu, alerte la apropierea limitei | Faza 3 (comune: Faza 8) |
| Obiective | Nume, sumă țintă, termen, progres, stare; ștergere cu confirmare | Faza 3 |
| Bonuri | Foto (inclusiv bonuri șterse sau mototolite), PDF, mai multe fișiere deodată; coadă cu prioritate după plan (`/api/upload-queue`, `processing_batches`); extrage comerciant, dată, total, TVA și **fiecare produs** cu cantitate și preț unitar; categorisire la nivel de produs; arhivă cu căutare în textul OCR; recunoaște garanția SGR (0,50 lei per ambalaj) și reducerile de pe cardurile de fidelitate. **(C)** Pagina `/receipts` este doar istoricul: încărcarea se face din `/import`, iar butonul „Scanează” e mereu vizibil. Tabelul are coloanele Data bonului, Comerciant, Categorie (una per bon), Total, Vizualizează, Status, Acțiuni. Caută după magazin, produs sau sumă și filtrează după categorie. „Validare AI & Duplicate” e marcată ca funcție Pro | Faza 6 |
| Extrase | PDF, CSV, Excel, ZIP; „bănci RO și Revolut”; în codul public apar ING, BT, BCR, BRD, Raiffeisen, Revolut și Wise; deduplicare; avertizare pentru lunile fără extras. **(C)** Pagina „Import unificat”: o singură zonă de încărcare pentru poze, PDF, CSV, Excel și ZIP; contor de consum („0 din 1 documente permise azi, maximum 5 MB”, confirmă limita planului gratuit); comutator manual „Mod bon lung (2–4+ poze)”, care, odată activ, înlocuiește zona de încărcare cu una dedicată („cele 2–4 poze ale bonului lung, în ordine de sus în jos”); o filă separată, „Evidență extrase & acoperire”. Lista de bănci nu apare înainte de încărcare | Faza 7 |
| Potrivire | Bonul se leagă automat de tranzacția cu cardul din extras („potrivire confirmată cu extrasul ING”) | Faza 7 |
| Recurențe | Detectarea abonamentelor (Netflix, Spotify, sală, chirie), generarea tranzacțiilor la scadență. **(C)** Pagina arată „X active · Y de generat · Z total”; generarea e **manuală**, din butonul „Generează tranzacțiile scadente”; stări: active, puse pe pauză, completate, cu filtre pe fiecare | Faza 5 (reguli) și Faza 7 (detectare din extrase) |
| Familie | Până la 6 membri, bugete comune și individuale, împărțire 50/50, solduri reciproce, decontări (`/api/family/info`) | Faza 8 |
| Liste de cumpărături | Bifare la raft, comparație AI listă ↔ bon, detectarea achizițiilor neplanificate | Faza 10 |
| Rapoarte | Rapoarte personalizate pe orice produs din bonuri, prețuri pe magazin, variația prețurilor în timp, „verdict financiar AI”. **(C)** Pagina „Rapoarte inteligente și micro-cheltuieli”, doar pentru planurile plătite, are trei secțiuni: rapoarte predefinite (Pro), generator pe articole (Ultra), comparator și evoluția prețurilor (Ultra). Perioade: toată arhiva, luna curentă, luna trecută, ultimele 3 luni, anul acesta. Rapoartele predefinite: pungi și sacoșe, garanția SGR, cumpărături din impuls de la casă, produse nealimentare la supermarket (igienă, menaj), cafea și băuturi la bucată, economii din cupoane și carduri de fidelitate. Fiecare arată totalul, numărul de bucăți, prețul mediu, proiecția anuală, un sfat, istoricul achizițiilor și export CSV | Faza 3 (de bază), Faza 10 (micro-cheltuieli și prețuri) |
| Export | CSV, Excel, PDF pentru tranzacții, bonuri, obiective, bugete | Faza 3 (CSV), Faza 10 (Excel/PDF) |
| Autentificare | Email și parolă, magic link, Google, Facebook | Faza 1 (email, parolă, magic link); Google în faza `saas` |
| Recomandări | Cod unic (`/ref/FIN-XXXXXX`); distribuire prin WhatsApp, Telegram, email și copiere; **(C)** invitatul primește 1 lună Pro, cel care invită +1 lună; contoare „prieteni invitați” și „luni câștigate”. Feedback-ul trimis aduce 14 zile Pro | Faza 12, doar `saas` |
| Mențiuni legale **(C)** | Footer cu firma care operează serviciul, termeni, confidențialitate (GDPR) și link ANPC / SAL | Faza 11, obligatoriu în `saas` |
| Administrare | Utilizatori, abonamente, anunțuri (`/api/broadcast`), feedback, raportări de bug-uri | Faza 11, doar `saas` |
| Limbi | ro, en, es, fr, de, it, pl, tr în cod; **(C)** selectorul arată ro, en, fr, it, es, de | ro de la start; en în faza `saas`; restul doar la cerere |

### 2.2 Planuri (doar referință pentru `saas`)

| Plan | Preț | Limite raportate |
|---|---|---|
| Starter | gratuit | tranzacții manuale nelimitate, 2 bugete, 2 obiective, 1 document AI pe zi (5 MB) |
| Pro | 19,99 lei (4,99 €) pe lună | 50 de documente pe zi (10 MB), nelimitat, export PDF și Excel, extrase |
| Family | 34,99 lei (8,99 €) pe lună | 250 de documente pe zi (15 MB), 6 membri, bugete comune, decontări |

Rapoartele se contrazic pentru Starter: unul spune 1 document pe zi, altul 50 de bonuri pe zi și istoric de 3 luni. Există chei pentru facturare anuală, dar valorile nu sunt cunoscute. Perioada de probă este de 30 de zile Pro. Limitele noastre vor fi decise separat, pe baza costului măsurat (Faza 12).

### 2.3 Tehnic

- **Stack:** Next.js App Router (React 19), Tailwind, Supabase (Postgres, Auth, Realtime), Stripe, Cloudflare, Google Analytics 4. PWA cu `start_url: /dashboard`.
- **Furnizori AI afișați în interfață:** Groq, Gemini 2.5 Flash și GPT-4o-mini, aleși după plan.
- **Antete de securitate:** HSTS preload; CSP doar cu `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, **fără `default-src` și `script-src`**; `X-Frame-Options: DENY`; `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
- **Cheia Stripe:** numele `STRIPE_SECRET_KEY` apare într-un fișier JavaScript livrat browserului, dar nu s-a găsit nicio valoare `sk_live_` sau `sk_test_`. Este o greșeală de împachetare (un modul de server importat într-o componentă de client), nu o scurgere de secret.

### 2.4 Slăbiciuni observate, deci oportunități pentru noi

1. **Offline inexistent:** service worker de 965 de octeți fără precache, iar `/offline` răspunde 404. → La noi, scanarea funcționează și fără semnal în magazin (Faza 9).
2. **Pagina principală se randează în browser** (HTML-ul inițial conține doar „Loading…”), deci SEO slab. → La noi, paginile publice se randează pe server (Faza 11).
3. **Acuratețe declarată (99,4%) fără date publicate.** → La noi, acuratețea se măsoară pe un set de validare propriu, iar rezultatul se raportează (Faza 6).
4. **Potrivirea bon ↔ tranzacție nu își explică decizia.** → La noi, scor de încredere vizibil, motivul potrivirii și posibilitatea de corectare (Faza 7).
5. **CSP incompletă.** → La noi, CSP completă cu nonce (6.3).
6. **Dependență de furnizori AI externi pentru funcția centrală.** → La noi, procesare locală întâi, cu furnizor extern doar ca rezervă și cu consimțământ (Faza 6).
7. **Fără demo public.** → La noi, date demo opționale la onboarding.
8. **(C) Sumele nu au format românesc:** „0.00 RON”, cu punct zecimal. → La noi, `0,00 lei` peste tot (5.3).
9. **(C) Categorii care se suprapun:** Alimente, Mâncare și Cumpărături; Copii apare și ca categorie, și ca etichetă. → La noi, categorii distincte, iar etichetele acoperă restul.
10. **(C) „Cheltuieli pe categorii” pare să se bazeze doar pe bonuri** (starea goală spune „Niciun bon în perioada selectată”), deci tranzacțiile manuale probabil nu apar acolo. Este o deducție. → La noi, graficul include toate cheltuielile: liniile bonurilor acolo unde există bon, categoria tranzacției în rest.
11. **(C) Google Analytics se încarcă și pe paginile cu date financiare, iar pagina are `lang="en"`** deși interfața e în română. → La noi, fără analytics pe paginile autentificate și `lang` setat după limba interfeței.
12. **(C) Un dashboard foarte încărcat:** statistici, împărțire, obiective, bugete, trei grafice, filtre, tranzacții, recomandări și feedback pe aceeași pagină. → La noi, dashboard-ul arată rezumatul, iar tranzacțiile și filtrele au pagina lor.
13. **(C) Detectarea duplicatelor e o funcție plătită.** În planul gratuit, același bon încărcat de două ori poate dubla cheltuiala. → La noi, deduplicarea și verificările de consistență sunt mereu active, în ambele moduri și pe orice plan; nu trec prin `entitlements`.

## 3. Infrastructură și stack

### 3.1 Infrastructura țintă (raportată, de verificat în Faza 0)

- Container LXC (ID 1999), **fără Docker**: rulare nativă cu Node 24 și pnpm.
- **Disc: 5,3 GB liberi din 20 GB.** Faza 0 nu începe până nu sunt cel puțin 8 GB liberi. Pozele bonurilor au nevoie de comprimare, retenție și cotă.
- nginx rulează deja pe portul 80 ca reverse proxy.
- Ollama local pe `127.0.0.1:11434` și o poartă LiteLLM existentă, utile pentru AI local.
- PostgreSQL nu este instalat.
- Monitorizarea existentă (agent-queue, cron-uri) se integrează printr-un endpoint de sănătate.

Faza 0 verifică aceste date pe sistem și le corectează în `docs/INFRA.md`. Nu se fac modificări de sistem (instalări, ștergeri pentru eliberarea discului, configurare nginx) fără aprobare explicită.

### 3.2 Stack (decis — nu îl schimba fără un motiv tehnic documentat în `docs/adr/`)

- **Aplicație:** Next.js (ultima versiune majoră stabilă la data Fazei 0, minimum 15), App Router, TypeScript în mod `strict`. Monolit modular.
- **UI:** Tailwind CSS + shadcn/ui, Recharts, lucide-react. Temă luminoasă și închisă.
- **Baza de date:** PostgreSQL 16, instalat nativ. Drizzle ORM și migrații Drizzle Kit, versionate în repository.
- **Autentificare:** Better Auth: email și parolă (Argon2id), magic link, sesiuni stocate în baza de date (expirabile și revocabile). Google OAuth vine în faza `saas`.
- **Validare:** Zod, cu aceleași scheme pe client și pe server.
- **Joburi:** pg-boss (coadă peste Postgres, fără Redis), într-un proces worker separat.
- **Fișiere:** sistem de fișiere local, în spatele unei interfețe `storage` compatibile S3, ca mutarea pe S3 sau R2 să nu ceară modificări de cod. Imagini procesate cu sharp.
- **AI și OCR:** interfață `ai/provider`, apelată doar prin LiteLLM, cu un furnizor local (model vision prin Ollama și/sau Tesseract `ron`) și un furnizor extern opțional ca rezervă. Alegerea implicită se face pe baza rezultatelor pe setul de validare (Faza 6), nu din presupuneri.
- **Email:** SMTP prin Nodemailer. Opțional în modul `personal`.
- **Teste:** Vitest pentru unit și integrare (pe un Postgres real, bază separată de test), Playwright pentru E2E.
- **Calitate:** ESLint, Prettier, `tsc --noEmit`, GitHub Actions (lint, type-check, teste, build, scanarea secretelor din fișierele de client) pe fiecare PR.
- **Deploy:** nativ, cu unități systemd pentru `web` și `worker`, în spatele nginx-ului existent, cu HTTPS. Docker Compose este o alternativă documentată, nu o cerință.
- **Doar `saas`:** Stripe, Cloudflare Turnstile, monitorizarea erorilor (GlitchTip sau Sentry, fără date financiare), analytics doar pe paginile publice și doar dintr-o soluție care respectă confidențialitatea (Plausible sau Umami).

Structura recomandată:

```
src/
  app/                 # rute Next.js (UI + route handlers subțiri)
  modules/
    auth/ households/ accounts/ categories/ transactions/ budgets/ goals/
    recurring/ reports/ audit/ entitlements/ documents/ receipts/
    statements/ matching/ settlements/
    billing/ referrals/ admin/ feedback/ broadcasts/ marketing/   # doar saas
      *.schema.ts      # Zod
      *.service.ts     # logică de business (fără Next.js)
      *.repo.ts        # acces la date (Drizzle)
      *.test.ts
  lib/money.ts         # aritmetică monetară, formatare RON
  lib/authz.ts         # requireMember(householdId, role)
  lib/config.ts        # APP_MODE și restul variabilelor de mediu, validate cu Zod
  lib/storage.ts       # interfață fișiere (local / S3)
  lib/ai/              # interfața de furnizor AI, prin LiteLLM
  db/schema.ts, db/migrations/
  worker/              # joburi pg-boss
fixtures/
  receipts/            # setul de validare, anonimizat, plus rezultatul așteptat
  statements/          # extrase de exemplu anonimizate, câte unul pe bancă
```

Logica financiară stă în `modules/*/*.service.ts`, fără importuri din Next.js, ca să poată fi testată izolat.

### 3.3 Moduri de rulare: `APP_MODE=personal | saas`

O singură bază de cod, **o singură schemă de bază de date**. Modul schimbă doar ce rute și funcții sunt active. Trecerea de la `personal` la `saas` înseamnă o schimbare de configurare plus o migrație de date documentată (gospodăriile existente primesc un plan „fondator” fără limite).

| Aspect | `personal` | `saas` |
|---|---|---|
| Înregistrare | Închisă. Primul utilizator se creează din CLI (`pnpm admin:create-user`) și devine administrator; ceilalți intră doar prin invitație în gospodărie | Publică, cu verificare email și Turnstile |
| Rută `/` | Redirecționează la `/login` sau `/dashboard` | Pagină de prezentare randată pe server, plus `/pricing`, `/help`, `/terms`, `/privacy` |
| Email (SMTP) | Opțional; fără SMTP, resetarea parolei se face din CLI, iar magic link e dezactivat | Obligatoriu |
| Planuri și plăți | Nu există; rutele de billing răspund 404 | Stripe, planuri, perioadă de probă, recomandări |
| Limite | Doar limitele tehnice din env (`AI_DAILY_DOCUMENT_LIMIT`, `AI_MONTHLY_BUDGET`, `STORAGE_QUOTA_MB`) | Limitele planului, plus limitele tehnice globale |
| Administrare | Pagină minimă: utilizatori, stare joburi, spațiu ocupat, ultimul backup | Panou complet, feedback, raportări de bug-uri, anunțuri |
| `robots.txt` | `Disallow: /` | Indexare doar pentru paginile publice |

Reguli:
- Modul se citește o singură dată, din `lib/config.ts`, validat cu Zod la pornire. O valoare lipsă sau invalidă oprește pornirea aplicației.
- Logica de business **nu verifică niciodată direct modul sau Stripe**. Întreabă modulul `entitlements`: `can(householdId, 'documents.process')`, `limit(householdId, 'budgets.max')`. În modul `personal` răspunsul e „permis”, cu excepția limitelor tehnice.
- Modulele exclusive pentru `saas` se înregistrează doar când `APP_MODE=saas`; în modul `personal` rutele lor răspund 404.
- CI rulează testele E2E de bază **în ambele moduri**.

### 3.4 Identitate vizuală (FINET)

Referința vizuală completă este demo-ul din `docs/demo/finet-demo.html` (date fictive): structura paginilor, fluxurile, culorile și logo-ul. Implementarea respectă tokenii de mai jos; componentele shadcn/ui se tematizează prin ei, nu prin culori scrise direct.

**Logo (wordmark):** **FIN** + simbol + **t**, fără alte elemente.
- „FIN”: Bricolage Grotesque, greutate 800, majuscule, spațiere −0,03em, culoarea textului principal.
- Simbolul ține locul literei „e”: o linie frântă dintr-un singur trait, cu capete și colțuri rotunjite, care la final urcă, ca un grafic în creștere, și se termină cu o monedă. SVG (`viewBox="1 2 17 22"`): `<path d="M1.5 18.5 H5 L7 22.5 L10 5 L12.6 17 L14.2 13.5 L16.5 3.5" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` în culoarea `accent`, plus `<circle cx="16.5" cy="3.5" r="1.9"/>` în culoarea `marker`.
- „t”: Bricolage Grotesque, greutate 600, literă mică, culoarea `muted`.
- Logo-ul este o componentă React (`<Logo />`) cu `aria-label` „FINET”. La hover, linia se redesenează (animație dezactivată când utilizatorul a cerut mișcare redusă). Simbolul singur, pe fundal `accent`, se folosește ca iconiță PWA și favicon.

**Culori (tokeni, temă luminoasă / întunecată):**

| Token | Luminos | Întunecat | Folosire |
|---|---|---|---|
| `bg` | `#f2f5f4` | `#0e1412` | fundalul paginii |
| `surface` | `#ffffff` | `#151d1a` | carduri, panouri |
| `fg` | `#14201c` | `#e5ece9` | text principal |
| `muted` | `#586863` | `#93a39d` | text secundar |
| `line` | `#d3dcd8` | `#29352f` | borduri |
| `accent` | `#1f45b8` | `#87a3ff` | acțiuni, linkuri, simbolul din logo |
| `marker` | `#f6dc6b` | `#e3c446` | evidențieri (rânduri de verificat, moneda din logo) |
| `paper` | `#fbfaf4` | `#ecebe3` | bonul fiscal randat ca hârtie |
| `ok` / `warn` / `bad` | `#1d7f47` / `#a8690f` / `#bf3326` | `#4fc483` / `#e2ab48` / `#ff7466` | semaforul bugetelor și stările |

**Tipografie:** Bricolage Grotesque pentru titluri și logo, IBM Plex Sans pentru text, IBM Plex Mono pentru sume în coloane și pentru bonurile randate (cu `tabular-nums`). Fonturile se servesc local (`next/font`), nu de pe CDN.

**Elemente proprii:** bonul fiscal afișat ca hârtie termică lângă datele extrase; rândurile cu încredere scăzută evidențiate cu `marker`; semaforul bugetelor; pe telefon, navigare jos cu 5 butoane (Acasă, Tranzacții, Scanează, Rapoarte, Mai mult), iar pe desktop meniu lateral cu toate paginile.

## 4. Reguli de execuție

1. La începutul fiecărei sesiuni, inspectează starea Git, structura repository-ului, `docs/ROADMAP.md` și testele existente. Repository-ul este sursa de adevăr.
2. Lucrează pe branch-ul fazei, cu commit-uri mici și mesaje clare. Nu face push direct pe `main`.
3. Prezintă un plan scurt pentru faza curentă, apoi implementează. Oprește-te la sfârșitul fazei; nu începe faza următoare.
4. Rulează lint, type-check, teste și build după fiecare pas semnificativ. **Nu pretinde că ai rulat verificări pe care nu le-ai executat.** Raportează ieșirea exactă a eșecurilor.
5. Nu șterge date sau configurații și nu face operațiuni distructive (drop, reset, force push, curățarea discului, modificarea configurației nginx sau systemd) fără aprobare explicită.
6. Nu introduce secrete în cod, loguri, commit-uri sau documentație. Folosește variabile de mediu și un `.env.example` cu valori fictive.
7. Fixează versiunile dependențelor (lockfile commis). Nu adăuga o dependență nouă fără să notezi motivul.
8. Notează ipotezele, riscurile, fișierele modificate și rezultatele în raportul fazei și în `docs/ROADMAP.md`.
9. Dacă o cerință e ambiguă sau intră în conflict cu codul existent, alege varianta mai sigură, documenteaz-o într-un ADR (`docs/adr/NNNN-titlu.md`) și semnalează-o în raport.
10. **Porți de revizuire:** fazele care ating autentificarea, autorizarea, încărcarea de fișiere, banii (împărțiri, decontări) sau plățile se încheie cu o revizuire de securitate separată (de exemplu agentul „Scut”), iar constatările ei sunt incluse în raport. Când lucrul e împărțit între agenți (arhitectură, cod, date, cercetare, securitate, infrastructură), fiecare agent respectă același document și același raport.

## 5. Reguli de domeniu (obligatorii)

### 5.1 Bani
- Sumele se stochează ca **`bigint` în unități minore** (bani: 1 RON = 100 bani) în coloane `*_minor`, împreună cu `currency` (ISO 4217). Niciodată float.
- Cantitățile de pe bonuri (de exemplu 0,754 kg) se stochează ca `numeric(12,3)`. Totalul unei linii vine de pe bon; nu se recalculează din cantitate × preț. Diferențele se semnalează la verificare.
- Toată aritmetica trece prin `lib/money.ts`. Împărțirile folosesc metoda **restului cel mai mare**, ca suma părților să fie exact totalul.
- `amount_minor` este întotdeauna **pozitiv**; semnul rezultă din `type` (`income`, `expense`, `transfer`). Constrângere CHECK în baza de date.
- **Monede:** RON implicit, plus EUR și USD permise pe cont. Totalurile se afișează **separat pe monedă**, fără conversie. Conversia cu cursul BNR vine mai târziu.
- **Transfer între conturi:** două rânduri `transfer` legate prin `transfer_group_id`, create atomic. Nu se contează ca venit sau cheltuială. Între monede diferite se cer explicit ambele sume.

### 5.2 Date și timp
- Fusul orar implicit este `Europe/Bucharest`. `occurred_on` este `date` (zi locală); `created_at` și `updated_at` sunt `timestamptz` în UTC.
- Perioadele se calculează în fusul orar al gospodăriei. Săptămâna începe luni.

### 5.3 Formatare românească
- Sume: `1.234,56 lei` (`Intl.NumberFormat('ro-RO', { style: 'currency', currency: 'RON' })`). Date: `25.10.2026`.
- Inputurile de sumă acceptă virgula și punctul ca separator zecimal și resping valorile ambigue.
- Interfața are diacritice corecte (ș și ț cu virgulă, nu cu sedilă). Textele stau în fișiere de traducere (`ro` de la început), ca adăugarea limbii engleze să nu ceară modificări de cod.
- Exportul CSV este UTF-8 cu BOM, separator `;` și zecimale cu virgulă. Valorile sunt protejate împotriva CSV injection (prefixează `=`, `+`, `-`, `@`).

### 5.4 Categorii implicite (sistem, nu se pot șterge, dar se pot ascunde)
- **Cheltuieli:** Alimente, Restaurante și cafenele, Locuință (chirie/rată), Utilități (curent, gaz, apă), Internet și telefonie, Transport și combustibil, Sănătate și farmacie, Îmbrăcăminte și încălțăminte, Copii, Educație, Divertisment, Abonamente, Cadouri și donații, Taxe și impozite, Asigurări, Asociația de proprietari (întreținere bloc), Casă și reparații, Igienă și cosmetice, Animale de companie, Vacanțe și călătorii, Altele.
- **Venituri:** Salariu, Freelance/PFA, Chirii încasate, Dobânzi și dividende, Rambursări, Cadouri primite, Alte venituri.
- Categoriile au o ierarhie opțională (`parent_id`) pe un singur nivel. O tranzacție, sau o linie de bon, are **o singură** categorie; categoriile nu se suprapun.
- **Etichete:** o a doua dimensiune, liberă, cu mai multe etichete pe tranzacție sau pe linie de bon. Exemple: Personal, Familie, Copii, Vacanța 2027, Deductibil, Cadou. Etichetele implicite pot fi ascunse, iar utilizatorul își poate crea altele. Filtrele și rapoartele funcționează atât pe categorii, cât și pe etichete.

### 5.5 Bonuri fiscale românești
- **Câmpuri de antet:** comerciant, CUI (cu validarea cifrei de control), adresa magazinului, data și ora, numărul bonului, metoda de plată, total.
- **Tipuri de linie:** `item` (produs), `discount` (reducere, inclusiv de pe cardurile de fidelitate, de exemplu Lidl Plus), `deposit` (garanția SGR, 0,50 lei per ambalaj), `vat_summary` (totalurile de TVA pe cote).
- **Garanția SGR** nu este o cheltuială de consum: se înregistrează separat (recuperabilă), iar returnarea ambalajelor poate genera un voucher.
- **Cote TVA:** se citesc de pe bon, nu se presupun. Valorile curente (21% și 11%) sunt doar pentru validare și se configurează în date, nu în cod.
- **Verificări:** suma liniilor (produse − reduceri + garanții) = total; suma TVA plauzibilă; data nu este în viitor. Orice nepotrivire marchează bonul „de verificat”.

### 5.6 Ștergere
- **Conturile** cu tranzacții se arhivează (`archived_at`); doar conturile goale se pot șterge.
- **Tranzacțiile** se șterg definitiv, cu confirmare și un `audit_event` fără sume.
- **Categoriile personalizate** folosite se pot șterge numai cu reasignarea tranzacțiilor.
- **Documentele** (bonuri, extrase): ștergerea elimină și fișierul din `storage`. Tranzacțiile create din ele rămân, cu legătura eliminată.
- **Ștergerea contului de utilizator** cere reconfirmarea parolei. Dacă utilizatorul este singurul membru, gospodăria și toate datele ei, inclusiv fișierele, se șterg.

## 6. Arhitectură, date și securitate

### 6.1 Proprietatea datelor: gospodăria (household)
Toate datele financiare aparțin unei **gospodării**, nu direct unui utilizator. Fiecare utilizator primește automat o gospodărie personală la creare. Astfel funcțiile de familie nu cer refactorizarea schemei.

**Nucleu (Fazele 1–5):**
- `users`: id, email unic normalizat, name, email_verified_at, status, is_platform_admin, timestamps. Plus tabelele de sesiune și cont cerute de Better Auth.
- `user_preferences`: user_id, locale (`ro-RO`), timezone, default_currency (`RON`), theme, onboarding_completed_at.
- `households`: id, name, default_currency, timezone, created_by, timestamps.
- `household_members`: household_id, user_id, role (`owner`, `member`), joined_at. Unic pe (household_id, user_id).
- `accounts`: household_id, owner_user_id nullable (personal sau comun), name, type (`cash`, `bank`, `savings`, `credit_card`), currency, opening_balance_minor, bank_code nullable, archived_at.
- `categories`: household_id nullable (NULL = sistem), parent_id nullable, name, kind (`income`, `expense`), icon, color, hidden.
- `transactions`: household_id, account_id, category_id nullable, created_by_user_id, type, amount_minor, currency, occurred_on, description, merchant, notes, source (`manual`, `receipt`, `statement`, `recurring`), transfer_group_id, recurring_rule_id, document_id, external_ref, timestamps.
- `budgets`: household_id, category_id nullable (NULL = buget general), period (`monthly`), amount_minor, currency, warn_pct (implicit 80), scope (`household`, `personal`), user_id nullable.
- `goals`: household_id, name, target_minor, currency, saved_minor, deadline nullable, status (`active`, `achieved`, `abandoned`), account_id nullable.
- `recurring_rules`: household_id, account_id, category_id, type, amount_minor, currency, frequency, interval, day_of_month, next_run_on, end_on, active.
- `recurring_occurrences`: rule_id, occurrence_date, transaction_id. **Unic pe (rule_id, occurrence_date)**: garanția de idempotență.
- `audit_events`: household_id, actor_user_id, action, target_type, target_id, created_at, metadata minimă (fără sume, descrieri sau date personale).

**Ingestie (Fazele 6–7):**
- `documents`: household_id, uploaded_by, kind (`receipt`, `statement`), storage_key, mime, size_bytes, sha256, perceptual_hash nullable, status (`queued`, `processing`, `needs_review`, `done`, `failed`), error_code, batch_id, created_at. Unic pe (household_id, sha256).
- `processing_batches`: household_id, created_by, counts pe stare, created_at.
- `receipts`: document_id, household_id, merchant_name, merchant_cui, store_address, issued_at, receipt_number, payment_method, total_minor, currency, vat_json, confidence, ocr_text (pentru căutare, index full-text), provider_used.
- `receipt_lines`: receipt_id, line_no, kind (`item`, `discount`, `deposit`, `vat_summary`), raw_name, normalized_name, quantity, unit, unit_price_minor, total_minor, vat_rate, category_id.
- `product_aliases`: household_id, raw_name_normalized, merchant_cui nullable, category_id, normalized_name. Aici se învață din corecturile utilizatorului.
- `statements`: document_id, household_id, account_id, bank_code, period_start, period_end, parser_version.
- `statement_lines`: statement_id, row_no, occurred_on, amount_minor, direction, description_raw, merchant_guess, external_ref, transaction_id nullable.
- `matches`: household_id, receipt_id, transaction_id, score, reasons_json, status (`suggested`, `confirmed`, `rejected`), decided_by. Unic pe receipt_id pentru cele confirmate.
- `consents`: user_id, kind (de exemplu `external_ai`), granted_at, revoked_at.

**Etichete (Faza 3):** `tags` (household_id nullable pentru cele de sistem, name, color, hidden), `transaction_tags` (transaction_id, tag_id), `receipt_line_tags` (receipt_line_id, tag_id). Ambele tabele de legătură au cheie unică pe pereche.

**Familie (Faza 8):** `household_invites` (token hash, expires_at, used_at), `transaction_splits` (transaction_id, user_id, share_minor), `settlements` (household_id, from_user_id, to_user_id, amount_minor, currency, settled_on, note).

**Liste de cumpărături (Faza 10):** `shopping_lists`, `shopping_list_items` (name, quantity, checked, matched_receipt_line_id).

**Doar `saas` (Fazele 11–12):** `plans`, `subscriptions`, `stripe_events` (event_id unic), `referrals`, `feedback`, `bug_reports`, `broadcasts`.

Cerințe:
- Chei străine cu reguli explicite `ON DELETE`, constrângeri CHECK, indecși pe `(household_id, occurred_on DESC)`, `(account_id)`, `(category_id)`, `(household_id, status)` pe `documents`, plus index GIN pe `receipts.ocr_text`.
- Soldul curent al unui cont se **calculează**, nu se stochează.
- Paginarea folosește cursor pe `(occurred_on, id)`.

### 6.2 Autorizare (două straturi)
- **Stratul 1, în aplicație (obligatoriu):** fiecare acces trece prin `requireMember(householdId, minRole)`. `household_id` vine din sesiune sau din ruta validată, **niciodată din body fără verificare**. Fiecare query din `*.repo.ts` filtrează după `household_id`.
- **Stratul 2, în baza de date:** Row-Level Security activat pe toate tabelele cu `household_id`, încă de la crearea lor. Aplicația se conectează cu un rol fără drept de ocolire a RLS (`NOBYPASSRLS`) și setează `app.household_id` per tranzacție (`SET LOCAL`). Migrațiile rulează cu un rol separat. Workerul setează același context pentru fiecare job.
- Testele de integrare verifică izolarea: utilizatorul A primește 404 la resursele gospodăriei B, iar un query fără context RLS nu întoarce niciun rând.

### 6.3 Securitate (OWASP ASVS nivel 2 ca referință)
- Argon2id, minimum 10 caractere, verificare opțională împotriva parolelor compromise (HIBP, k-anonymity).
- Cookie-uri `Secure`, `HttpOnly`, `SameSite=Lax`. Protecție CSRF pentru mutații. Magic link de unică folosință, cu expirare scurtă.
- Rate limiting pentru login, magic link, resetare, invitații și încărcarea de fișiere.
- **Antete:** CSP completă cu nonce (`default-src 'self'`, `script-src 'self' 'nonce-…'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`), HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`. CORS închis.
- **Secretele nu ajung în browser.** Modulele care citesc secrete încep cu `import 'server-only'`; doar variabilele `NEXT_PUBLIC_*` sunt publice, iar lista lor e documentată. CI scanează `.next/static` după tipare de secrete (`sk_live_`, `sk_test_`, `rk_live_`, `whsec_`, chei private) și după numele variabilelor secrete, și pică dacă găsește ceva.
- **Încărcare de fișiere:**
  - tipul se verifică după conținut (magic bytes), nu după extensie;
  - dimensiune maximă și cotă per gospodărie;
  - EXIF eliminat (inclusiv locația);
  - fișierele stau în afara directorului public și se servesc doar prin rute autorizate, cu nume generate;
  - ZIP: limită de fișiere, de dimensiune totală și de raport de compresie; căile cu `..` sau absolute se resping.
- **AI extern:** se folosește doar după consimțământ explicit (`consents`), cu furnizorul numit în politica de confidențialitate. Imaginile trimise extern nu conțin metadate. Fără consimțământ se folosește doar procesarea locală.
- Webhook-urile Stripe se acceptă doar cu semnătură verificată și se procesează o singură dată.
- Erori uniforme, fără stack trace în producție. Loguri structurate (pino) **fără** sume, descrieri, text OCR, emailuri complete sau tokenuri.
- Fără scripturi de analytics sau de urmărire pe paginile autentificate. Elementul `<html>` are `lang` setat după limba interfeței.
- Nicio dată sensibilă în URL, analytics sau rapoartele de erori. Fără credențiale bancare și fără numere complete de card (din extrase se păstrează doar ultimele 4 cifre, dacă apar).
- `pnpm audit` în CI, plus Dependabot sau Renovate.
- **GDPR:** export complet (JSON, CSV și fișierele originale), ștergerea contului, retenția documentată în `docs/PRIVACY_NOTES.md` (de exemplu, imaginile originale se șterg după N luni, configurabil, iar datele extrase rămân).
- Aplicația nu se prezintă drept consultant financiar autorizat. „Verdictul AI”, dacă există, e etichetat ca sugestie automată.

### 6.4 API și UX
- Mutațiile trec prin server actions sau route handlers subțiri care apelează serviciile. Erori în formatul `{ error: { code, message, fields? } }`, cu coduri HTTP corecte. Documentează în `docs/API.md` doar ce există.
- Endpoint `/api/health`, cu starea bazei de date, a storage-ului, a cozii și a furnizorului AI. Nu expune versiuni sau detalii interne fără autentificare.
- Interfață mobile-first: navigare jos pe mobil, buton rapid „Scanează bon”, sidebar pe desktop. WCAG 2.1 AA de bază; stări de încărcare, eroare și gol; confirmări pentru operațiunile distructive.
- **Onboarding în 3 pași** (adaugă un cont sau importă, setează un buget, creează un obiectiv), cu opțiunea de a încărca date demo într-o gospodărie marcată „Demo”, separată de datele reale.
- Datele demo se creează doar prin `pnpm db:seed:demo` sau din onboarding, niciodată automat în producție.

## 7. Faze de implementare

Fiecare fază se termină cu: lint, type-check, teste și build verzi; `docs/ROADMAP.md` actualizat (complet, parțial, neimplementat); raportul din secțiunea 8.

### Faza 0 — Fundație și infrastructură
- **Înainte de cod**, verifică și raportează starea sistemului: spațiul pe disc, Node, pnpm, nginx, Ollama, LiteLLM. Propune un plan de eliberare a discului (minimum 8 GB liberi) și **așteaptă aprobarea** înainte de orice ștergere sau instalare.
- După aprobare: PostgreSQL 16 nativ, cu baze separate pentru dezvoltare și teste și cu roluri separate (`app`, cu `NOBYPASSRLS`, și `migrator`).
- Proiect Next.js, TypeScript strict, Tailwind, shadcn/ui, ESLint, Prettier, Vitest, Playwright. `lib/config.ts` cu `APP_MODE`, modulul `entitlements` pentru `personal`, `lib/storage.ts`, `lib/money.ts` complet cu teste.
- Unități systemd pentru `web` și `worker`, un vhost nginx pe un subdomeniu, cu HTTPS, și `/api/health`.
- GitHub Actions: install, lint, type-check, teste (cu Postgres ca serviciu), build, scanarea secretelor.
- Documentație: `README.md`, `docs/ARCHITECTURE.md`, `docs/INFRA.md`, `docs/ROADMAP.md`, `docs/adr/0001-stack.md`.
- **Sarcină umană, pornită în paralel:** colectarea a 50–100 de bonuri reale (inclusiv șterse, mototolite, lungi, cu reduceri și garanție SGR) și a câte 2–3 extrase pentru băncile folosite, anonimizate, în `fixtures/`, fiecare cu rezultatul așteptat completat manual.
- **Acceptare:** aplicația goală răspunde prin nginx, pe HTTPS; `/api/health` e verde; CI e verde; testele pentru bani trec.

### Faza 1 — Autentificare, profil, gospodărie
- Login cu parolă și magic link, logout, resetare și schimbare parolă, listă de sesiuni active cu revocare.
- `personal`: `pnpm admin:create-user` și `pnpm admin:reset-password`; înregistrarea publică e dezactivată. `saas`: înregistrare publică cu verificare email.
- Gospodărie personală creată automat, `user_preferences`, pagina de profil. `lib/authz.ts`, context RLS, middleware pentru rutele protejate, rate limiting, antete de securitate.
- **Acceptare:** E2E pentru login și logout în ambele moduri; în `personal`, `/register` răspunde 404; teste pentru rate limiting, expirarea sesiunilor și RLS. Revizuire de securitate.

### Faza 2 — Conturi, categorii, tranzacții, transferuri
- CRUD pentru conturi (cu arhivare), categorii de sistem și personalizate, tranzacții cu căutare, filtre, sortare și paginare cu cursor. Transferuri atomice; sold calculat.
- **Acceptare:** teste pentru solduri, transferuri (inclusiv rollback) și izolarea între gospodării pentru fiecare endpoint; E2E pentru adăugarea unei cheltuieli și verificarea soldului.

### Faza 3 — Dashboard, bugete, obiective, rapoarte, export, backup
- Dashboard: venituri, cheltuieli, sold net și număr de tranzacții; cheltuieli pe categorii (din toate sursele); evoluția lunară și trendul zilnic; comparație cu luna anterioară; totaluri separate pe monedă; selector de lună. Onboarding în 3 pași.
- Etichete (5.4) și filtre pe pagina de tranzacții: interval de date, comerciant, tip, sumă minimă și maximă, categorie, etichete. Filtrele se păstrează în URL fără date sensibile (de exemplu doar ID-uri de categorie și intervale), ca o vedere să poată fi salvată.
- Bugete generale și pe categorie, cu semafor (verde sub pragul de avertizare, galben între prag și 100%, roșu peste 100%) și avertizare în aplicație.
- Obiective: țintă, termen, progres, stare.
- Raport lunar și export CSV.
- **Backup zilnic** (`pg_dump` plus fișierele din `storage`), criptat, copiat în afara containerului, cu retenție. Restaurarea este **testată efectiv**. Fără backup testat nu se introduc date reale.
- **Acceptare:** teste pentru semafor și limitele de lună în `Europe/Bucharest`, pentru conținutul CSV și izolarea exportului; restaurarea din backup executată și documentată.

> **Reper v0.1 personal:** după Faza 3, aplicația poate fi folosită zilnic cu introducere manuală.

### Faza 4 — Rezervată pentru stabilizare
- Corectarea problemelor găsite în prima săptămână de folosire reală, accesibilitate de bază și performanță. Fără funcții noi. Se poate sări dacă nu e nevoie.

### Faza 5 — Recurențe
- CRUD pentru reguli, cu stările `active`, `paused` și `completed` (după `end_on` sau după numărul de rate), filtre pe stare și contorul „active · de generat · total”. Worker pg-boss care rulează orar, plus butonul „Generează scadentele” pentru rulare la cerere, cu aceeași garanție de idempotență. La reluarea de pe pauză, lunile sărite nu se generează retroactiv. Idempotență prin `recurring_occurrences`, recuperare limitată a ocurențelor ratate, cazurile ziua 31 și 29 februarie, dezactivare, `end_on`.
- **Acceptare:** jobul rulat de două ori sau în paralel nu creează duplicate; testele pentru cazurile de calendar trec.

### Faza 6 — Ingestia bonurilor (miezul produsului)
- O singură pagină „Import” pentru poze, PDF, CSV, Excel și ZIP; tipul documentului (bon sau extras) se detectează automat. Contorul de consum al zilei e afișat lângă zona de încărcare. Modul „bon lung” e un comutator explicit: când e activ, utilizatorul alege 2–4 poze în ordine de sus în jos, vede miniaturile numerotate și le poate reordona înainte de procesare. Aplicația unește și singură pozele care au același CUI și același număr de bon.
- Încărcare foto sau PDF, una sau mai multe fișiere; `documents` și `processing_batches`; coadă pg-boss; stări vizibile în interfață.
- Preprocesare cu sharp: rotire după EXIF, decupare, contrast, redimensionare; eliminarea EXIF.
- Pipeline de extracție prin `lib/ai`, cu furnizor local întâi; rezervă externă doar cu consimțământ. Ieșire JSON validată cu Zod, conform 5.5.
- **Bon lung din 2–4 poze:** liniile se combină în ordine, iar cele duplicate din zona de suprapunere se elimină.
  - Se elimină doar suprapunerea de la granița dintre două poze consecutive (cel mai lung șir de linii identice între sfârșitul unei poze și începutul următoarei). Produsele identice care apar în alte locuri pe bon rămân.
  - Ordinea se verifică: antetul (magazin, CUI) trebuie să fie pe prima poză, iar totalul pe ultima. Altfel utilizatorul primește un mesaj clar și opțiunea „Ordonează automat”.
  - Rezultatul unirii se arată înainte de salvare, cu liniile eliminate tăiate și cu motivul afișat, iar suma liniilor păstrate se compară cu totalul bonului.
- Ecran de verificare înainte de salvare: liniile, categoriile propuse și nepotrivirile evidențiate. Corecturile actualizează `product_aliases`.
- Deduplicare: fișier identic (sha256), poză aproape identică (hash perceptual), același bon fotografiat din nou (CUI + număr + dată + total).
- Căutare în textul OCR. Limite prin `entitlements`, cotă de stocare. Deduplicarea și verificările nu sunt limitate de plan.
- Pagina „Bonuri”: istoric cu data, comerciantul, categoriile (toate, nu doar una per bon), totalul, starea (`queued`, `needs_review`, `done`, `failed`) și acțiunile (vezi bonul, reprocesează, șterge). Căutare după magazin, produs sau sumă (acceptă „45,90” și „45.90”), filtru după categorie, etichetă și stare. Butonul „Scanează” e accesibil de oriunde, iar bonurile „De verificat” apar primele.
- **Evaluare:** comandă `pnpm eval:receipts`, care rulează pipeline-ul pe `fixtures/receipts` și raportează, per furnizor: acuratețea pe total, dată, CUI, linii, timpul mediu și costul estimat.
- **Acceptare:** rezultatul evaluării e inclus în raport, cu cifrele exacte; furnizorul implicit e ales pe baza lor și documentat într-un ADR; teste pentru validările din 5.5, deduplicare și securitatea încărcării. Revizuire de securitate.

### Faza 7 — Extrase bancare, potrivire, detectarea abonamentelor
- Import CSV, Excel, PDF și ZIP; detectarea băncii; **un parser per bancă**, începând cu banca folosită de tine; fiecare parser are fișier de test în `fixtures/statements`.
- Băncile țintă, aceleași pe care le acoperă produsul de referință: **ING, BT, BCR, BRD, Raiffeisen, Revolut și Wise**. Ordinea de implementare: întâi băncile pentru care există extrase reale în `fixtures/statements`, apoi restul. O bancă e considerată suportată doar când parserul ei trece testele pe un extras real anonimizat; până atunci, extrasele ei trec prin maparea manuală de coloane.
- Revolut și Wise au conturi în mai multe monede: fiecare monedă devine un cont separat în FINET, iar schimburile valutare din extras se importă ca transferuri între aceste conturi (cu ambele sume), nu ca venituri sau cheltuieli.
- Previzualizare, mapare de coloane pentru CSV necunoscute, deduplicare după (cont, dată, sumă, descriere normalizată, referință), anularea unui import întreg.
- Tabel „Acoperire extrase”: conturi × luni, cu starea complet, parțial (până la ce dată) sau lipsă, și avertizare pentru lunile fără extras pe un cont.
- **Potrivire bon ↔ tranzacție:** sumă exactă, fereastră de ±3 zile, asemănarea comerciantului (CUI sau nume normalizat). Fiecare sugestie are scor și motive vizibile; utilizatorul o confirmă sau o respinge. Nu se creează niciodată două tranzacții pentru aceeași cheltuială.
- Detectarea plăților recurente din istoric (comerciant, sumă similară, periodicitate), propuse ca reguli în Faza 5.
- **Acceptare:** teste pe fișierele de test ale fiecărei bănci; teste pentru importul dublu, potrivire (cazuri pozitive, negative și ambigue) și ZIP-uri malițioase. Revizuire de securitate.

### Faza 8 — Familie
- Invitații prin link cu token (`/join/[token]`, expirabil, de unică folosință), roluri, părăsirea gospodăriei și eliminarea unui membru.
- Conturi și bugete personale și comune; vizibilitatea per membru documentată.
- Împărțirea cheltuielilor (egal, procente, sume fixe), solduri reciproce, decontări (inclusiv parțiale).
- **Acceptare:** suma părților este egală cu totalul; solduri corecte cu 2 și 3 membri; permisiunile pe roluri sunt testate. Revizuire de securitate.

### Faza 9 — Hardening, PWA și offline
- Manifest PWA, iconițe, ghid de instalare pentru iOS și Android.
- Service worker care pune în cache doar asset-urile statice și pagina `/offline` (care trebuie să existe).
- **Scanare offline:** pozele se păstrează temporar în IndexedDB, se încarcă automat la revenirea conexiunii și se șterg local după confirmarea serverului. Starea „în așteptare” este vizibilă.
- Audit de accesibilitate (Lighthouse ≥ 90) și de securitate pe `docs/SECURITY_CHECKLIST.md`. Export și ștergere GDPR.
- **Acceptare:** E2E pentru scanarea în modul offline și sincronizarea ulterioară; checklist-ul completat cu dovezi; E2E pentru export și ștergerea contului.

> **Reper v1.0 personal:** după Faza 9, varianta `personal` este completă.

### Faza 10 — Liste de cumpărături și prețuri (comună ambelor moduri)
- Liste comune, bifare la raft, comparație listă ↔ bon (produse neplanificate, produse uitate).
- Prețuri per produs normalizat și per magazin, evoluție în timp, cel mai ieftin magazin pentru produsele tale. Rezultatele sunt afișate doar când există suficiente date (prag configurabil).
- **Rapoarte de micro-cheltuieli** peste `receipt_lines`: pungi și sacoșe, garanții SGR (plătite față de recuperate), cumpărături de la casă (dulciuri, gumă), produse nealimentare la supermarket, cafea și băuturi la bucată, economii din reduceri și carduri de fidelitate.
  - Fiecare raport e o **definiție în date**, nu cod separat (`report_definitions`: nume, reguli de potrivire pe `normalized_name`, categorie, etichetă sau tip de linie, sfat). Utilizatorul își poate face propriul raport din aceleași reguli, ceea ce acoperă „generatorul pe articole”.
  - Fiecare raport afișează totalul pe perioadă, numărul de bucăți, prețul mediu pe unitate, proiecția anuală (calculată din perioada efectiv acoperită de bonuri și marcată ca estimare), istoricul liniilor potrivite (cu link la bon) și export CSV.
  - Sfaturile sunt texte fixe, verificabile; nu se afișează sume de economie inventate.
- **Acceptare:** teste pentru regulile de potrivire pe linii de bon reale din `fixtures/receipts` (de exemplu, „PUNGA RAFIE” intră la pungi, iar „PUNGI MENAJ 35L” nu), pentru proiecția anuală pe perioade scurte și pentru exportul CSV.
- Export Excel și PDF.

### Faza 11 — Fundația SaaS (doar `APP_MODE=saas`)
- Pagini publice randate pe server: prezentare, `/pricing`, `/help` (ghid, întrebări frecvente), `/terms`, `/privacy`, cu texte juridice revizuite de un om.
- Mențiuni legale pentru consumatori din România, în footer-ul fiecărei pagini: datele firmei care operează serviciul (denumire, CUI, număr de înregistrare la Registrul Comerțului, sediu, contact) și linkurile ANPC SAL și platforma europeană SOL.
- Turnstile, Google OAuth, traducerea în engleză.
- Feedback și raportare de bug-uri din aplicație (fără date financiare), anunțuri de la administrator.
- Panou de administrare: utilizatori, gospodării, joburi, feedback. Acțiunile administratorului sunt auditate. Administratorul **nu vede** datele financiare ale utilizatorilor.
- Monitorizarea erorilor; analytics doar pe paginile publice; nume de produs definitiv.
- **Acceptare:** rutele de admin răspund 404 pentru non-administratori și în modul `personal`; testele E2E de bază trec în ambele moduri.

### Faza 12 — Planuri, plăți, recomandări (doar `saas`)
- `plans` și `subscriptions`, implementarea `saas` a `entitlements`. **Limitele și prețurile sunt decizia ta**, stabilite după costul pe document măsurat în Faza 6, configurate în date.
- Stripe Checkout și Customer Portal, lunar și anual, webhook-uri idempotente, perioadă de probă. La expirarea abonamentului, datele rămân accesibile pentru citire și export.
- Recomandări: cod per utilizator, distribuire (Web Share API, link copiat), recompensă aplicată o singură dată, plafon, protecție împotriva auto-recomandării.
- Migrația documentată `personal` → `saas`, cu planul „fondator”.
- **Acceptare:** fiecare limită de plan e testată pe server; webhook-urile sunt simulate cu Stripe CLI, inclusiv evenimente duplicate; o gospodărie cu abonament expirat își poate exporta datele. Revizuire de securitate.

### Opțional, după validare
Conversia valutară cu cursul BNR, notificări push, email și Telegram, alte limbi, mai multe bănci, integrare PSD2 doar printr-un agregator licențiat și verificat. Nu prezenta aceste funcții ca implementate până nu sunt construite și testate.

## 8. Raport obligatoriu la finalul fiecărei faze

1. Ce ai implementat efectiv și ce a rămas parțial sau neimplementat.
2. Fișierele create sau modificate.
3. Comenzile de verificare rulate și rezultatele exacte (inclusiv eșecurile).
4. Instrucțiunile de pornire și, dacă e cazul, de deploy.
5. Variabilele de mediu noi (doar numele și scopul, fără valori).
6. Riscurile, limitările, ADR-urile noi și constatările revizuirii de securitate.
7. Următorii pași prioritizați.

## 9. Riscuri cunoscute

| Risc | Impact | Măsură |
|---|---|---|
| OCR slab pe bonuri reale | Produsul nu convinge | Set de validare înainte de cod; evaluare per furnizor (Faza 6); ecran de verificare obligatoriu |
| Disc aproape plin (5,3 GB liberi) | Totul se oprește | Eliberare înainte de Faza 0; comprimarea imaginilor; cotă; spațiul ocupat afișat în `/api/health`; storage extern la nevoie |
| Modele AI locale mari | Nu încap pe disc sau în RAM | Se măsoară în Faza 6; rezervă externă cu consimțământ |
| Formatele extraselor se schimbă | Importul se strică | Un parser per bancă, fișiere de test și alertă la eșecul de parsare |
| Erori în logica banilor | Grav, mai ales în familie | `bigint` în unități minore, restul cel mai mare, teste dedicate |
| Funcțiile adăugate prea devreme | Nu se termină nimic | Fazele 10–12 doar după v1.0 personal |
| O funcție SaaS ajunsă în modul `personal`, sau invers | Comportament greșit | `entitlements` și testele E2E în ambele moduri |
| Numele „FINET”: există deja produse cu nume apropiat (de exemplu ERP-ul financiar „FINet”) | Risc juridic în `saas` | Verificare la OSIM și EUIPO (clasele 9, 36, 42) și a domeniilor înainte de lansarea publică; numele vine din `NEXT_PUBLIC_APP_NAME` (implicit `FINET`), ca o eventuală schimbare să nu ceară modificări de cod. Logo-ul nu imită simbolul produsului de referință (linia de puls verde) |
| Obligații legale în `saas` | Lansare blocată | Termeni și politică de confidențialitate reale, acorduri de prelucrare cu furnizorii, facturare și TVA pentru abonamente |
| Scurgere de date financiare | Notificare GDPR, încredere pierdută | Autorizare în două straturi, loguri fără date sensibile, teste de izolare |

---

Începe prin a citi `docs/ROADMAP.md` (creează-l în Faza 0 dacă lipsește), apoi execută **doar** faza cerută în sesiunea curentă.
