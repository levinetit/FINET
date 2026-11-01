# FINET Android — audit (regula zero, `FINET_ANDROID_MASTER_PROMPT.md` §3)

Data: 2026-11-01. Branch: `feature/android-audit`, de la `origin/main` (`e8476fd`). Nu s-a modificat backendul și nu s-a instalat nimic pe sistem. Constatările vin din cod, nu din documentație.

## 1. Rezumat

- Backendul e gata pentru un client mobil: 173 de operații în `docs/openapi.json`, pluginul `bearer` activ, `POST /api/v1/app/events`, `GET /api/v1/app/android/latest`, pagina `/settings/android`.
- Ce lipsește pentru **Faza A** nu e backend, ci mediul de build și patru decizii ale operatorului (§8).
- Mediul local **nu poate construi** aplicația (§6). Tot ce e Flutter se construiește în GitHub Actions.
- Nu există cod Android: `mobile/` nu există, `.github/workflows/` nu are un workflow Android.

## 2. Repository și documente

| Verificare | Rezultat |
|---|---|
| Branch / commit | `main` la `d3c1fb8`; branch-ul de lucru pornește de la `origin/main` |
| Repository GitHub | `levinetit/FINET`, **public** (secțiunea 12.1: APK-ul public nu conține date sau secrete) |
| Documente citite | `FINET_ANDROID_MASTER_PROMPT.md`, `ROADMAP.md`, `API.md`, `openapi.json`, `ops/cloudflare/README.md`, codul din `src/modules/auth`, `src/modules/app-release`, `src/app/api/v1` |
| Documente Android care lipsesc | `FINET_ANDROID_ARCHITECTURE.md`, `_SECURITY.md`, `_TEST_PLAN.md`, `_BUILD.md` (se scriu în faze, §9) |

## 3. Backend: ce există

173 de operații în 25 de grupuri (taguri OpenAPI). Pe fazele Android:

| Fază Android | Grupuri disponibile |
|---|---|
| B — sesiune și profil | `me` (11: profil, sesiuni, consimțăminte, export, ștergere), `households` (3: listă, activă), `usage` (`POST /app/events`), `app` (`GET /app/android/latest`) |
| C — de bază | `accounts` (7), `transactions` (5), `transfers` (4), `categories` (7), `tags` (5), `budgets` (6), `goals` (7), `reports` (11, inclusiv `dashboard`, `reports/monthly`, `ask`), `prices` (3), `exports` (14) |
| D — recurențe și documente | `recurring` (9), `documents` (6), `receipts` (6), `matching` (6), `statements` (10), `shopping` (15) |
| Familie (Faza E sau mai târziu) | `family` (18, inclusiv `GET /events` SSE) |

Contractul are `openapi` 3.1.0, versiunea `1`. Convențiile din prompt (§5) sunt respectate: erori `{ error: { code, message, fields? } }`, paginare cu cursor `{ data, nextCursor }`, sume `amountMinor`, `Idempotency-Key` pe `POST`.

**Nu lipsește niciun endpoint** pentru Fazele A–D. De verificat în Faza C, nu acum: există un endpoint care întoarce garanțiile SGR și datele pentru cardul „familie” de pe dashboard? (`GET /dashboard` e candidatul.)

## 4. Autentificare

- Better Auth cu `bearer({ requireSignature: true })` (`src/modules/auth/auth.ts:171`).
- Login: `POST /api/auth/sign-in/email` cu emailul și parola. Tokenul e antetul `set-auth-token` din răspuns, apoi `Authorization: Bearer <token>`. Fără cookie, deci fără verificarea `Origin` (`docs/API.md`, secțiunea de autentificare).
- `X-FINET-Client: platform=android; version=…; code=…; installation=<uuid>; os=…; model=…; locale=…`. `platform` și `installation` sunt obligatorii; un antet invalid e ignorat. Serverul înregistrează instalarea doar cu consimțământul `usageStats`.
- Sesiunile apar în `GET /api/v1/me/sessions` și se revocă (`DELETE /me/sessions/{id}`): logout-ul din aplicație folosește asta.
- Magic link pe mobil: **nu** (cere App Links verificate pe domeniu). Faza B folosește parola.
- În `saas`, înregistrarea are Turnstile și confirmare prin email. Înregistrarea nu intră în Android MVP (varianta `personal`, familie existentă).

Compatibilitate: pluginul `bearer` e cel cerut de prompt. Nu e nevoie de ADR pentru alternativa OIDC.

## 5. Accesul telefonului la server

- Producția rulează `APP_MODE=personal`, în spatele Cloudflare Access. Telefonul trece prin **Cloudflare One (WARP)**, conform `ops/cloudflare/README.md` pasul 5.
- Hostname-ul real nu e în repository (`finet.<domeniu>` peste tot). **Nu îl inventez**: operatorul îl dă pentru `API_BASE_URL`.
- Paginile de răspuns Access (redirect către `cloudflareaccess.com`, 403 Cloudflare) trebuie recunoscute în client și afișate ca „Pornește aplicația Cloudflare One” (prompt §11).
- `POST /api/v1/documents` are cale proprie exclusă din proxy-ul Next, cu aceeași verificare Access în rută; clientul trimite fluxul multipart direct.
- Neverificat de mine: dacă politica Access acceptă identitatea venită prin WARP de pe telefoanele familiei (regula pentru dispozitive din `access-policy.md`). Se verifică pe un telefon real în Faza B.

## 6. Mediul de build

| Unealtă | Pe host (LXC `docker-apps`) |
|---|---|
| Flutter / Dart | lipsește |
| JDK 17, Gradle, Android SDK, `adb` | lipsesc |
| Memorie liberă | ~200 MB din 12 GB (alte servicii rulează) |
| Disc liber | 41 GB (suficient, dar memoria nu) |

Concluzie: **nicio construcție locală**. Flutter, Android SDK și Gradle se rulează doar în GitHub Actions (`ubuntu-latest`). Pe host se editează doar fișiere. Consecințe:
- feedback-ul vine din CI (analyze, test, APK de debug), nu local;
- ce se poate rula local fără Flutter: `docs/openapi.json` se citește cu Node;
- cheia de semnare nu apare local: o generează operatorul (prompt §12).

## 7. Riscuri

| Risc | Impact | Măsură |
|---|---|---|
| Nicio verificare locală a codului Dart | cod trimis „pe orb” în CI | faze mici, PR-uri mici, teste unitare pentru `Money` și parsarea sumelor în prima fază |
| WARP/Access respinge telefonul | aplicația nu ajunge la API | mesajul din §5 și test pe telefon real în Faza B |
| HEIC | serverul răspunde `415 heic_unsupported` | conversia în JPEG pe telefon (prompt §10), deja prevăzută pentru Faza D |
| Datele simulate ajung în producție | cifre false afișate ca reale | build separat „test” cu eticheta „Date simulate”; niciun mod simulat în release |
| Repository public | APK public | nu conține secrete; aplicația e inutilă fără cont și fără acces la server |
| Paritatea cifrelor cu web (acceptare Faza C) | diferențe de rotunjire sau fus orar | toate calculele vin din backend; clientul doar formatează |

## 8. Decizii ale operatorului (necesare înainte de Faza A)

1. `applicationId` — propunere: `ro.finet.app`. Se fixează o singură dată.
2. `minSdk` — propunere din prompt: 26 (Android 8.0).
3. Versiunea Flutter fixată (canal `stable`) — propun cea curentă la momentul Fazei A, notată în `mobile/README.md`.
4. Hostname-ul de test și de producție (`API_BASE_URL`) — de la operator, nu se inventează.
5. Cheia de semnare (`upload-keystore.jks`) — se cere abia în Faza E.
6. Logo: simbolul SVG din §3.4 al promptului principal, redus la pictogramă adaptivă Android. Nu cere decizie, doar confirmare.

## 9. Planul fazelor

| Fază | Ramură | Livrabile | Depinde de operator |
|---|---|---|---|
| A — Fundație | `feature/android-a` | `mobile/` (Flutter, Material 3 din tokenii FINET), navigare de jos, client Dio cu interceptori, `Money` plus parsarea sumelor cu aceleași cazuri ca web, ecrane pe date simulate marcate, CI (`format`, `analyze`, `test`, APK debug ca artefact) | punctele 1–3 de mai sus |
| B — Autentificare | `feature/android-b` | login/logout cu revocare, 401/403, profil, gospodării, `installationId`, `X-FINET-Client`, ecran de informare, evenimente, `FLAG_SECURE`, blocare biometrică, mesajul Cloudflare One | `API_BASE_URL` de test, cont de test, telefon cu WARP |
| C — De bază | `feature/android-c` | dashboard, conturi, tranzacții (listă, filtre, adăugare, editare), bugete, obiective, raport lunar; test de paritate cu web | — |
| D — Recurențe și documente | `feature/android-d` | recurențe, foto bon, compresie, mod bon lung, verificare, partajare din alte aplicații, extrase | — |
| E — Stabilizare | `feature/android-e` | conexiune slabă, teste de integrare, securitate (`FINET_ANDROID_SECURITY.md`), accesibilitate, APK semnat, workflow `android-release.yml`, primul GitHub Release | cheia de semnare, secretele GitHub, variabilele mediului `production` |

Fiecare fază: un PR, revizuire, apoi următoarea. Documentele Android din `docs/` cresc odată cu fazele.

## 10. Ce nu se face

- Nu se modifică backendul pentru comoditatea clientului. Dacă lipsește un endpoint, se adaugă în `src/app/api/v1/`, cu Zod, OpenAPI și teste, într-un PR separat.
- Nu există service tokenuri Cloudflare, parole sau chei în APK sau în repository.
- Nu există SDK de analitică în APK; statisticile merg la `POST /api/v1/app/events`.
- Google Play, notificări push, coadă offline și widget: după MVP, doar în `saas` pentru Play.
