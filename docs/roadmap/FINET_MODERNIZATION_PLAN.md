# FINET — planul de modernizare 2026

Branch: `feature/finet-modernization-2026`. Baza: `main` la `d78d601`. Auditul: `docs/audit/FINET_COMPLETE_AUDIT.md`. Fiecare pas de mai jos e un commit (sau câteva) pe branch, cu teste și documentație; nimic nu se aplică pe producție din acest branch fără fraza explicită a operatorului (deploy, migrații, cron).

Principii (din master prompt-ul de modernizare, secțiunea 2, și din `docs/FINET_MASTER_PROMPT.md`):
- se verifică întâi ce există; nu se dublează module (obiective, recurențe, rapoarte, „Întreabă FINET” rămân baza);
- bani doar în `bigint`; `householdId` din sesiune; fiecare funcție nouă trece prin `withMember` + RLS și are test de izolare între gospodării;
- fără dependențe noi de runtime unde se poate (grafice SVG proprii, calcule în cod);
- API-ul `/api/v1` rămâne compatibil înapoi (doar adăugiri; OpenAPI regenerat);
- migrațiile sunt aditive și idempotente la re-rulare a runner-ului; CHECK-urile rescrise explicit;
- AI doar prin infrastructura existentă (`src/lib/ai`, buget, consimțământ), niciodată obligatoriu: fiecare funcție are o cale deterministă și etichetează clar „estimare” față de date reale.

## Ordinea de lucru (impact × risc × efort × dependențe)

| Pas | Conținut | Risc | Efort | Depinde de |
|---|---|---|---|---|
| **A. CI și lanț de aprovizionare** | acțiuni pe SHA, `pnpm audit` blocant (HIGH+), CodeQL, gitleaks, Trivy pe imaginea `web`, drepturi minime în `claude-faza.yml`, imagine de bază pe digest, hash în `packageManager` | mic | mic | — |
| **B. Dependențe** | patch/minor sigure (`nodemailer`, `jose`, `better-auth` 1.7.18, `next` 16.4.5, `pg-boss`, `tailwind`, `vite`, `vitest`, `playwright`); acțiunile GitHub din PR-urile Dependabot (#65, #67, #68, #79); `postgres` 4 și `unpdf` 2 evaluate separat cu teste de integrare; raport `docs/audit/DEPENDENCY_MODERNIZATION.md` | mediu (driverul DB) | mic-mediu | A (CI verde) |
| **C. Securitate** | L8 (bearer ⇒ fără cookie), plafoane per gospodărie în `personal` (conturi, categorii, reguli, obiective), test de izolare generic pentru modulele noi, `docs/audit/FINET_SECURITY_AUDIT.md`, `SECURITY_CHECKLIST` §42 | mic | mic | — |
| **D. Scor de sănătate financiară** (P2) | modul `src/modules/health`: funcții pure peste agregatele lunare (rată de economisire, cash-flow, stabilitate, aderență la buget, fond de urgență, datorii pe carduri); explicații pe fiecare componentă; API `GET /api/v1/health-score?month=`; pagina `/health`; fără migrație | mic | mediu | — |
| **E. Prognoză cash-flow 30/60/90** (P2) | modul `src/modules/forecast`: solduri curente + regulile recurente active (scadențele viitoare din `calendar.ts`) + media istorică a cheltuielilor nerecurente (3–6 luni) ⇒ sold proiectat pe zile, cu indicator de încredere; API `GET /api/v1/forecast?days=`; pagina `/forecast`; fără migrație | mic | mediu | D (agregate comune) |
| **F. Consilier financiar** (P2) | modul `src/modules/advisor`: analize deterministe (tranzacții neobișnuite față de mediana comerciantului/categoriei, tipare de cheltuieli, sugestii de economisire explicabile) + rezumatul lunar existent; pasul LLM opțional prin `ask-llm` (consimțământ `external_ai_ask`, buget), etichetat; API `GET /api/v1/advisor?month=`; pagina `/advisor`; fără migrație | mic | mediu | D, E |
| **G. Avere netă** (P3) | migrația `0027_net_worth`: tipuri noi de cont (`investment`, `property`, `vehicle`, `loan`, `other_asset`, `other_liability`) cu `kind` (`asset`/`liability`) și `valuation_minor` + `valued_on` pentru activele fără tranzacții; tabela `net_worth_snapshots` (lunar, pe monedă) scrisă de worker; API `GET /api/v1/net-worth`, `POST /api/v1/accounts/{id}/valuation`; pagina `/net-worth` cu evoluție | mediu (CHECK-uri rescrise) | mediu | — |
| **H. Plan de economisire** (P3) | în `goals`: `plan` calculat (sume zilnice/lunare până la termen, în bigint), fond de urgență recomandat (3–6 luni de cheltuieli esențiale), simulare (`POST /api/v1/goals/simulate`, fără scriere); fără migrație | mic | mic | D |
| **I. Manager de abonamente** (P3) | vedere peste `recurring_rules` (cost lunar/anual normalizat, următoarea reînnoire, categorie) + propunerile din istoric; API `GET /api/v1/subscriptions`; pagina `/subscriptions`; fără migrație | mic | mic | — |
| **J. Notificări** (P4) | migrația `0028_notifications`: `notifications` (în aplicație), `notification_preferences`; job în worker (`notify.evaluate`, zilnic): plăți în următoarele 3 zile, buget ≥ `warn_pct`/depășit, cheltuială neobișnuită, obiectiv în întârziere, reînnoire abonament, rezumatul lunii; API `GET/PATCH /api/v1/notifications`, `GET/PUT /api/v1/me/notification-preferences`; clopoțel în layout; email prin `Mailer` existent (opt-in); push Android: `GET /api/v1/notifications` consumat de aplicație (fără FCM în această iterație; documentat) | mediu | mediu-mare | D, E, I |
| **K. Monede** (P4) | migrația `0029_fx`: HUF, GBP în listele de monede (CHECK-uri rescrise), tabela `fx_rates` (sursă ECB, zilnic, din worker, fără cheie API), `households.base_currency`; conversie **doar pentru afișare** (totaluri „≈ în moneda de bază”, etichetate cu data cursului); `src/lib/fx.ts` în bigint cu rotunjire explicită | mediu | mediu | — |
| **L. Open Banking** (P4) | evaluare (`docs/research/open-banking-ro-eu.md`: GoCardless Bank Account Data, Salt Edge, Nordigen→GoCardless, Enable Banking, Tink; prețuri, limite, consimțământ 90/180 zile) + interfața modulară `src/modules/banking/provider.ts` cu un furnizor `mock` testat și stocarea consimțămintelor/sincronizărilor (migrația doar când există furnizor real ales de operator) | mic | mic (doc + interfață) | K |
| **M. Android** (P4) | fără schimbări de cod în această iterație dincolo de documentarea ecranelor noi; backend-ul rămâne sursa; planul de ecrane noi în `docs/FINET_ANDROID_MODERNIZATION.md` | — | mic | D–J |
| **N. Internaționalizare** (P5) | strat de indirecție pentru `ro.ts` (fără schimbarea textelor), decizie documentată; traducerea aplicației rămâne amânată (decizia operatorului din 2026-11-01) | mic | mic | — |
| **O. Observabilitate** | logger comun (`src/lib/log.ts`, JSON, fără date financiare), `/api/health` cu `worker.lastRun` pe job, metrici simple (contoare în `service_heartbeats`) | mic | mic | J |
| **P. Documentație și raport final** | `ARCHITECTURE.md`/`README.md` la zi, ADR-uri pentru D–K, `docs/reports/FINET_MODERNIZATION_FINAL_REPORT.md` | — | mic | toate |

## Criterii de acceptare per pas
- `pnpm check` (lint, typecheck, teste) și `pnpm format:check` verzi local în containerul Node 24 cu PostgreSQL 17 efemer; `pnpm openapi:check` la zi.
- Fiecare modul nou: teste unitare pe funcțiile pure, test de integrare pe Postgres real cu două gospodării (izolare), test API cu validarea răspunsului față de OpenAPI.
- Fiecare migrație: rulată de două ori (idempotență) și trecută prin `backup-restore` în CI.
- Fără text UI în afara `src/messages/ro.ts`; fără `style=`; fără `Number` pe sume.
- CI pe GitHub verde pe branch înaintea PR-ului.

## Ce NU face această iterație (cu motiv)
- Stripe sau alt furnizor de plată (operatorul nu folosește Stripe; furnizorul nu e ales).
- Furnizor real Open Banking (cost și contract; se livrează doar interfața și evaluarea).
- FCM/push nativ (cere proiect Firebase și chei; notificările sunt în aplicație + email, iar Android le citește prin API).
- Traducerea aplicației autentificate (decizie amânată de operator).
- ESLint 10, TypeScript 7, Node 26 (incompatibile cu `eslint-config-next` 16.4 / `next build` / decizia Node 24).
