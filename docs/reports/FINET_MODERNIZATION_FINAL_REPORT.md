# FINET — raportul final al modernizării 2026

Branch: `feature/finet-modernization-2026` (PR #81, draft → gata de revizuire). Baza: `main` la `d78d601` (PR #80). Data: 2026-11-07. Executat autonom conform master prompt-ului de modernizare; **nimic nu a fost aplicat pe producție** (deploy, migrații, cron: doar cu fraza explicită a operatorului, `docs/INFRA.md` §4aa).

## 1. Starea inițială a depozitului

Proiect matur: Next.js 16 / Drizzle / PostgreSQL 17 (Supabase) / Better Auth / pg-boss, 26 de migrații aplicate pe producție, RLS `FORCE` pe toate tabelele, 1.576 de teste Vitest, 121 de teste E2E, 44 de ADR-uri, client Android Flutter 1.0.2 publicat. Fazele 0–13 în cod; producție `personal` pe `d3c1fb8`. Detalii: `docs/audit/FINET_COMPLETE_AUDIT.md` §1–2.

## 2. Probleme găsite (audit)

| Nivel | Problemă | Stare |
|---|---|---|
| HIGH | acțiuni GitHub pe tag, audit non-blocant, fără CodeQL/gitleaks/Trivy, imagine fără digest | **rezolvat** (pasul A) |
| HIGH | lipseau: consilier, prognoză, scor, avere netă, plan de economisire, abonamente, notificări, HUF/GBP, cursuri, Open Banking | **livrate** (D–L; Open Banking doar interfața + evaluarea) |
| MEDIUM | L8 (bearer + cookie), LOW-4 (fără plafoane per gospodărie) | **rezolvat** (pasul C) |
| MEDIUM | `ARCHITECTURE.md`/`README.md` cu ~8 faze în urmă | **rezolvat** (pasul P) |
| MEDIUM | loguri web nestructurate; `ro.ts` monolit | **rezolvat parțial** (logger; strat de indirecție; împărțirea `ro.ts` rămâne) |
| MEDIUM | `postgres` 4, `unpdf` 2 (majore) | **evaluate, amânate** cu plan (`DEPENDENCY_MODERNIZATION.md`) |
| LOW | L6 (token de resetare în clar), MFA `saas`, `pg_trgm`, `finet:tools` mare | deschise, documentate |

## 3. Schimbări implementate (13 commit-uri, 186 de fișiere)

| Pas | Commit | Conținut |
|---|---|---|
| A | `357e425` | CI pe SHA, audit blocant, CodeQL, gitleaks, Trivy, digest, hash pnpm; audit + plan |
| B | `077d0d9` | dependențe patch/minor (better-auth 1.7.18 ș.a.), raport |
| D | `6d35867` | scor de sănătate (ADR 0045) |
| E | `64cebea` | prognoză cash-flow 30/60/90 |
| F | `1ccfcfe` | consilier (neobișnuite, tipare, sugestii) |
| G | `462af04` | avere netă, tipuri noi de cont, evaluări, migrația 0027 (ADR 0046) |
| H+I | `b01ff24` | plan de economisire, fond de urgență, simulare; abonamente (ADR 0047) |
| J | `40e3b10` | notificări, preferințe, digest email, job zilnic, migrația 0028 (ADR 0048) |
| K | `d65aba8` | HUF/GBP, cursuri BCE, conversie afișare, migrația 0029 (ADR 0049) |
| — | `5d49f13` | corecții CI (buget JS, link dublu, exemple GBP) |
| L | `c7db804` | Open Banking: evaluare + interfață + mock (ADR 0050) |
| C | `c2ec74d` | L8, plafoane, audit de securitate (ADR 0051) |
| M/N/O | `a56ead5` | logger structurat, strat de texte, plan Android, lacăt pe plafoane (ADR 0052) |
| P | (acest commit) | documentație aliniată, raport final |

## 4. Funcții noi (toate în română, cu teste, OpenAPI și ADR)

- `/health` + `GET /api/v1/health-score` — scor 0–100 explicabil, șase componente, praguri publice; **nu e scor de credit** (etichetă).
- `/forecast` + `GET /api/v1/forecast` — sold proiectat pe zile, 30/60/90, plăți viitoare, încredere cu motive; etichetat „estimare”.
- `/advisor` + `GET /api/v1/advisor` — tranzacții neobișnuite, tipare, sugestii cu sume, fără LLM (motiv în ADR 0045 §13).
- `/net-worth`, evaluări pe cont, `GET /api/v1/net-worth`, `GET/POST/DELETE …/valuations` — active/pasive/net, istoric recalculat.
- `/goals` (plan, fond de urgență, simulator), `GET /api/v1/savings-plan`, `POST …/simulate`.
- `/subscriptions` + `GET /api/v1/subscriptions` — cost lunar/anual, reînnoiri, detectate.
- `/notifications`, `/settings/notifications`, banner, `GET/POST/DELETE /api/v1/notifications…`, `GET/PUT /api/v1/me/notification-preferences`, job `notify.evaluate`, email opt-in.
- HUF, GBP peste tot; `GET /api/v1/fx/rates`; „≈ în moneda de bază” pe dashboard/conturi/avere; job `fx.refresh` (`FX_RATES=1`).
- Open Banking: `BankingProvider`, `mock`, maparea în extrase; evaluarea furnizorilor (`docs/research/open-banking-ro-eu.md`).

## 5. Dependențe

Actualizate: better-auth 1.7.18, jose 6.2.15, nodemailer 10.3.1, next 16.4.5, pg-boss 12.38.1, tailwind 4.3.4, vite 8.3.6, vitest 5.1.0, playwright 1.65.0; acțiuni GitHub (checkout 7.0.1, setup-node 7.1.0, upload-artifact 7.0.2, buildx 4.4.1, build-push 7.4.0, fetch-metadata 3.1.0, setup-java 6.2.0, claude-code-action 1.0.269) pe SHA. `pnpm audit --prod`: 0 vulnerabilități. Amânate cu plan: postgres 4, unpdf 2; refuzate motivat: eslint 10, typescript 7, @types/node 26. PR-urile Dependabot #65, #67, #68, #69, #70, #72, #73, #74, #79 sunt acoperite sau documentate.

## 6. Securitate

Închise: L8, LOW-4 (cu lacăt contra TOCTOU), lanțul CI. Revizuite: toate modulele noi (RLS FORCE, o singură funcție definer, fără conținut în loguri, descărcarea BCE cu gazdă fixă, email fără linkuri de autentificare, linkuri de notificare validate prin CHECK). Deschise: L6, MFA `saas`. Detalii: `docs/audit/FINET_SECURITY_AUDIT.md`, `SECURITY_CHECKLIST.md` §42.

## 7. Rezultatele testelor

- Local (container Node 24, PostgreSQL 17 efemer): `pnpm typecheck` OK, `pnpm lint` OK, `pnpm format:check` OK, `pnpm test:ops` OK, `pnpm openapi:check` OK (regenerat).
- Vitest local, suita completă pe ultimul cod (după pasul O): **2.024 de teste trecute, 0 picate, 13 sărite** (175 de fișiere, 2 sărite; ~5 minute).
- Teste noi: ~75 unitare (scor, prognoză, consilier, avere, plan, abonamente, reguli de notificare, conversie, parser BCE, banking, logger, texte) + ~25 de integrare pe PostgreSQL real (fiecare modul: cifre din date, izolare între gospodării, validări, 401/400/404/409, deduplicare, preferințe, digest cu expeditor fals, jobul workerului, migrații 0027–0029 de două ori + restaurare).
- E2E: proiectele existente rulează în CI; **nu au fost adăugate proiecte E2E noi** pentru paginile noi (acoperite prin testele de integrare API și regulile statice UI/a11y). Limitare declarată.

## 8. Rezultatele build-ului și CI

Pe commit-ul final al PR #81 (`968e20b`), toate workflow-urile sunt verzi: `ci` (job-urile `pg-version`, `ci` — lint, format, OpenAPI, typecheck, migrații de două ori, teste, build, scanare secrete, buget JS, audit blocant —, `backup-restore`, `e2e` în ambele moduri), `codeql`, `secret-scan`, `images` (web/tools/backup + Trivy), `android`. Eșecurile intermediare (buget JS, link dublu pe `/goals`, exemple cu `GBP`) au fost corectate în `5d49f13`.

## 9. Migrații

`0027_net_worth`, `0028_notifications`, `0029_currencies` — aditive, idempotente (runner-ul rulat de două ori în CI), trecute prin `backup-restore`; rollback-ul în antetul fiecărui fișier. **Neaplicate pe Supabase.** Capcană confirmată: `drizzle-kit generate` numerotează greșit (0026/0027/0028): redenumire + instantaneu + `when` corectate manual de fiecare dată.

## 10. Datorie tehnică rămasă

- `ro.ts` împărțit pe pagini (bugetul JS e la 210 KiB; prag ridicat cu +10 KiB, documentat).
- `postgres` 4 și `unpdf` 2 pe ramuri separate; `finet:tools` 606 MB; `pg_trgm`.
- E2E pentru paginile noi; e2e `saas` pentru notificări.
- Consilier: mediana pe categorie amestecă cumpărături mici și mari (documentat în ADR 0045 §15).
- Open Banking real (după alegerea furnizorului); push Android; MFA `saas`; L6.

## 11. Instrucțiuni de deploy

`docs/INFRA.md` §4aa: backup → imagini din CI (`pull-images.sh <sha>`) → `finet-migrate` (aplicate acum 3) → recreare worker (opțional `FX_RATES=1`) → web cu ambele compose → verificări.

## 12. Rollback

Imaginile anterioare merg peste baza migrată (tabelele noi sunt ignorate); migrațiile se dau înapoi manual, cu backup, după antetele SQL (0029 cere ca niciun rând să nu fie în HUF/GBP; 0027 cere reclasificarea tipurilor noi de cont).
