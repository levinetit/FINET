# ADR 0006 — Interfața registrului (Faza 2, F2-C)

- **Stare:** propus (F2-C: paginile conturilor, tranzacțiilor, transferurilor și categoriilor, soldurile pe dashboard, comutatorul `usage_stats`, E2E `ledger`).
- **Legături:** master prompt 3.4, 5.1, 5.3, 6.3, 6.4, 6.5, Faza 2; ADR 0003 (paginile Fazei 1, CSP), ADR 0004 (registrul), ADR 0005 (API-ul, `Idempotency-Key`, `X-FINET-Client`).

## Context
Serviciile (F2-A) și API-ul (F2-B) există. Interfața trebuie să arate soldurile, să permită venituri, cheltuieli, transferuri și categorii, fără float, sub CSP-ul strict cu nonce (fără `style=`), cu aceeași autorizare ca API-ul și fără dependențe noi.

## Decizii

### Citiri pe server, mutații prin API
- Fiecare pagină protejată apelează `requireLedgerPage(<cale>)` (`src/app/_lib/ledger-page.ts`): `requirePageSession` (redirecționare 307 la `/login?next=`), gospodăria curentă **din bază** (ca `currentHousehold` din `/api/v1`) și starea consimțământului `usage_stats`. Layout-ul `(app)` nu verifică sesiunea în locul paginilor.
- Datele se citesc direct din servicii, pe server (aceleași `withMember` + RLS ca API-ul), și ajung la componentele client în forma JSON a API-ului (`*ToJson`, `amountMinor` întreg). `load()` transformă `NotFoundError` în `notFound()` (404 uniform, inclusiv pentru id-uri străine sau invalide) și orice altă eroare într-o stare de eroare fără detalii.
- **Mutațiile trec doar prin `/api/v1/*`** (`fetch` din `api-client.ts`), nu prin server actions: aceleași validări, CSRF, rate limiting, audit și idempotență ca pentru Android (decizia mea, cerută de brief).
- După o mutație reușită: `router.push` + `router.refresh()` (datele se recitesc pe server).

### Bani în UI
- Intrarea: text (`inputMode="decimal"`) → `parseAmount` (virgulă sau punct; `1.234` e ambiguu și refuzat) → `toJson` → `amountMinor` întreg. Mesajele vin din `ro.ledger.amountErrors` după `InvalidAmountError.reason` (nu din textul excepției).
- Afișarea: `formatMoney(fromJson(...))`, `1.234,56 lei`. Valoarea din câmpul de editare: `toDecimalString` cu virgulă.
- Totalurile pe monedă vin din serviciu (doar conturi active, fără conversie). Nicio aritmetică pe sume în UI; testul `src/app/ui-rules.test.ts` pică la `parseFloat`, `toFixed`, `* 100`, `/ 100` sau `Number(…amount…)` în `src/app` și `src/components`.
- Filtrul de sume din `/transactions` se parsează cu moneda RON (decizia mea: toate monedele permise au două zecimale; filtrul e pe `amount_minor`, independent de monedă).

### Idempotență și dublu-clic
- `useSubmit()` (`src/app/_lib/use-submit.ts`): o blocare **sincronă** (`useRef`) — un dublu-clic produce două evenimente înainte ca React să redeseneze, deci butonul dezactivat nu ajunge — plus butonul dezactivat cât timp cererea e în curs. După un 2xx formularul rămâne blocat până la navigare (`lockOnSuccess`).
- `Idempotency-Key` pe crearea conturilor, categoriilor, tranzacțiilor și transferurilor: UUID legat de corpul trimis; se păstrează doar la reîncercarea aceluiași corp după rețea/5xx/409 `request_in_progress`, se aruncă după 2xx sau orice alt 4xx (răspunsul e memorat de server; un corp corectat cu aceeași cheie ar primi 422). Funcții pure în `idempotency-key.ts`, testate.

### `X-FINET-Client` doar cu consimțământ
- Serverul înregistrează instalarea ori de câte ori antetul e valid, fără să verifice consimțământul (ADR 0005), deci regula e în client: antetul `platform=web; installation=<uuid>; locale=ro-RO` pleacă doar pe `/api/v1/*` și doar cât `usage_stats` e acordat.
- Starea vine de la server la fiecare pagină (`PageHeader usageStats` → `UsageSync`), nu din `localStorage` (ar rămâne învechită între utilizatori). Comutatorul din `/profile` (`PUT /api/v1/me/consents`) o schimbă în memorie imediat după succes. Identificatorul instalării (UUID aleator) stă în `localStorage`, cu rezervă în memorie dacă stocarea e blocată.
- Forma antetului e verificată în teste cu parserul serverului (`parseClientInfo` → `platform: "web"`).

### Pagini și navigare
- `/accounts`, `/accounts/new`, `/accounts/[id]` (editare, arhivare/dezarhivare, ștergere doar pentru un cont fără tranzacții, moneda blocată după prima tranzacție), `/transactions` (filtre prin formular GET, deci adresa poartă filtrele; prima pagină pe server, „Încarcă mai mult” cu cursorul API-ului, fără duplicate), `/transactions/new?type=expense|income`, `/transactions/[id]` (venit/cheltuială: editare și ștergere; rând de transfer: detaliile ambelor conturi și „Șterge transferul”), `/transfers/new` (o sumă la aceeași monedă, două sume la monede diferite), `/categories` (ascundere/afișare, creare, redenumire, ștergere cu reasignare). Formulare pe pagini separate, nu dialoguri (decizia mea: fără componente noi, URL-uri directe pentru izolare și 404).
- `/dashboard` păstrează placeholder-ul Fazei 3 și adaugă „Soldurile tale” și ultimele 5 tranzacții; fără grafice.
- Navigarea: Acasă, Tranzacții, Conturi, Categorii, Profil (bară jos pe telefon, meniu lateral pe desktop); fără pagini pentru funcții neimplementate.
- Data implicită: azi în `Europe/Bucharest`, calculată pe server (fără nepotriviri la hidratare).
- Componente noi scrise de mână (`Field`, `ConfirmButton`, `UsageSync` în `src/components/ledger/`), fără dependențe noi. Texte în `src/messages/ro.ts`; mesajele de câmp ale API-ului (fixe, în română, fără ecoul valorii) se afișează la câmp.

### E2E
- Proiectul Playwright `ledger` (`e2e/ledger.spec.ts`), aceleași cerințe ca `auth`, rulat în ambele moduri în CI, cu utilizatori proprii (`ledger`, `ledger2`, `seed`) creați prin CLI-ul admin: mutațiile API sunt limitate la 120/min per utilizator, iar seed-ul de paginare (56 de cereri) are utilizatorul lui.
- Testele se pot relua pe aceeași bază (CI reîncearcă o dată): nume cu sufix unic și verificări pe diferențe.
- CSP: în dezvoltare `style-src` are `'unsafe-inline'`, deci un `style=` nu produce încălcare în browser. De aceea scenariul (h) verifică și HTML-ul fiecărei pagini (fără `style=`), iar `ui-rules.test.ts` interzice `style=` în surse; evenimentele `securitypolicyviolation` sunt colectate prin `addInitScript`.

## Consecințe
- Fără migrații noi; fără dependențe noi.
- `apiFetch` acceptă acum `PUT`, `rawBody`, `idempotencyKey` și întoarce și corpul complet (`raw`, pentru `nextCursor`).
- Rămân: editarea transferurilor din UI (API-ul `PATCH /transfers/{groupId}` există), subcategoriile în UI, culorile/pictogramele categoriilor, comutarea gospodăriei (Faza 8).
