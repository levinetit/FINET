# FINET Android — planul de modernizare (pasul M, 2026-11-07)

Aplicația Flutter (`mobile/`, ADR 0038–0042, release 1.0.2) e la zi tehnic (Flutter 3.47.9, AGP 9.1, `minSdk` 29, semnare în CI). Acest document inventariază ce a adăugat backend-ul în `feature/finet-modernization-2026` și ce înseamnă pentru client, **fără să schimbe codul Android în acest branch** (regula din ADR 0038: backend-ul e sursa calculelor; clientul afișează). Fiecare punct e o felie de lucru separată, cu PR propriu și build în `android.yml`.

## 1. Endpointuri noi de consumat (toate `GET`, JSON cu `amountMinor` întregi, bearer)

| Endpoint | Ecran Android propus | Note |
|---|---|---|
| `/api/v1/health-score?month=` | „Sănătate” (card pe Acasă + ecran cu componente) | bare 0–100 din `score`; `explanation` gata formatat; `label` obligatoriu de afișat |
| `/api/v1/forecast?days=` | „Prognoză” (grafic linie din `points`, rezumate 30/60/90, `upcoming`) | `confidence.reasons` ca listă; `label` |
| `/api/v1/advisor?month=` | „Consilier” (sugestii pe priorități, neobișnuite cu deschidere spre tranzacție, tipare) | nimic nu se execută; `link`-uri relative web → rute Android |
| `/api/v1/net-worth?months=` | „Avere netă” (active/pasive/net, istoric, pe tipuri) | tipurile noi de cont: etichete locale pentru `investment`, `property`, `vehicle`, `other_asset`, `loan`, `other_liability` |
| `/api/v1/accounts/{id}/valuations` (+ `POST`, `DELETE …/{valuationId}`) | formular de evaluare pe contul evaluat | `Idempotency-Key` pe `POST`; valoarea semnată (pasive negative) |
| `/api/v1/savings-plan`, `POST /api/v1/savings-plan/simulate` | planul pe obiectiv (zi/săptămână/lună), fondul de urgență, simulator | simularea merge și cu abonament expirat |
| `/api/v1/subscriptions` | „Abonamente” (cost lunar/anual, reînnoiri, categorii, detectate) | administrarea rămâne în ecranul de recurențe |
| `/api/v1/notifications`, `POST …/{id}/read`, `POST …/read-all`, `DELETE …/{id}`, `GET/PUT /api/v1/me/notification-preferences` | centru de notificări + preferințe în Setări | fără push nativ (decizie în ADR 0048); sondaj la deschiderea aplicației și la pornirea din fundal (`WorkManager`, ≥ 15 min) |
| `/api/v1/fx/rates?date=` | „≈ în moneda de bază” sub totaluri | conversia DOAR pentru afișare, în întregi (`rateMicro`), cu data cursului; 404 = fără cursuri → nu se afișează |

Conturile acceptă acum și `HUF`, `GBP`; selectorul de monedă al clientului citește lista din contractul OpenAPI (`docs/openapi.json`), nu dintr-o listă locală.

## 2. Felii propuse (în ordinea valorii)

1. **Notificări** (centru + preferințe + sondaj în fundal + badge pe pictograma Acasă): cea mai cerută funcție mobilă; fără FCM, deci fără proiect Firebase. `WorkManager` cu constrângere de rețea; sondajul citește `unread` și afișează o notificare locală Android doar pentru cele noi (titlu + corp, fără sume suplimentare), cu deschidere în centru.
2. **Avere netă + evaluări + tipuri noi de cont**: extinderea modelului `Account`, ecranul de avere, formularul de evaluare, etichetele.
3. **Sănătate, prognoză, consilier** (trei ecrane citire; graficele în `CustomPainter`, fără pachete noi; valorile vin gata calculate).
4. **Plan de economisire și abonamente** (extinderea ecranelor de obiective și recurențe).
5. **Cursuri**: linia „≈” pe Acasă/Conturi/Avere.

## 3. Cerințe transversale (neschimbate față de ADR 0038–0042)

- Fără calcule pe sume în client (nici conversie valutară: se afișează ce dă `fx/rates` × suma? **Nu**: clientul nu înmulțește; cere totalul deja convertit dacă e nevoie — propunere de endpoint `GET /api/v1/fx/approx?currency=&amounts=` pentru o felie viitoare, sau afișarea cursului și atât).
- `Idempotency-Key` pe fiecare `POST` care creează; `OriginInterceptor` existent; `FLAG_SECURE`; blocare biometrică; fără loguri cu sume.
- Teste: widget pentru fiecare ecran (date din JSON-urile din `docs/openapi.json`), `flutter test -j 1` local, APK în CI; verificare manuală pe telefon cu WARP (pașii din `docs/FINET_ANDROID_TEST_PLAN.md`).
- Compatibilitate: `minSupportedVersionCode` în `android-latest.json` rămâne neschimbat până când un endpoint vechi se schimbă (niciunul în acest branch: toate adăugirile sunt aditive).

## 4. Ce NU se face

- Push nativ (FCM), widget-uri de ecran (cer date în fundal și decizii de confidențialitate), offline pentru tranzacții (există doar pentru scanări): rămân în `docs/FINET_ANDROID_MASTER_PROMPT.md` ca faze ulterioare, după decizia operatorului.
