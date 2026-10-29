# ADR 0017 — Familia: API, interfață și actualizări live (SSE)

- **Stare:** propus (F8-B, branch `phase/08-family`). Deploy: operatorul, după revizuiri (`docs/INFRA.md`, „4k”).
- **Legături:** master prompt Faza 8 (7), 6.4 (API), 3.4 (UI); ADR 0005 (API v1), 0006 (UI registru), 0016 (date și servicii familie, inclusiv corecțiile revizuirii F8-A).

## Context

F8-A a livrat serviciile (`src/modules/family/**`). Faza 8 cere și endpointurile `/api/v1/` pentru membri, invitații, împărțiri și decontări, comutatorul de gospodărie (web și API), paginile `/join/[token]` și `/family`, widgetul „Ai de dat / Ai de primit” și actualizări live între membri „fără serviciu extern”: evenimentul poartă doar tipul și id-ul, datele se recitesc prin server cu RLS.

## Decizii

### 1. API (`src/app/api/v1/_lib/family-handlers.ts`)

| Metodă și cale | Rol | Note |
|---|---|---|
| `GET /family/members` | membru | id, nume, rol, data intrării; fără emailuri |
| `PATCH /family/members/{id}` | owner | `{ role }`; ultimul owner → 409 `last_owner` |
| `DELETE /family/members/{id}` | owner | 200 `{ unsettledBalance }` (avertisment, nu eroare) |
| `POST /family/members/{id}/transfer-ownership` | owner | atomic |
| `POST /family/leave` | oricine | 200 `{ unsettledBalance }`; 409 `last_owner`, `sole_member` |
| `GET /family/invites` | owner | starea, FĂRĂ token |
| `POST /family/invites` | owner | 201 `{ invite, token, joinPath }`: tokenul O SINGURĂ DATĂ |
| `POST /family/invites/{id}/revoke` | owner | 409 `invite_not_active` |
| `POST /invites/accept` | utilizator autentificat | `{ token }` în corp; 404 uniform `invite_unavailable`; 429 + `Retry-After` |
| `PUT /households/active` | membru al țintei | străină → 404 |
| `GET /family/balances` | membru | perechi, net, `formerMemberIds`, `me` |
| `GET`/`POST /family/settlements`, `POST /family/settlements/{id}/cancel` | membru (reguli ADR 0016, 8) | `POST` cu `Idempotency-Key` opțional |
| `GET /family/splits`, `GET`/`PUT`/`DELETE /transactions/{id}/split` | membru / plătitorul | `PUT` = înlocuire integrală |
| `GET /events` | membru | SSE (punctul 3) |

- **Gospodăria** vine mereu din `currentHousehold` (preferința activă doar dacă apartenența există la acea cerere), niciodată din cerere. Zod strict în servicii, 404 uniform, CSRF prin `Origin` pe mutațiile cu cookie, limita generală de mutații (120/min) — ca restul `/api/v1`.
- **Crearea invitației NU acceptă `Idempotency-Key`** (400, decizia mea): stratul de idempotență memorează corpul răspunsului în `idempotency_keys.response` 24 h, deci tokenul ar ajunge în bază în clar, încălcând „doar hash-ul”. Dublurile sunt limitate de 20 de invitații / 24 h / gospodărie și de blocarea dublului-clic în UI. Testat: tokenul nu apare în `idempotency_keys`.
- **Acceptarea** nu trece prin `idempotentCreate`: `acceptInvite` cere un client (`Db`) pentru că limita de rată se consumă în afara tranzacției (și pentru tokenurile greșite); acceptarea e natural idempotentă (a doua oară = deja membru, nimic consumat). Limita: `ApiLimits.inviteAccept` (implicit 10 / 15 min per utilizator). Tokenul stă în corpul `POST`, nu în URL-ul API-ului.
- **Erorile noi** sunt mapate în `errorPayload`: `InviteUnavailableError` → 404, `InviteRateLimitedError` → 429 cu `Retry-After`. Motivele de conflict (`transaction_split`, `last_owner`, `settlement_exceeds_debt`, `balance_limit` …) ajung în `reason` și au texte în `src/messages/ro.ts`.
- **Împărțirea** e `PUT` (nu `POST` idempotent): înlocuiește integral; testul OpenAPI cere ca operațiile cu `Idempotency-Key` să fie `POST`.

### 2. Interfața

- **`/join/[token]`** (în grupul autentificat; fără sesiune → login cu `next=/join/<token>`, validat de `safeNextPath`). La DESCHIDERE nu se consumă și nu se verifică nimic (o previzualizare de link sau un prefetch nu folosesc invitația; pagina nu spune dacă tokenul există); butonul „Acceptă invitația” trimite `POST`. Numele gospodăriei nu apare înainte de acceptare. `referrer: no-referrer`, `noindex`. Mesajele: unul singur pentru orice invitație inutilizabilă; 429 cu minutele; gospodărie plină.
- **`/family`**: soldurile („Ai de dat / Ai de primit”, perechile, foștii membri ca „fost membru”), decontările (formular cu sugestia soldului; o sumă mai mică = parțială; anularea pentru oricare parte sau creator), membrii (roluri, transfer, eliminare cu avertisment de sold, plecare), invitațiile (doar owner; linkul apare o singură dată, doar în memoria componentei, cu „Copiază”), împărțirile recente și „Ce văd ceilalți membri” (conturi și bugete comune vs personale, nota despre bonuri).
- **Comutatorul** de gospodărie: în layout-ul paginilor autentificate, deasupra conținutului, doar cu ≥ 2 gospodării; după schimbare, pagină completă la Acasă (decizia mea: formularele deschise aparțin gospodăriei vechi).
- **Împărțirea** se face pe `/transactions/[id]` (cardul „Împarte cheltuiala”, doar pentru o cheltuială din contul TĂU personal, cu ≥ 2 membri): egal, procente (textul `33,33` → 3333 puncte de bază prin aceeași parsare exactă ca sumele, fără float), sume fixe. Cât timp există, cardul explică blocarea sumei/contului/tipului; formularul tranzacției primește 409 `transaction_split` cu mesajul românesc. Pe formularul de creare NU (decizia mea: plătitorul alege întâi contul personal; împărțirea are nevoie de id-ul tranzacției și de totalul salvat).
- **Conturi personale**: bifa „Cont personal (îl vezi doar tu)” la creare și insigna „Personal” în listă; la editare, un cont personal se poate face comun, unul comun nu poate deveni personal (ADR 0016).
- **Acasă**: widgetul „Împărțeli în familie” (Ai de dat / Ai de primit pe monedă) apare când gospodăria are mai mulți membri sau există solduri.
- **Navigarea**: „Familie” în meniul lateral și în „Mai mult” pe telefon (bara de jos rămâne neschimbată).
- Fără `style=`, fără `dangerouslySetInnerHTML`, CSP cu nonce neschimbat (`connect-src 'self'` acoperă `EventSource`), texte în română, componente accesibile (etichete, `fieldset/legend`, regiuni `aria-live`).

### 3. Actualizările live: SSE în procesul web, cu rezervă pe interogare periodică

- **Transport:** `GET /api/v1/events`, `text/event-stream`. Mesaje: `ready` (cu `retry: 5000`), `change` cu `data: {"type","id"}` (tipuri: `transaction`, `transfer`, `receipt`, `split`, `settlement`, `member`), `close` (sesiunea sau apartenența s-au schimbat), `reconnect` (după durata maximă), `evicted` (plafonul per utilizator). Comentariul `: ping` la 25 s.
- **Sursa evenimentelor (decizia mea): o magistrală în memoria procesului `finet-web`** (`src/modules/live/live-bus.ts`, pe `globalThis`), publicată de handlerele API DUPĂ încheierea mutației (după COMMIT-ul cheii de idempotență, ca cine reîncarcă imediat să vadă datele). Alternative respinse:
  - `LISTEN/NOTIFY` Postgres: web-ul folosește pooler-ul Supabase în **mod tranzacție** (6543), care nu suportă `LISTEN`; o conexiune dedicată per flux ar consuma pool-ul (5 pe proces);
  - interogarea periodică a bazei pe server (cursor peste `audit_events`/`updated_at`): crearea tranzacțiilor nu e auditată, ștergerile nu lasă rânduri, iar filtrul de vizibilitate pentru o ștergere nu se mai poate calcula după ea;
  - serviciu extern (Redis, Pusher): interzis de master prompt.
- **Publicul (confidențialitate):** o tranzacție sau un transfer care atinge DOAR conturi personale ale actorului ajunge doar la el (`accountsAudience`, citit sub RLS-ul actorului, fail closed = doar actorul); dacă atinge un cont comun, la toată gospodăria. La modificare se ia publicul cel mai larg dintre contul vechi și cel nou (o mutare comun ↔ personal e anunțată și celor care pierd tranzacția); la ștergere, publicul se calculează înainte. Împărțirile, decontările, membrii și bonurile sunt deja vizibile tuturor (ADR 0016), deci ajung la toată gospodăria. Testat: tranzacția din contul personal al lui B NU ajunge la A (nici id-ul); cea din contul comun da.
- **Siguranța fluxului:** sesiune obligatorie (cookie sau bearer, ca restul API-ului; trece prin `src/proxy.ts`, deci prin verificarea Cloudflare Access); scopat pe gospodăria curentă; la fiecare puls se reverifică sesiunea (`requireSession`) și faptul că gospodăria curentă e aceeași, altfel `close`; la eliminare, plecare și comutarea gospodăriei, fluxurile utilizatorului pentru vechea gospodărie se închid IMEDIAT (`closeLiveFor`), fără să aștepte pulsul; durata maximă 5 minute (o sesiune revocată nu rămâne conectată mai mult); cel mult 4 conexiuni per utilizator — la a cincea, cea mai veche primește `evicted` (decizia mea: o filă închisă brusc, a cărei deconectare nu a fost detectată, nu poate bloca utilizatorul; fila evacuată trece pe rezervă, fără reconectare imediată, ca filele să nu-și ia conexiunea în buclă) — și 200 în total (429); curățare la `abort`/`cancel` (testată: contorul revine la 0). Nicio conexiune la bază nu e ținută între pulsuri.
- **Bufferizarea:** `Cache-Control: no-store, no-transform` (pachetul de compresie al serverului Next nu comprimă/bufferizează un răspuns `no-transform`), `X-Accel-Buffering: no`. Cloudflare nu bufferizează `text/event-stream` și închide conexiunile inactive după ~100 s (planurile standard) — pulsul de 25 s e sub prag. Traefik nu bufferizează răspunsurile implicit. **Verificare reală prin tunel/Access: NOT RUN** (pasul operatorului, INFRA 4k).
- **Clientul** (`src/components/app/live-updates.tsx`, în layout): la `change` → `router.refresh()` grupat la 400 ms și doar cu fila vizibilă (altfel la revenire): componentele server recitesc datele prin aceleași servicii, cu RLS-ul utilizatorului (echivalentul „reîncarcă prin API”, fără endpoint suplimentar). **Rezerva** (interogare periodică): după 3 eșecuri consecutive ale fluxului, reîncărcarea datelor la 60 s (doar cu fila vizibilă) și o nouă încercare SSE la 5 minute.
- **Limitări asumate:** o singură instanță web (ADR 0002); mai multe instanțe ar cere o magistrală comună (de exemplu `LISTEN` pe o conexiune în mod sesiune). Schimbările făcute de **worker** (bonuri procesate, recurențe generate în fundal) sau de CLI nu produc evenimente: apar la următoarea navigare (pagina `/import` are deja interogarea ei); bonul CONFIRMAT de un membru produce `receipt` + `transaction`.

## Consecințe

- Nicio variabilă nouă și niciun secret nou. Migrația rămâne `0012_family` (F8-A).
- Fluxurile SSE țin câte un socket deschis per filă (≤ 4 per utilizator); la o familie de 6, sub 30 de sockets.
- Un token de invitație apare în URL-ul paginii `/join/<token>`, deci poate apărea în jurnalele proxy-urilor (Cloudflare, Traefik) și în istoricul browserului celui invitat; atenuări: unică folosință, ≤ 168 h, revocabil, `no-referrer`, nu se loghează în aplicație.
