# FINET — API-ul `/api/v1`

Documentează **doar ce există** (Faza 1, F2-B și F3-B). Contractul complet, generat din cod: `docs/openapi.json` (OpenAPI 3.1; `pnpm openapi:generate`, verificat în CI cu `pnpm openapi:check`). Deciziile: `docs/adr/0005-api-v1.md` (registrul) și `docs/adr/0007-planning-reporting.md` (planificare, rapoarte, export).

Valorile din exemple sunt **fictive** (`finet.example`, tokenuri și id-uri inventate).

## Autentificare
- **Web:** cookie-ul de sesiune Better Auth (`finet.session_token`, cu prefixul `__Secure-` în producție), primit la `POST /api/auth/sign-in/email`. Mutațiile cu cookie cer `Origin` egal cu originea aplicației (CSRF); altfel 403.
- **Android / alți clienți:** `Authorization: Bearer <token>`, unde tokenul e antetul `set-auth-token` din răspunsul de login. Fără cookie, deci fără verificarea `Origin`.
- În modul `personal`, orice cerere trece întâi prin Cloudflare Access (`docs/INFRA.md`).
- Fără sesiune validă: `401 unauthenticated`, pe orice endpoint.

```bash
curl -s https://finet.example/api/auth/sign-in/email \
  -H 'content-type: application/json' -H 'x-finet-client: android/1.0.2' \
  -d '{"email":"ana@exemplu.ro","password":"parola-fictiva-123"}' -D - -o /dev/null | grep -i set-auth-token
# set-auth-token: tokenFictiv.semnatura
```

## Convenții
- **Gospodăria** în care lucrează API-ul vine din sesiune (gospodăria curentă: cea mai veche apartenență), niciodată din cerere. Un câmp `householdId` în corp e respins (400).
- **Sume:** întregi în unități minore, `amountMinor` + `currency` (`RON`, `EUR`, `USD`); niciodată zecimale. O sumă sau un sold inițial are cel mult 10^13 unități minore (în modul), altfel 400. Mutarea unei tranzacții pe un cont în altă monedă cere și suma (altfel 409 `currency_change_requires_amount`). La creare se acceptă și `amount` ca text românesc (`"1.234,56"`), dar nu ambele.
- **Date:** `YYYY-MM-DD` (calendaristice, fără fus orar); **momente:** ISO 8601 în UTC.
- **Resurse străine:** o resursă a altei gospodării, inexistentă sau cu id invalid dă același `404 not_found`.
- Răspunsurile au `Cache-Control: no-store`.

## Erori
Format unic: `{ "error": { "code", "message", "fields"?, "reason"? } }`.

| Status | `code` | Când |
|---|---|---|
| 400 | `invalid_request` | validare; `fields` are un mesaj fix pe câmp (fără ecoul valorii); `fields._` = problemă la nivelul cererii |
| 401 | `unauthenticated` | fără sesiune validă |
| 403 | `forbidden` | mutație cu cookie fără `Origin` corect; rol insuficient |
| 404 | `not_found` | resursă inexistentă sau a altei gospodării |
| 409 | `conflict` | starea curentă nu permite operația; `reason` stabil (`account_not_empty`, `account_archived`, `category_in_use`, `system_category_readonly`, `account_name_taken`, `tag_name_taken`, `system_tag`, `budget_exists`, `goal_abandoned`, `goal_saved_negative`, `export_too_large`, …) |
| 409 | `request_in_progress` | o cerere cu aceeași `Idempotency-Key` e în desfășurare |
| 413 | `payload_too_large` | corp peste 16 KiB |
| 415 | `unsupported_media_type` | corp care nu e `application/json` |
| 422 | `idempotency_key_reused` | aceeași `Idempotency-Key` pentru altă cerere |
| 422 | `amount_out_of_range` | un sold sau un total calculat (inclusiv dashboard/raport) depășește 2^53 − 1 și nu poate fi transmis exact |
| 429 | `rate_limited` | prea multe cereri (antet `Retry-After`) |
| 500 | `internal_error` | eroare neașteptată, fără detalii |

Limite: mutațiile 120/min per utilizator; evenimentele 30/min per utilizator; exporturile CSV 10/min per utilizator.

## Paginare
`GET /api/v1/transactions?limit=50&cursor=<nextCursor>` → `{ "data": [...], "nextCursor": "…" | null }`. `limit` implicit 50, plafon 100. Cursorul e opac și valabil doar cu aceeași sortare (`sort=date_desc|date_asc|amount_desc|amount_asc`). Conturile și categoriile nu sunt paginate.

## Idempotență
`POST /accounts`, `/categories`, `/transactions`, `/transfers`, `/tags`, `/budgets`, `/goals` acceptă `Idempotency-Key: <16–128 caractere [A-Za-z0-9_-]>` (un UUID e potrivit):
- aceeași cheie + aceeași cerere în 24 h → răspunsul inițial (același status și corp), cu `Idempotent-Replay: true`, fără a doua scriere;
- aceeași cheie + alt corp (sau alt utilizator) → `422 idempotency_key_reused`;
- cererea inițială încă în desfășurare → `409 request_in_progress` (reîncearcă puțin mai târziu);
- un 4xx (de exemplu validare) se memorează; un 5xx nu (aceeași cheie poate fi refolosită după o eroare internă);
- un corp cu mai mult de 20 de niveluri de obiecte/liste → 400.

`POST /goals/{id}/contributions` **cere** `Idempotency-Key` (fără cheie → 400 cu `fields["Idempotency-Key"]`): o contribuție nu e idempotentă prin natura ei, iar o reîncercare fără cheie ar dubla suma economisită.

```bash
curl -s https://finet.example/api/v1/transactions \
  -H 'authorization: Bearer tokenFictiv.semnatura' -H 'content-type: application/json' \
  -H 'idempotency-key: 6f1d0c2e-1b7a-4c55-9a39-0d1e2f3a4b5c' \
  -d '{"accountId":"0b6c1f8e-3a2d-4e5f-8a9b-1c2d3e4f5a6b","type":"expense","amountMinor":4599,"occurredOn":"2026-10-28","merchant":"Magazin"}'
```

## Antete
- `X-FINET-Client` (opțional): `platform=android; version=1.0.2; code=10002; installation=<uuid>; os=14; model=Pixel 8; locale=ro-RO`. Chei fixe; `platform` (`android`/`web`) și `installation` obligatorii. Un antet invalid e ignorat. Serverul înregistrează instalarea doar cu consimțământul `usageStats` activ, cel mult o dată la 15 minute și cel mult 20 de instalări per utilizator; revocarea consimțământului șterge instalările și evenimentele. Forma veche `android/<versiune>` e acceptată doar pentru login și eticheta sesiunii.
- `Idempotency-Key`: mai sus.

## Endpointuri
| Metodă și cale | Ce face |
|---|---|
| `GET /api/v1/me`, `PATCH /api/v1/me` | profilul, preferințele, gospodăria curentă |
| `POST /api/v1/me/password` | schimbarea parolei |
| `GET /api/v1/me/sessions`, `DELETE /api/v1/me/sessions/{id}`, `POST /api/v1/me/sessions/revoke-others` | sesiunile |
| `GET /api/v1/me/consents`, `PUT /api/v1/me/consents` | consimțămintele (`usageStats`, `externalAi`, `externalAiStatements`) |
| `POST /api/v1/app/events` | evenimentele de utilizare |
| `GET /api/v1/households`, `GET /api/v1/households/{id}` | gospodăriile mele; membrii (fără emailuri) |
| `GET/POST /api/v1/accounts`, `GET/PATCH/DELETE /api/v1/accounts/{id}`, `POST …/{id}/archive`, `POST …/{id}/unarchive` | conturile, cu sold calculat și totaluri pe monedă (`?includeArchived=true`) |
| `GET/POST /api/v1/categories`, `GET/PATCH/DELETE /api/v1/categories/{id}`, `POST …/{id}/hide`, `POST …/{id}/unhide` | categoriile (`?kind=`, `?includeHidden=false`; ștergerea unei categorii folosite: `?reassignToId=<id>`) |
| `GET/POST /api/v1/transactions`, `GET/PATCH/DELETE /api/v1/transactions/{id}` | tranzacțiile (filtre: `q`, `accountId`, `categoryId`, `tagIds`, `merchant`, `type`, `source`, `dateFrom`, `dateTo`, `amountMinMinor`, `amountMaxMinor`, `sort`, `cursor`, `limit`); `tagIds` în corp (cel mult 10; la `PATCH` înlocuiește), `tags: [{id,name,color}]` în răspuns |
| `GET/POST /api/v1/tags`, `GET/PATCH/DELETE /api/v1/tags/{id}` | etichetele (`?includeHidden=true`; cele de sistem: doar `hidden`) |
| `GET/POST /api/v1/budgets`, `GET/PATCH/DELETE /api/v1/budgets/{id}`, `GET /api/v1/budgets/status?month=` | bugetele lunare; starea lunii (semafor) și avertizările |
| `GET/POST /api/v1/goals`, `GET/PATCH/DELETE /api/v1/goals/{id}`, `POST …/{id}/contributions`, `POST …/{id}/abandon` | obiectivele (`?status=`), contribuțiile, renunțarea (reluarea: `PATCH` cu `status: "active"`) |
| `GET /api/v1/dashboard?month=&topCategories=` | dashboard-ul lunar pe monedă |
| `GET /api/v1/reports/monthly?month=` | raportul lunar (structura de date) |
| `GET /api/v1/exports/transactions.csv`, `/goals.csv`, `/budgets.csv?month=` | exporturile CSV (`?dialect=rfc4180|ro`) |
| `POST /api/v1/transfers`, `GET/PATCH/DELETE /api/v1/transfers/{groupId}` | transferurile (aceeași monedă: `amountMinor`; monede diferite: `amountFromMinor` și `amountToMinor`) |

```bash
# Conturile, cu totaluri pe monedă
curl -s https://finet.example/api/v1/accounts -H 'authorization: Bearer tokenFictiv.semnatura'
# {"data":[{"id":"…","name":"Card","type":"bank","currency":"RON","openingBalanceMinor":0,"balanceMinor":125000,…}],
#  "totals":[{"amountMinor":125000,"currency":"RON"}]}

# Transfer între două conturi în monede diferite (ambele sume explicit, fără curs implicit)
curl -s https://finet.example/api/v1/transfers \
  -H 'authorization: Bearer tokenFictiv.semnatura' -H 'content-type: application/json' \
  -d '{"fromAccountId":"…","toAccountId":"…","amountFromMinor":49750,"amountToMinor":1000,"occurredOn":"2026-10-28"}'

# Evenimente de utilizare (doar cu consimțământul usageStats activ se stochează; răspuns 204)
curl -s https://finet.example/api/v1/app/events \
  -H 'authorization: Bearer tokenFictiv.semnatura' -H 'content-type: application/json' \
  -H 'x-finet-client: platform=android; version=1.0.2; installation=3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b' \
  -d '{"events":[{"name":"screen_view","screen":"dashboard","occurredAt":"2026-10-28T10:00:00Z"}]}'
```

## Planificare și raportare (F3-B)
- **Luna** (`?month=YYYY-MM`, pe dashboard, raport, `budgets/status`, `budgets.csv`): implicit luna curentă în fusul gospodăriei (`Europe/Bucharest`). Acceptat: de la aceeași lună de acum 5 ani (60 de luni în urmă) până la luna curentă inclusiv; în afara intervalului sau alt format → 400 cu `fields.month`. Răspunsul conține mereu luna folosită.
- **Etichete pe tranzacții:** `tagIds` în corpul `POST/PATCH /transactions` (cel mult 10, distincte; `PATCH` înlocuiește, `[]` le scoate); o etichetă a altei gospodării → 404. Filtrul de listă `tagIds=<id>,<id>` (un singur parametru, virgulă; oricare dintre etichete). Transferurile au mereu `tags: []`.
- **Bugete:** `GET /budgets/status` → `{ month, data: [BudgetStatus], alerts: [{ budgetId, status }] }`. Semaforul din comparații exacte în întregi: `green` dacă `spent × 100 < warnPct × amount`, `yellow` până la 100% inclusiv, `red` peste. `percent = floor(spent × 100 / amount)` (100,01% se afișează 100, dar e roșu). `remainingMinor` poate fi negativ. Bugetele `personal` sunt vizibile doar proprietarului.
- **Obiective:** `POST /goals/{id}/contributions` cu `{ direction: "add"|"withdraw", amountMinor | amount }` (cheie obligatorie). `achieved` se calculează (reversibil); `abandoned` blochează contribuțiile până la reluare.
- **Ștergeri** (`DELETE /budgets/{id}`, `/goals/{id}`, `/tags/{id}`): definitive, fără parametru de confirmare; confirmarea e a interfeței (ca la conturi și tranzacții). Se auditează fără sume sau nume.
- **Dashboard:** totaluri pe monedă (fără conversie, transferurile excluse; `transactionCount` = venituri + cheltuieli), comparația cu luna anterioară (procent `null` când luna anterioară e 0), categorii top N (`topCategories` 1–20, implicit 5) + „Altele”, 12 luni, trend zilnic (zile goale = 0), onboarding.

### Export CSV
- `GET /api/v1/exports/transactions.csv` (filtrele listei, fără `sort`/`cursor`/`limit`; ordine cronologică), `/exports/goals.csv`, `/exports/budgets.csv?month=`.
- `?dialect=rfc4180` (**implicit pe API**: virgulă, punct zecimal) sau `?dialect=ro` (`;`, virgulă zecimală — butoanele din interfață îl folosesc, se deschide corect în Excel românesc). Alt dialect → 400.
- Răspuns: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="finet-tranzactii.csv"` (respectiv `finet-obiective.csv`, `finet-bugete.csv`; nume fixe, fără date ale utilizatorului), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. UTF-8 cu BOM, CRLF, ghilimele RFC 4180; o celulă de text liber care începe cu `=`, `+`, `-`, `@`, TAB sau CR primește un apostrof în față (protecție contra formula injection).
- Plafon: 50.000 de rânduri de tranzacții; peste → `409 export_too_large` (JSON, fără conținut parțial). Exportul tranzacțiilor e trimis în flux (pagini de 1.000), deci un export lung nu e un instantaneu.
- Limită: 10 exporturi/min per utilizator (429). Fiecare export acceptat se auditează (`export.downloaded`) doar cu tipul și numărul de rânduri.

```bash
curl -s 'https://finet.example/api/v1/exports/transactions.csv?dateFrom=2026-10-01&dateTo=2026-10-31&dialect=ro' \
  -H 'authorization: Bearer tokenFictiv.semnatura' -o finet-tranzactii.csv

# Contribuție la un obiectiv (cheia e obligatorie)
curl -s https://finet.example/api/v1/goals/0b6c1f8e-3a2d-4e5f-8a9b-1c2d3e4f5a6b/contributions \
  -H 'authorization: Bearer tokenFictiv.semnatura' -H 'content-type: application/json' \
  -H 'idempotency-key: 9a1d0c2e-1b7a-4c55-9a39-0d1e2f3a4b5c' -d '{"direction":"add","amountMinor":50000}'
```

## Evenimente de utilizare
Lista fixă de nume: `app_open`, `login`, `logout`, `session_expired`, `screen_view`, `receipt_scan_started`, `receipt_uploaded`, `receipt_confirmed`, `statement_imported`, `transaction_created`, `share_import`, `update_prompt_shown`, `update_started`, `error_shown`, iar din Faza 3 `dashboard_viewed`, `report_viewed`, `budget_created`, `goal_created`, `goal_contribution_added`, `tag_created`, `export_downloaded` (doar numele, fără sume sau alte câmpuri). Ecranele și codurile de eroare: listele din `src/modules/usage/usage.schema.ts` (și din `docs/openapi.json`). Orice alt câmp (sumă, descriere, comerciant, text liber) respinge lotul cu 400. Cel mult 20 de evenimente pe lot; `occurredAt` cel mult 30 de zile în urmă.
