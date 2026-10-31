# FINET — lista de verificare de securitate

Creată în Faza 1 (F1-C) și completată la fiecare revizuire de securitate. Referința: master prompt 6.3 (OWASP ASVS nivel 2). Stări: **DONE** (implementat și verificat prin dovada din coloană), **PARTIAL** (implementat, dar verificarea sau o parte lipsește), **TODO** (neimplementat). „NOT RUN” în dovadă înseamnă că testul există, dar nu a fost rulat încă în mediul indicat.

Identificatorii F1–F9 și N1–N5 sunt constatările revizuirii de securitate din Faza 0 (`docs/ROADMAP.md`, `docs/reports/faza-0.md`).

Revizori: `programmer` = agentul care a implementat (auto-verificare, nu revizuire independentă); `security` = revizuirea dedicată (T5 în Faza 0, F1-A în Faza 1). Revizuirea de securitate a Fazei 1 complete a avut loc: verdict **BLOCKED** (H1 open redirect, M1–M5, L1–L8), corecții aplicate, **re-verificare independentă: PASS_WITH_FINDINGS** (fără blocante; observații N1–N4 de mai jos și în `docs/ROADMAP.md`). Regulă pentru paginile viitoare: verificarea sesiunii se face pe server, în fiecare pagină, prin `requirePageSession` (`src/app/_lib/session.ts`); `(app)/layout.tsx` NU o face în locul paginilor.

## 1. Autentificare

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Parole Argon2id (m=19 MiB, t=2, p=1), minimum 10 caractere, maximum 128 | DONE | `src/modules/auth/password.ts`, `password.test.ts` | 2026-10-27 · programmer (F1-B) |
| HIBP opțional (k-anonymity), oprit implicit | DONE | `AUTH_HIBP_ENABLED`, `password.test.ts` (fetcher simulat) | 2026-10-27 · programmer |
| Cookie-uri `HttpOnly`, `SameSite=Lax`, `Secure` (prefix `__Secure-` cu https / producție) | DONE | `src/modules/auth/auth.ts` (`defaultCookieAttributes`), `auth.test.ts` | 2026-10-27 · programmer |
| Sesiuni în bază, fără cookie cache (revocarea are efect imediat), 30 de zile | DONE | `auth.ts`, `auth.test.ts` (expirare cu ceas simulat) | 2026-10-27 · programmer |
| Login prin `bearer` (doar tokenuri semnate) pentru Android | DONE | `native-client.test.ts` | 2026-10-27 · programmer |
| Rate limiting: login web, login mobil, emailuri, resetare, schimbarea parolei (pe IP de încredere + email) | DONE | `rate-limit.ts`, `auth.test.ts`, `me.test.ts`; în UI: E2E „rate limiting vizibil” (NOT RUN local, CI) | 2026-10-28 · programmer |
| Mesaje uniforme (fără enumerarea conturilor) la login, magic link, 429 | DONE | `handler.ts`, `src/app/login/login-form.tsx`; E2E „parolă greșită și email inexistent” (NOT RUN local) | 2026-10-28 · programmer |
| Înregistrare publică dezactivată în `personal` (`/register` și `/api/auth/sign-up/*` → 404) | DONE | `handler.ts`, `src/app/register/page.tsx`; verificat pe `next dev` (404); E2E (NOT RUN local) | 2026-10-28 · programmer |
| Magic link de unică folosință, 10 minute, doar cu SMTP | DONE | `auth.ts`, `auth.test.ts` (mailer fals); butonul din UI apare doar cu SMTP configurat | 2026-10-28 · programmer |
| Schimbarea parolei revocă celelalte sesiuni | DONE | `password.service.ts`, `me.test.ts`; E2E cu două contexte (NOT RUN local) | 2026-10-28 · programmer |
| Lista sesiunilor și revocarea (individual, „celelalte”), cu confirmare | DONE | `/api/v1/me/sessions*`, `src/app/(app)/profile/sessions-list.tsx`; E2E (NOT RUN local) | 2026-10-28 · programmer |
| `?next=` fără open redirect (doar cale relativă internă; din H1 validat pe rezultatul normalizat) | DONE | `src/app/_lib/next-path.ts`, `next-path.test.ts` (36 de forme respinse + proprietate); verificat pe `next dev` (`next=//evil.com` → `/dashboard`); E2E (NOT RUN local) | 2026-10-28 · programmer |
| Parola nu ajunge într-un URL înainte de hidratare (formulare `method="post"`, butoane active doar după hidratare) | DONE | `src/app/_lib/use-hydrated.ts`, formularele din `src/app/**` | 2026-10-28 · programmer |
| Înregistrare `saas` cu verificarea emailului | TODO | Faza 11 | — |
| Verificarea E2E în browser a fluxurilor de mai sus | PARTIAL | proiectul `auth` din `playwright.config.ts`, job `e2e` în CI: NOT RUN (browserele nu se instalează pe hostul agentului; prima rulare pe GitHub) | 2026-10-28 · programmer |

## 2. Autorizare și RLS

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Stratul 1: `requireMember`/`withMember`, apartenența verificată în bază, 404 uniform | DONE | `src/lib/authz.ts`, `authz.test.ts` | 2026-10-27 · programmer (F1-A) |
| Stratul 2: RLS `ENABLE` + `FORCE` pe toate tabelele cu `household_id` | DONE | `src/db/migrations/0001_rls.sql`, `rls.test.ts`, `migrate.test.ts` | 2026-10-27 · programmer |
| Constatarea RLS F1-A (MEDIUM: re-revendicarea unei gospodării fără membri) | DONE | `finet.create_household`, ramura „claim” eliminată (ADR 0003); test în `rls.test.ts` | 2026-10-27 · security |
| Aplicația ca `finet_app` (`NOBYPASSRLS`), fără drepturi DDL; nimic pentru `anon`/`authenticated` | DONE | `ops/postgres/test-bootstrap.sql`, `rls.test.ts` | 2026-10-27 · programmer |
| `user_id` din sesiunea verificată, niciodată din cerere; `PATCH /me` strict (respinge `household_id` etc.) | DONE | `session.ts`, `profile.schema.ts`, `me.test.ts` | 2026-10-27 · programmer |
| CSRF pe mutațiile cu cookie (`Origin` = `APP_URL`) | DONE | `assertSameOrigin`, `me.test.ts`; UI-ul folosește aceleași rute | 2026-10-28 · programmer |
| Paginile protejate verifică sesiunea pe server, fail closed (eroare → login) | DONE | `src/app/_lib/session.ts`; `next dev`: `/dashboard` fără sesiune → 307 `/login?next=%2Fdashboard` | 2026-10-28 · programmer |
| Migrațiile aplicate pe Supabase și RLS verificat acolo | TODO | operatorul (`docs/INFRA.md`, „Faza 1”) | — |
| Faza 2 (F2-A): RLS `ENABLE` + `FORCE` pe cele 8 tabele noi (`accounts`, `categories`, `category_visibility`, `transactions`, `idempotency_keys`, `client_installations`, `app_events`, `app_downloads`); fără context → 0 rânduri; `household_id` străin → 42501 | DONE (local, Postgres 17 efemer) | `0002_ledger.sql`, `src/db/ledger-rls.test.ts`, `migrate.test.ts` | 2026-10-28 · programmer (F2-A) |
| Faza 2: izolarea între gospodării pentru fiecare serviciu (conturi, categorii, tranzacții, transferuri): A nu vede/modifică/șterge datele lui B → `NotFoundError` | DONE | `src/modules/*/*.test.ts` | 2026-10-28 · programmer (F2-A) |
| Faza 2: cheile străine simple ignoră RLS → triggere `SECURITY INVOKER` (cont, categorie, părinte, vizibilitate) și cheie compusă cont/gospodărie/monedă | DONE | `0002_ledger.sql`, ADR 0004; teste `23503` în `categories.test.ts`, `transactions.test.ts` | 2026-10-28 · programmer (F2-A) |
| Faza 2: drepturi `UPDATE` pe coloane (fără `household_id`, `created_by_user_id`, `source`, `transfer_*`, `kind`, `system_key` etc.); fără drepturi pentru `anon`/`authenticated` | DONE | `0002_ledger.sql`, `ledger-rls.test.ts` | 2026-10-28 · programmer (F2-A) |
| Revizuire automată F2-A, MEDIUM 1: `owner_user_id` al contului putea indica orice utilizator al platformei | DONE | politica `accounts_household` (`WITH CHECK` membru al aceleiași gospodării), `ledger-rls.test.ts`, `accounts.test.ts` | 2026-10-28 · programmer (F2-A) |
| Revizuire automată F2-A, MEDIUM 2: `installation_id` unic global (squatting, oracol de existență) | DONE | unic pe `(user_id, installation_id)`; `app_events` doar cu instalarea proprie; `ledger-rls.test.ts` | 2026-10-28 · programmer (F2-A) |
| Faza 2: curățarea `idempotency_keys` > 24 h (fără context de gospodărie) | DONE (local) | `0003_idempotency_purge.sql` (`SECURITY DEFINER`, `search_path = pg_catalog`, fără parametri, EXECUTE doar `finet_app`, politici `TO finet_migrator` limitate la > 24 h), `finet-admin cleanup-idempotency`; `idempotency.test.ts` | 2026-10-28 · programmer (F2-B) |
| F2-B: fiecare endpoint `/api/v1` cere sesiune (401), resursele altei gospodării → 404 (inclusiv prin referințe în corp), `household_id` niciodată din cerere | DONE (local) | `src/app/api/v1/ledger-api.test.ts` (401 pe 28 de cazuri: cele 25 ale registrului + consimțăminte + evenimente; izolare A/B pe fiecare operație a registrului, inclusiv `unarchive`/`unhide`; registrul OpenAPI are 34 de operații, verificate față de rutele reale în `src/openapi/openapi.test.ts`) | 2026-10-28 · programmer (F2-B) |
| F2-B: CSRF pe mutațiile cu cookie (`Origin`), bearer fără `Origin` | DONE (local) | `ledger-api.test.ts`, `usage.test.ts` | 2026-10-28 · programmer (F2-B) |
| F2-B: `Idempotency-Key` — o singură scriere, 422 la reutilizare (inclusiv de alt membru), 409 în desfășurare, 5xx nememorat, expirare 24 h | DONE (local) | `src/app/api/v1/idempotency.test.ts` | 2026-10-28 · programmer (F2-B) |
| F2-B: corpuri doar JSON (415), max. 16 KiB (413), parametri URL în listă permisă, rate limiting pe mutații per utilizator (429) | DONE (local) | `src/app/api/v1/_lib/http.ts`, `ledger-api.test.ts` | 2026-10-28 · programmer (F2-B) |
| F2-B: revizuirea `security` a API-ului | TODO | agentul `security` | — |
| Faza 2: `0002_ledger` aplicată pe Supabase și verificată acolo | TODO | operatorul, după revizuiri | — |
| Faza 2: revizuirea `security` a stratului de date F2-A | TODO | agentul `security` | — |

## 3. Antete

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| CSP cu nonce per cerere: `default-src 'self'`, `script-src 'self' 'nonce-…'`, `style-src 'self' 'nonce-…'`, `img-src 'self' data:`, `font-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | DONE | `src/lib/security-headers.ts`, `src/proxy.ts`, `proxy.test.ts`, `security-headers.test.ts`; standalone: `e2e/access.spec.ts` (PASS local) | 2026-10-28 · programmer |
| Fiecare `<script>` randat poartă nonce-ul; nicio pagină statică | DONE | `next build`: toate rutele `ƒ`; `next dev` `/login`: 21 de scripturi, 0 fără nonce, 0 atribute `style=` | 2026-10-28 · programmer |
| Fără încălcări CSP în browser | PARTIAL | E2E „antetele de securitate… fără încălcări CSP” și `ledger` (h) pe toate paginile registrului (NOT RUN local) | 2026-10-28 · programmer |
| Paginile registrului (F2-C): nonce în CSP, fără `style=` | DONE | `next dev` + curl pe 10 pagini: 200, `'nonce-…'`, 0 `style=`; `src/app/ui-rules.test.ts` interzice `style=` în surse | 2026-10-28 · programmer |
| Antetele și pe răspunsurile 403 ale proxy-ului | DONE | `proxy.test.ts`, `access.spec.ts` (PASS local) | 2026-10-28 · programmer |
| F8 (rest) — HSTS `max-age=31536000; includeSubDomains` (fără `preload`: decizia operatorului) | DONE | idem | 2026-10-28 · programmer |
| `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()` | DONE | idem; asset-urile statice prin `next.config.ts` (`headers()`, fără CSP) | 2026-10-28 · programmer |
| CORS închis (niciun `Access-Control-Allow-*`) | DONE | `proxy.test.ts`, `access.spec.ts` (preflight → 403 fără antete CORS) | 2026-10-28 · programmer |
| `'unsafe-eval'` / `'unsafe-inline'` doar în dezvoltare | DONE | `buildCsp`, testele pe ambele moduri | 2026-10-28 · programmer |
| Pagina `global-error` proprie (fără stiluri inline, în română, fără detalii tehnice) | DONE | `src/app/global-error.tsx` (Faza 4); `ui-rules.test.ts` (fără `style=`); randarea în browser NOT RUN local | 2026-10-28 · programmer (F4) |

## 4. Secrete

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| N1 / F2 (rest) — secretele prin fișiere (`*_FILE`, Docker `secrets:`), inclusiv `BETTER_AUTH_SECRET` | DONE | `src/lib/secret-files.ts`, `ops/docker/docker-compose.yml`, `pnpm test:ops` (PASS) | 2026-10-27 · security (N1, T7) |
| F8 (parțial) — `.env.example` fără secrete; valorile de exemplu refuzate la pornire | DONE | `config.ts` (`PLACEHOLDER_SECRET`), `config.test.ts` | 2026-10-27 · programmer |
| F1 — secrete pe rol (`FINET_ROLE`), URL-urile altor roluri refuzate | DONE | `config.ts`, `config.test.ts` (F1) | 2026-10-27 · security |
| Niciun secret în `.next/static` | DONE | `pnpm scan:client-secrets` (PASS, 2026-10-28) | 2026-10-28 · programmer |
| F5 — tipare noi în scanerul de secrete (`scripts/scan-client-secrets.mjs`) | DONE | `scan-client-secrets.test.ts`, `pnpm scan:client-secrets` (PASS) | 2026-10-27 · security (T5) |
| N3 — scanerul: id bot Telegram 8–12 cifre; JWT `anon`: FĂRĂ excepție (FINET nu trimite cheia `anon` Supabase în browser, deci orice JWT în bundle e o scurgere) | DONE | `scan-client-secrets.mjs`, `scan-client-secrets.test.ts` (11 și 12 cifre găsite, 13 nu) | 2026-10-28 · programmer (F4) |
| F6 — scanare de secrete în istoric/PR (gitleaks) | TODO | `docs/ROADMAP.md` | — |

## 5. Încărcări de fișiere (Faza 6; detalii în secțiunea 16)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Tip după conținut, dimensiune maximă, cotă, EXIF eliminat, nume generate | DONE (F6-A, teste) | secțiunea 16, ADR 0013 | 2026-10-29 · programmer (F6-A) |
| Servire autorizată (`Content-Disposition: attachment`, `nosniff`, tipul detectat) | DONE (F6-C, secțiunea 18) | `documents-handlers.ts`, `receipts-api.test.ts` | 2026-10-29 · programmer (F6-C) |
| Limite ZIP | N/A până în Faza 7 (extrase) | — | — |
| Storage local confinat (realpath, `O_NOFOLLOW`, scriere atomică) | DONE | `src/lib/storage/local.ts`, `storage.test.ts` | 2026-10-27 · security (T5) |
| F9 — curățarea fișierelor temporare orfane (`cleanupTemp`) și limita la `put` (`maxBytes`) | DONE (funcții + teste; F6-C: rulate de `cleanup-documents`) / TODO operator: cron-ul (INFRA 4i) | `src/lib/storage/local.ts`, `storage.test.ts` | 2026-10-29 · programmer (F6-A) |

## 6. Date personale în loguri

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Erorile de configurație numesc variabila, nu valoarea | DONE | `config.ts`, `config.test.ts` | 2026-10-27 · programmer |
| Better Auth: doar nivelul și mesajul în log | DONE | `auth.ts` (`logger`) | 2026-10-27 · programmer |
| Audit fără emailuri, IP-uri, user-agent (doar id-uri și tipuri) | DONE | `audit.ts`, ADR 0003 | 2026-10-27 · programmer |
| UI: erorile neprevăzute fără detalii (`[ui] sesiunea nu a putut fi verificată`) | DONE | `src/app/_lib/session.ts`, `src/app/error.tsx` | 2026-10-28 · programmer |
| Audit la ștergerile din registru (`transaction.deleted`, `transfer.deleted`, `account.deleted`, `category.deleted`, arhivare) fără sume sau descrieri | DONE | `src/modules/*/…service.ts`, `transactions.test.ts`, `transfers.test.ts` | 2026-10-28 · programmer (F2-A) |
| `app_events`: format fix pentru nume/ecran/cod de eroare (fără text liber sau sume) în bază; lista fixă de nume în Zod | DONE | CHECK-uri în `0002_ledger.sql` (`ledger-rls.test.ts`); lista Zod `APP_EVENT_NAMES`/`APP_SCREENS` în `src/modules/usage/usage.schema.ts` (F2-B), `usage.test.ts` (câmp în plus → 400); agregatul `app_event_daily` cu aceleași formate (0016) | 2026-10-29 · programmer (F9-B) |
| Loguri structurate (pino) | TODO | faza în care apar logurile de business | — |
| F2-B: evenimentele de utilizare fără date financiare (listă fixă de nume, ecrane, coduri; orice câmp în plus → 400 fără ecoul valorii), stocate doar cu consimțământ `usage_stats` activ | DONE (local) | `src/modules/usage/usage.schema.ts`, `usage.test.ts` | 2026-10-28 · programmer (F2-B) |
| F2-B: `X-FINET-Client` parsat strict (chei fixe, limite = CHECK-urile din bază), invalid → ignorat; cel mult o scriere la 15 min; membrii gospodăriei fără emailuri în API | DONE (local) | `src/modules/auth/request.ts`, `usage.test.ts`, `ledger-api.test.ts` | 2026-10-28 · programmer (F2-B) |

## 7. CI și lanțul de aprovizionare

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| `pnpm install --frozen-lockfile`, `minimumReleaseAge` pnpm 12, postinstall blocat | DONE | `pnpm-workspace.yaml`, CI | 2026-10-27 · programmer |
| F6 — `pnpm audit --prod` în CI | PARTIAL | non-blocant (F6) | 2026-10-27 · security |
| F6 — acțiuni GitHub fixate pe SHA (inclusiv `upload-artifact@v5` din job-ul `e2e`), imaginea de bază pe digest, hash în `packageManager` | TODO | `docs/ROADMAP.md` | — |
| Dependabot | DONE | `.github/dependabot.yml` | 2026-10-27 · programmer |
| E2E în CI (ambele moduri) | PARTIAL | job `e2e` în `.github/workflows/ci.yml`: NOT RUN (fără push) | 2026-10-28 · programmer |
| Dependențe noi în F1-C | DONE | niciuna (componentele shadcn și iconițele scrise de mână) | 2026-10-28 · programmer |

## 8. Infrastructură

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Cloudflare Access obligatoriu în producție, fail closed | DONE | `src/proxy.ts`, `access.ts`, `proxy.test.ts`, `access.spec.ts` (PASS local) | 2026-10-27 · security |
| F3 — liveness doar `GET` de pe loopback | DONE | `access.ts`, testele | 2026-10-27 · security |
| Containere: non-root, rootfs read-only, `cap_drop: ALL`, fără porturi publicate | DONE | `Dockerfile`, compose | 2026-10-27 · security |
| F2 — date și secrete în `/srv/finet`, în afara backup-ului `/home` | DONE | `docs/INFRA.md` 4a | 2026-10-27 · security |
| Arhiva necriptată `/home/docker` cu mediul altor containere | TODO | decizia operatorului (`docs/INFRA.md` 4a) | — |
| Data API Supabase oprit, schema `finet` neexpusă (test automat pe proiect real) | TODO | operatorul | — |
| N4 — `roles.sql` pe Supabase PG16+ (`grant finet_migrator to current_user`) | TODO | de verificat pe proiectul real | — |
| F4 — `notify.sh` respinge LF/CR în câmpuri (injecție de antete) | DONE | `ops/notify/test.sh`, `pnpm test:ops` (PASS) | 2026-10-27 · security (T5) |
| F7 — `roles.sql` întărit; CA-ul Supabase din cod (`DATABASE_CA_FILE`, `sslmode=verify-full`) | DONE | `ops/supabase/roles.sql`, `src/lib/db-client.ts`, `db-client.test.ts`, `config.test.ts` | 2026-10-27 · security (T5, T7) |
| N5 — `notify.sh`: antetul `From:` curățat | TODO | `docs/ROADMAP.md` | — |
| N2 — stub-urile worker/migrate validează rolul | PARTIAL | `finet-migrate` folosește `parseConfig` din F1-A; `finet-worker` încă stub | 2026-10-27 · programmer |

## 9. Revizuirea de securitate a Fazei 1 (verdict BLOCKED, 2026-10-28) — corecții

| Constatare | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| **H1** HIGH — open redirect prin dot-segmente (`/.//evil.com`, `/a/..//evil.com`, `/%2e//evil.com`) | DONE | `src/app/_lib/next-path.ts` (validare pe rezultatul normalizat `^/(?!/)[^\\]*$`), `next-path.test.ts` (regresii + proprietate pe 14³ combinații), `e2e/auth.spec.ts` („H1: ?next=/.//evil.com”, NOT RUN local); commit `1c0252e` | 2026-10-28 · programmer |
| **M1** — căi Better Auth active și nelimitate (`/verify-password` etc.) | DONE | listă permisă `ALLOWED_AUTH_PATHS` + `DISABLED_AUTH_PATHS` extins (`auth.ts`, `handler.ts`); `allowlist.test.ts` enumeră `auth.api` și cere 404; `POST /verify-password` cu sesiune → 404; `3bb2000` | 2026-10-28 · programmer |
| **M2** — fără plafon pe email; găleată mobilă după antetul clientului | DONE | plafon pe email (20 eșecuri/oră, `AUTH_LOGIN_EMAIL_*`), doar eșecuri, reset la succes, rezervare atomică înainte de Better Auth, restituire la 5xx/validare, excepția IP-ului cunoscut (30 de zile); mobil doar cu IP de încredere; `me.test.ts` (6 IP × 5 → 429 după 20, IP cunoscut trece, fereastra expiră), `email-cap.test.ts` (30 simultane → exact 20 la Better Auth, reset la succes, restituire la 500); ADR 0003 (risc rezidual); `db53fa2`, `2544eec`, `de3b106` | 2026-10-28 · programmer |
| **M3** — `auth_rate_limits` crește nelimitat | DONE | curățare oportunistă (2 × fereastra, ≤ 1/min/tip, ≤ 500 rânduri), subiect ≤ 254; `rate-limit.test.ts`; `2808e67` | 2026-10-28 · programmer |
| **M4** — oracol de timp la magic link / resetare | DONE | `sendInBackground` (`mailer.ts`, `auth.ts`); `timing.test.ts` (SMTP de 200 ms, diferență < 20 ms); `8386b41`, `a6309bc` | 2026-10-28 · programmer |
| **M5** — `finet_app` putea scrie `is_platform_admin`, `status`, `email`, parola | DONE | `0001_rls.sql` editat direct (neaplicat): GRANT pe coloane, fără DELETE pe `users`, `finet.promote_first_admin` + `finet.bootstrap_state` (irepetabil); `grants.test.ts`; ADR 0003 (decizie și risc rezidual); `ce0bc38`, `fc78395` | 2026-10-28 · programmer |
| **L1** — fără plafon de gospodării | DONE | `create_household`: max. 20 per utilizator (`54000`); `household-limit.test.ts`; `2f9aa94` | 2026-10-28 · programmer |
| **L4** — SMTP fără TLS obligatoriu | DONE | `smtpTransportOptions` (STARTTLS obligatoriu în producție); `mailer.test.ts`; `143e5f0` | 2026-10-28 · programmer |
| **L5** — `get-session` pentru utilizator dezactivat | DONE | `handler.ts` (revocă sesiunile, răspunde `null`); `native-client.test.ts`; `a592bd7` | 2026-10-28 · programmer |
| **L2** — `audit_events` șterse în CASCADE la ștergerea gospodăriei | DONE (decizie, F9-B) | o gospodărie se șterge doar la ștergerea contului SINGURULUI ei membru; jurnalul dispare cu ea, ca restul datelor (nu rămâne nimeni care să-l citească); rămâne o linie de log fără id-uri sau conținut (`[gdpr] cont șters; …`); în gospodăriile cu alți membri plecarea se auditează ÎNAINTE de ieșire (`household.member_left`, `accountDeleted: true`). ADR 0021 §1; `src/modules/gdpr/account-deletion.test.ts` („singurul membru…”, „gospodăria comună…”) PASS pe PG17 și PG18 | 2026-10-29 · programmer (F9-B) |
| **L3** — „ultimul owner” poate pleca/fi scos | DONE (F8-A; și la ștergerea contului, F9-B) | triggerul `household_members_guard_owner` (0012) + `members.service.ts` (`family.test.ts`); ștergerea contului: 409 `last_owner`, nimic șters (`account-deletion.test.ts` „ultimul owner…”, `gdpr-api.test.ts`) | 2026-10-29 · programmer (F9-B) |
| **L6** — tokenul de resetare stocat în clar în `auth_verifications` | TODO | amânat: opțiunea Better Auth pentru resetare nu există ca la magic link (`storeToken: "hashed"`); token de 24 de caractere, 30 de minute, de unică folosință; de revăzut la actualizarea Better Auth | — |
| **L7** — parola generată de CLI pe stdout | TODO | amânat: comportament documentat (afișată o singură dată, operatorul o copiază); alternativa (fișier 0600 / doar `--password-stdin`) se decide cu operatorul | — |
| **L8** — `viaBearer` scutește de CSRF și când există și cookie | TODO | amânat: Bearer cere antet explicit (imposibil cross-site fără CORS, închis); de restrâns la „bearer și fără cookie” la prima revizuire a clientului Android | — |
| Ștergerea contului (GDPR) | DONE (local, PG17 + PG18; E2E scris) | `0016_gdpr_stats.sql` (`finet.erase_current_user`: SECURITY DEFINER, `search_path = pg_catalog`, doar utilizatorul din context, refuză administratorul și un utilizator încă membru, întoarce doar `deleted`/`anonymized`/`not_found`), `src/modules/gdpr/account-deletion.ts`; `account-deletion.test.ts` (9 teste), `gdpr-api.test.ts`; `e2e/gdpr.spec.ts` (NOT RUN local). Detalii: secțiunea 22 | 2026-10-29 · programmer (F9-B) |

## 10. Interfața registrului (F2-C, 2026-10-28)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Fiecare pagină protejată verifică sesiunea (`requireLedgerPage` → `requirePageSession`); fără sesiune 307 la `/login?next=` | DONE | `next dev` + curl pe 8 pagini (307); E2E `auth`/`ledger` (NOT RUN local) | 2026-10-28 · programmer |
| Gospodăria din bază, niciodată din URL sau corp; resursă străină → 404 uniform (pagini și API) | DONE | `ledger-page.ts`, `load()`; curl cu al doilea utilizator: 404 pe `/accounts/<id>`, `/transactions/<id>`, `/api/v1/accounts/<id>`; E2E (g) | 2026-10-28 · programmer |
| Mutațiile din UI trec prin `/api/v1/*` (CSRF prin `Origin`, rate limiting, audit, validare Zod strictă) | DONE | `api-client.ts`, `use-submit.ts`; fără server actions | 2026-10-28 · programmer |
| `Idempotency-Key` per trimitere; un dublu-clic nu creează două tranzacții | DONE | `idempotency-key.test.ts`; E2E (d) (NOT RUN local) | 2026-10-28 · programmer |
| Fără float pe sume în UI | DONE | `ledger-ui.ts` (doar `money.ts`), `ui-rules.test.ts` | 2026-10-28 · programmer |
| `X-FINET-Client` doar cu consimțământul `usage_stats`; fără sume sau text liber | DONE (client) | `usage-client.test.ts` (forma validă pentru `parseClientInfo`), E2E (i) (NOT RUN local) | 2026-10-28 · programmer |
| Serverul verifică acordul `usage_stats` și la înregistrarea instalării; revocarea șterge instalările și evenimentele utilizatorului (revizuirea F2, MEDIUM-1) | DONE (local) | `upsertInstallation` (`hasActiveConsent` în aceeași tranzacție), `eraseUsageData` în `consents.ts`, DELETE propriu pe `client_installations`/`app_events` (0002); `usage.test.ts` (fără acord + antet valid → 0; acord → 1; revocare → 0 instalări, 0 evenimente), `ledger-rls.test.ts` (DELETE doar pe rândurile proprii) | 2026-10-28 · programmer (corecții F2) |
| Plafon de instalări per utilizator (MEDIUM-3) | DONE (local) | `MAX_INSTALLATIONS_PER_USER = 20`; peste plafon se înlocuiește instalarea văzută cel mai demult (lock per utilizator); `usage.test.ts` (100 de uuid-uri → ≤ 20 rânduri) | 2026-10-28 · programmer (corecții F2) |
| Plafonul sumelor: ≤ 10^13 unități minore pe sumă și pe soldul inițial, CHECK în bază; un sold calculat peste 2^53 → 422 `amount_out_of_range`, nu 500 (MEDIUM-2) | DONE (local) | `input.ts` (`MAX_AMOUNT_MINOR`), `transactions_amount_range`, `accounts_opening_balance_range` (0002), `http.ts`; `ledger-api.test.ts` (400 cu `fields`, 2 × plafon → 200, CHECK ca `finet_app` → 23514, 1000 × plafon → 422), `transactions.test.ts` | 2026-10-28 · programmer (corecții F2) |
| Mutarea unei tranzacții pe un cont în altă monedă cere suma explicită (LOW-1) | DONE (local) | `updateTransaction` → 409 `currency_change_requires_amount`; `ledger-api.test.ts` | 2026-10-28 · programmer (corecții F2) |
| Hash-ul `Idempotency-Key` fără recursie nelimitată (adâncime ≤ 20 → altfel 400); CHECK-ul cheii în bază aliniat la 16–128 (LOW-5) | DONE (local) | `exceedsDepth` (iterativ) în `idempotency.ts`, `http.ts`; `idempotency_keys_key_format` (0002); `idempotency.test.ts` (corp cu 2000 de niveluri → 400) | 2026-10-28 · programmer (corecții F2) |
| Retenția `app_events` (13 luni, apoi agregare) (LOW-2) | DONE (local; cron-ul: operatorul, INFRA 4m) | `finet.aggregate_app_events` + `app_event_daily` (0016), `finet-admin aggregate-events`; `stats.test.ts` („retenția…”), `cli.test.ts` („aggregate-events…”) PASS | 2026-10-29 · programmer (F9-B) |
| `q` (căutarea) și, din F3-C, `merchant` în URL (LOW-3) | PARTIAL | aplicația nu loghează URL-uri sau query string-uri (logurile `[api]`/`[ui]` au doar mesaje fixe); proxy-ul/Traefik/Cloudflare pot înregistra URL-urile (`docs/PRIVACY_NOTES.md`). Alternativa `POST /api/v1/transactions/search`: fază viitoare | — |
| Plafoane per gospodărie (conturi, categorii, tranzacții) și rate limit pe citiri (LOW-4) | TODO | fază viitoare; azi: rate limit pe mutații per utilizator, `limit` ≤ 100 pe pagină | — |
| NOTE: `owner_user_id` al contului nu are efect de autorizare (6.1: toți membrii văd conturile gospodăriei); `finet_migrator` nu are politici pe `categories`/`transactions` (FORCE RLS → îi apar goale; doar `idempotency_keys` are politici de curățare) | INFO | ADR 0004, ADR 0005 | 2026-10-28 · programmer |
| Mesajele afișate nu repetă valorile introduse; erorile 500 fără detalii | DONE | `apiErrors()` în `ledger-ui.ts`; `load()` loghează doar un mesaj fix | 2026-10-28 · programmer |

## 11. Planificare și raportare (F3-A, 2026-10-28)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| RLS `ENABLE` + `FORCE` pe cele 5 tabele noi (`tags`, `tag_visibility`, `transaction_tags`, `budgets`, `goals`); fără context → 0 rânduri (nici etichetele de sistem); context străin → 0; `household_id` străin → 42501 | DONE (local, Postgres 17 efemer) | `0004_budgets_goals_tags.sql`, `src/db/planning-rls.test.ts`, `migrate.test.ts` | 2026-10-28 · programmer (F3-A) |
| Bugetele personale vizibile și modificabile doar de proprietar (politică pe `user_id = app.user_id`); un membru nu creează buget personal pentru altul (42501) | DONE (local) | politica `budgets_household`; `planning-rls.test.ts`, `budgets.test.ts` | 2026-10-28 · programmer (F3-A) |
| Cheile străine simple ignoră RLS → triggere `SECURITY INVOKER` (eticheta pe tranzacție, categoria bugetului, vizibilitatea etichetelor) și chei compuse `transaction_tags → transactions(id, household_id)`, `goals → accounts(id, household_id, currency)` | DONE (local) | `0004`, ADR 0007; teste 23503 în `planning-rls.test.ts` | 2026-10-28 · programmer (F3-A) |
| Drepturi minime `finet_app`: `UPDATE` doar pe coloane (fără `household_id`, `system_key`, categoria/moneda/domeniul bugetului, moneda obiectivului, cheile legăturilor); `DELETE` doar unde e nevoie (nu pe `tag_visibility`); nimic pentru `anon`/`authenticated`/`PUBLIC` | DONE (local) | `grants.test.ts` (listă exactă), `planning-rls.test.ts` | 2026-10-28 · programmer (F3-A) |
| Izolarea între gospodării pentru FIECARE serviciu nou (etichete, bugete, obiective, dashboard, raport, export): A nu vede/modifică datele lui B → `NotFoundError`; `householdId` în corp → 400 | DONE (local) | `src/modules/{tags,budgets,goals,dashboard,reports,exports}/*.test.ts` | 2026-10-28 · programmer (F3-A) |
| Export CSV izolat pe gospodărie, protecție contra CSV/formula injection pe celulele de text liber (`= + - @ TAB CR` → `'`), plafon 50.000 de rânduri (409 fără conținut parțial) | DONE (local) | `src/modules/exports/{csv,exports}.service.ts`; `csv.test.ts`, `exports.test.ts` (date ale altei gospodării prezente, `=cmd|...`, `=HYPERLINK(...)`) | 2026-10-28 · programmer (F3-A) |
| Exportul CSV: rate limit propriu (`api_export`, 10/min per utilizator, verificat înaintea interogărilor) și audit `export.downloaded` cu doar `{ kind, rows }`; un export refuzat nu se auditează | DONE (local) | `planning-handlers.ts`, `exports.service.ts`; `planning-api.test.ts` (3 exporturi → 3 rânduri de audit cu exact cheile `kind`, `rows`; al 3-lea export peste limita 2 → 429 cu `Retry-After`) | 2026-10-28 · programmer (F3-B) |
| Răspunsurile CSV: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment` cu nume fix (fără date ale utilizatorului), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; BOM; peste plafon → 409 JSON fără conținut parțial; închiderea fluxului de către client oprește generatorul | DONE (local) | `assertContract` (antete + octeții BOM la fiecare răspuns CSV din teste); `planning-api.test.ts` (plafon injectat 1 → 409, 2 → 200; pagini de 1 = același conținut; `cancel` fără erori) | 2026-10-28 · programmer (F3-B) |
| API F3-B: 401 pe FIECARE endpoint nou (fără sesiune și cu bearer inventat); izolare între gospodării (404 uniform pe GET/PATCH/DELETE/contribuții/abandon, eticheta altei gospodării pe tranzacție → 404); `householdId` în corp → 400 pe fiecare mutație; cookie fără `Origin` → 403; 415; parametri necunoscuți/repetați → 400 | DONE (local) | `planning-api.test.ts` (23 de endpointuri × 2 pentru 401; 7 mutații cu corp × 3 verificări) | 2026-10-28 · programmer (F3-B) |
| Contribuțiile la obiective cer `Idempotency-Key` (o reîncercare fără cheie ar dubla suma); aceeași cheie → reluare fără a doua scriere; alt corp → 422 | DONE (local) | `contributeGoalHandler`; `planning-api.test.ts` | 2026-10-28 · programmer (F3-B) |
| Luna din URL validată strict (format + interval: 60 de luni în urmă … luna curentă) pe dashboard, raport, `budgets/status`, `budgets.csv` | DONE (local) | `planning-handlers.ts` (`monthOf`); `planning-api.test.ts` | 2026-10-28 · programmer (F3-B) |
| Totalurile dashboard-ului/raportului peste 2^53 − 1 → 422 `amount_out_of_range` (nu 500, nu valoare trunchiată) | DONE (local) | `planning-api.test.ts` (1000 × 10^13 pe două conturi) | 2026-10-28 · programmer (F3-B) |
| Revizuirea `security` a F3-B | TODO | agentul `security` | — |
| Auditul ștergerilor noi fără date personale (`tag.deleted` cu `usageCount`, `budget.deleted` cu `scope`, `goal.deleted` cu `status`) | DONE (local) | `audit.ts`; testele modulelor | 2026-10-28 · programmer (F3-A) |
| Revizuirea F2, LOW-1: o scriere de statistici de utilizare nu supraviețuiește revocării `usage_stats` | DONE (local) | `lockUserUsage` în `setConsents`/`upsertInstallation`/`recordEvents`; `consents-lock.test.ts` (două tranzacții intercalate; pică fără lacăt) | 2026-10-28 · programmer (F3-A) |
| Revizuirea F2, LOW-2: soldul unui cont nu poate depăși 2^53 − 1 prin scrieri legitime | DONE (local) | `range-guard.ts` (`FOR NO KEY UPDATE`, ordinea id-ului); `range-guard.test.ts` (900 × 10^13 + rest exact trece, +1 → `MoneyOverflowError`, la fel pentru mutare, transfer, sold inițial) | 2026-10-28 · programmer (F3-A) |
| Totaluri pe gospodărie (mai multe conturi) peste 2^53 − 1 | PARTIAL | nemărginite la scriere (risc rezidual, ADR 0007); la citire `toJson` → 422 `amount_out_of_range`, nu valoare trunchiată | — |
| Migrația `0004` aplicată pe Supabase și verificată acolo (PostgreSQL ≥ 15 pentru `ON DELETE SET NULL (account_id)`; producția e 17) | TODO | operatorul, după revizuiri | — |
| Revizuirea `security` a F3-A | TODO | agentul `security` | — |

## 12. Interfața planificării (F3-C, 2026-10-28)

| Control | Stare | Dovadă | Data · cine |
|---|---|---|---|
| Paginile noi (`/tags`, `/budgets*`, `/goals*`, `/reports`, `/dashboard`) apelează `requireLedgerPage(<cale>)`; datele din servicii (`withMember` + RLS); id străin/invalid → 404 uniform | DONE (cod; E2E scris) | paginile din `src/app/(app)/`; `e2e/planning.spec.ts` (f) | 2026-10-28 · programmer (F3-C) |
| Gospodăria nu vine din client: mutațiile UI trimit doar câmpurile schemei stricte (fără `householdId`/`userId`); editarea bugetului trimite doar limita, pragul, arhivarea | DONE | `budget-form.tsx`, `goal-form.tsx`, `tags-manager.tsx`, `transaction-form.tsx` | 2026-10-28 · programmer (F3-C) |
| CSP cu nonce fără încălcări și fără `style=` pe paginile noi; dimensiunile graficelor și culorile etichetelor ca atribute SVG; fără `dangerouslySetInnerHTML` | DONE (static) / E2E NOT RUN | `ui-rules.test.ts` (PASS); `e2e/planning.spec.ts` (g) | 2026-10-28 · programmer (F3-C) |
| Descărcarea CSV prin `fetch` cu cookie pe aceeași origine (fără token în URL), mereu `dialect=ro`; numele fișierului din `Content-Disposition` acceptat doar ca nume simplu; 409/429 cu mesaje fixe | DONE | `src/app/_lib/download.ts`, `download.test.ts` (PASS); E2E (e) | 2026-10-28 · programmer (F3-C) |
| Exportul tranzacțiilor din UI poartă exact filtrele paginii (fără `sort`), deci nu exportă mai mult decât vede utilizatorul; izolarea exportului verificată și cu alt utilizator | DONE (unit) / E2E NOT RUN | `exportSearch` + `transaction-filters.test.ts` (PASS); E2E (e), (f) | 2026-10-28 · programmer (F3-C) |
| Contribuțiile la obiective trimit mereu `Idempotency-Key` (UUID nou per acțiune, păstrat doar la reîncercarea aceluiași corp) | DONE | `goal-actions.tsx` (`useSubmit` cu `idempotent`); E2E (c) | 2026-10-28 · programmer (F3-C) |
| Luna din URL validată în pagini cu fereastra API-ului (60 de luni … luna curentă); altă valoare → luna curentă, fără eroare | DONE | `planning-page.ts`, `pickMonth` + `planning-ui.test.ts` (PASS) | 2026-10-28 · programmer (F3-C) |
| Text liber (`q`, `merchant`) în URL: decizie documentată (vederi salvabile), indiciu la câmp | PARTIAL (acceptat) | ADR 0008; LOW-3 mai sus | 2026-10-28 · programmer (F3-C) |
| Bani în UI doar prin `money.ts`: scalarea graficelor prin `percentOf` (bigint), valoarea absolută prin `negate` | DONE | `planning-ui.ts`, `ui-rules.test.ts` | 2026-10-28 · programmer (F3-C) |
| `pnpm build` + `scan:client-secrets` pe codul F3-C | NOT RUN (memoria hostului) | CI | — |
| Revizuirea `security` a F3-C | TODO | agentul `security` | — |
| Revizuirea Fazei 3, LOW-2: exporturile CSV cu cookie refuză navigarea cross-site (`Sec-Fetch-Site` doar `same-origin`/`none`; lipsă → 403); bearer permis | DONE (cod + test) / teste NOT RUN local | `planning-handlers.ts` `assertExportFetchSite`; `planning-api.test.ts`; OpenAPI (403 pe exporturi); ADR 0007 | 2026-10-28 · programmer (F3-D) |

## 13. Backup restic (F3-D, 2026-10-28)

| Control | Stare | Dovadă | Data · cine |
|---|---|---|---|
| Dump complet în ciuda RLS `FORCE`: rol dedicat `finet_backup` (LOGIN, BYPASSRLS, doar USAGE + SELECT pe `finet`, privilegii implicite, read-only, 2 conexiuni); migratorul și `finet_app` eșuează, `--enable-row-security` interzis (dump gol) | DONE (PG17 efemer) / TODO pe Supabase | `ops/backup/backup-role.sql`, `restore-test.sh` b), `test.sh` | 2026-10-28 · programmer (F3-D) |
| Un `pg_dump` eșuat nu devine instantaneu (`--stdin-from-command`), cod ≠ 0 la orice etapă | DONE | `backup.sh`; `restore-test.sh` (3 negative, niciun instantaneu nou) | 2026-10-28 · programmer (F3-D) |
| Secrete doar ca fișiere: parola restic, adresa, fișierul libpq (fără URL/parolă în argumente), cheile S3/SFTP; nimic în `environment` sau în imagine; logul fără secrete | DONE | compose `finet-backup`, `lib.sh`, `test-env-examples.sh`, `test.sh`, `restore-test.sh` (grep în log) | 2026-10-28 · programmer (F3-D) |
| TLS spre Supabase: fișierul libpq trebuie să aibă `sslmode=verify-full` (excepție doar `FINET_BACKUP_INSECURE_DB=1` în teste) | DONE | `lib.sh` `check_pg_service`, `test.sh` | 2026-10-28 · programmer (F3-D) |
| SFTP: `known_hosts` fixat, `StrictHostKeyChecking=yes`, `BatchMode` | DONE (cod) / NOT RUN pe un server real | `lib.sh`, `compose.sftp.yml`, `test.sh` | 2026-10-28 · programmer (F3-D) |
| Container: uid 1000, rootfs read-only, `cap_drop: ALL`, `no-new-privileges`, 256 MiB, storage read-only, rețeaua `finet_default`, fără porturi, one-shot | DONE | `ops/docker/docker-compose.yml`, `test-env-examples.sh`, `docker compose config` (PASS) | 2026-10-28 · programmer (F3-D) |
| Restaurarea păstrează RLS `ENABLE`+`FORCE`, politicile, GRANT-urile (și pe coloane), proprietarii; refuză fără `--yes` și peste o schemă plină | DONE (PG17 efemer) | `restore.sh`, `restore-test.sh` d), e) | 2026-10-28 · programmer (F3-D) |
| Destinația în afara serverului: Google Drive prin rclone (decizia operatorului); protecția la ștergere e doar coșul Drive (~30 de zile), NU Object Lock | PARTIAL (acceptat de operator) | `compose.rclone.yml`, `docs/BACKUP.md` 2a, ADR 0009 | 2026-10-28 · programmer (F3-D) |
| Configul rclone: doar `[Gdrive]`, secret-fișier `0400` uid 1000, montat read-only (tokenul reîmprospătat rămâne în memorie), refuzat dacă e citibil de alții, conținut nelogat; tokenul are scope `drive` complet (risc acceptat; variantă mai strictă: `drive.file`/cont dedicat) | DONE (cod + teste) / instalarea: operatorul | `lib.sh` `check_rclone_config`, `ops/backup/test.sh`, `test-env-examples.sh`, `restore-test.sh` (backend `rclone`) | 2026-10-28 · programmer (F3-D) |
| Parola restic păstrată și în afara serverului | TODO | operatorul | — |
| Primul backup real + restaurare de probă | TODO | operatorul (`docs/BACKUP.md` 5) | — |
| Revizuirea Fazei 3, LOW-1: cron-ul root rulează doar dintr-un checkout `root:root` nescriibil de alții; `run-backup.sh` verifică lanțul (scripturi, compose, `compose.env`, fișierele de mediu, directoarele până la `/`) și refuză; nimic `source`-at | DONE (cod + `test.sh`) / instalarea: operatorul | `run-backup.sh` `check_trust`, `ops/backup/test.sh`, `docs/BACKUP.md` 6 | 2026-10-28 · programmer (F3-D) |
| Revizuirea Fazei 3, LOW-3: imaginea de bază a backup-ului fixată pe digest | DONE | `ops/backup/Dockerfile` (`alpine:3.22.7@sha256:2e0b81d6…`, din registry), ADR 0009 | 2026-10-28 · programmer (F3-D) |
| Revizuirea Fazei 3, LOW-4: `finet_backup` fără CREATE în `public` (verificat, oprire la `true`); `default_transaction_read_only` notat ca apărare în plus | DONE (PG17 efemer) | `backup-role.sql`, `docs/BACKUP.md` 3 | 2026-10-28 · programmer (F3-D) |
| Revizuirea Fazei 3, INFO-1/2: backup-ul conține hash-uri de parole și sesiuni (invalidarea după restaurări non-prod); logul `0600` + `logrotate` | DONE (docs) | `docs/BACKUP.md` 6, 9 | 2026-10-28 · programmer (F3-D) |
| Revizuirea `security` a F3-D | DONE (PASS_WITH_FINDINGS, 0 Critical/High; corecțiile de mai sus) | coordonatorul | 2026-10-28 · security |

## 14. Stabilizare (Faza 4, 2026-10-28)

| Control | Stare | Dovadă | Data · cine |
|---|---|---|---|
| Prefetch RSC (`?_rsc=`, `RSC: 1`, `Next-Router-Prefetch: 1`) fără sesiune, pe TOATE rutele din `(app)` (citite din fișiere): niciun marcaj de date în răspuns, doar redirecționare la `/login`; cu sesiune marcajul apare (testul poate eșua) | DONE (test) / NOT RUN local (fără browser și RAM) | `e2e/regressions.spec.ts` (b), proiectul `regressions` în CI | 2026-10-28 · programmer (F4) |
| Paginile publice (`/`, `/login`, `/register`, 404) cer resurse doar de pe propriul domeniu (fără fonturi, analytics, CDN) | DONE (test) / NOT RUN local | `e2e/regressions.spec.ts` (a); fonturile sunt locale (`src/app/fonts/`) | 2026-10-28 · programmer (F4) |
| Pagina `global-error` proprie, fără `style=`, fără detalii tehnice | DONE | `src/app/global-error.tsx`, `ui-rules.test.ts` | 2026-10-28 · programmer (F4) |
| Recuperarea după deploy: reîncărcare doar pentru fișiere `/_next/static/` de pe propriul domeniu, cel mult o dată la 8 s, fără buclă dacă `sessionStorage` lipsește; fără `eval`, fără date în stocare (doar momentul ultimei reîncărcări) | DONE | `src/app/_lib/chunk-recovery.ts`, `chunk-recovery.test.ts` | 2026-10-28 · programmer (F4) |
| `tagMatch=any\|all`: același filtru pe gospodărie (`household_id` din sesiune), id-uri uuid validate, parametri SQL legați (fără interpolare) | DONE (Postgres 17 efemer) | `transactions.repo.ts`, `planning-api.test.ts`, `exports.test.ts` | 2026-10-28 · programmer (F4) |
| Migrația `0005_perf_indexes`: doar un index; RLS, politici, drepturi neatinse | DONE (PG17 efemer) / TODO pe Supabase | `migrate.test.ts` (0005 peste 0000–0004) | 2026-10-28 · programmer (F4) |
| Revizuirea `security` a Fazei 4 | TODO | agentul `security` | — |

## 15. Recurențe și workerul pg-boss (F5-A, 2026-10-28)

| Control | Stare | Dovadă | Data · cine |
|---|---|---|---|
| `recurring_rules`, `recurring_occurrences`, `service_heartbeats`: RLS `ENABLE`+`FORCE` în migrația care le creează; politici pe gospodărie; fără context RLS, `finet_app` nu vede nimic | DONE (PG17 efemer) | `0006_recurring.sql`, `migrate.test.ts`, `recurring.test.ts` (izolare) | 2026-10-28 · programmer (F5-A) |
| Izolare între gospodării pe fiecare serviciu (citire, modificare, pauză, reluare, ștergere, generare): 404 uniform | DONE (PG17 efemer) | `recurring.test.ts` | 2026-10-28 · programmer (F5-A) |
| `due_recurring_rules`: SECURITY DEFINER cu `search_path = pg_catalog`, proprietar `finet_migrator`, EXECUTE doar `finet_app`; întoarce doar `(rule_id, household_id, actor_user_id)`, doar reguli active scadente; „azi” plafonat la data reală, `limit` 0..1000 | DONE (PG17 efemer) | `0006_recurring.sql`, `recurring.test.ts` | 2026-10-28 · programmer (F5-A) |
| Risc rezidual acceptat: un `finet_app` compromis poate lista id-urile regulilor scadente ale tuturor gospodăriilor (fără sume/descrieri); nu adaugă expunere nouă: același rol poate deja enumera utilizatorii (`users`, fără RLS) și apartenențele lui | ACCEPTED (confirmat de revizuirea `security` F5) | ADR 0011 | 2026-10-28 · programmer (F5-A) |
| Drepturi pe coloane: tipul, `start_on`, gospodăria și creatorul regulii nu se schimbă; ocurențele nu se modifică/șterg de aplicație | DONE (PG17 efemer) | `grants.test.ts` (0006) | 2026-10-28 · programmer (F5-A) |
| Idempotența generării: unicitate în bază `(rule_id, occurrence_date)`, `FOR UPDATE SKIP LOCKED`, 5 rulări paralele → 0 duplicate; eșec pe al doilea rând → nimic scris | DONE (PG17 efemer) | `recurring.test.ts` | 2026-10-28 · programmer (F5-A) |
| Garda 2^53 aplicată și tranzacțiilor generate | DONE (PG17 efemer) | `recurring.test.ts` | 2026-10-28 · programmer (F5-A) |
| Schema `pgboss`: creată de operator (deținută de `finet_migrator`), nimic pentru PUBLIC/`anon`/`authenticated`; `finet_app` fără CREATE, fără scriere în `version`/`bam` (comenzi executate de pg-boss), EXECUTE doar `job_now`/`create_queue` | DONE (PG17 efemer) / TODO pe Supabase | `0007_pgboss.sql`, `ops/supabase/pgboss-schema.sql`, `grants.test.ts`, `pgboss.test.ts` | 2026-10-28 · programmer (F5-A) |
| Workerul fără DDL la rulare (`migrate`/`createSchema`/`reindex`/`persistQueueStats` oprite) | DONE (pg-boss real pe PG17 efemer) | `src/worker/boss.ts`, `pgboss.test.ts` | 2026-10-28 · programmer (F5-A) |
| Revizuirea `security` F5, I2: workerul cere `sslmode=verify-full` + `DATABASE_CA_FILE` în ORICE mediu; singura excepție `FINET_ALLOW_INSECURE_DB=1` (teste/CI), refuzată în producție | DONE (teste) | `src/lib/config.ts`, `src/worker/boss.ts`, `config.test.ts`, `worker.test.ts` | 2026-10-28 · programmer (F5-A) |
| Revizuirea `security` F5, L2: plafoane la creare (200 de reguli/gospodărie sub lock, `startOn` ≤ 5 ani în urmă, restanță inițială ≤ 1200 fără număr de rate) | DONE (PG17 efemer, limite 199/200/201, ±1 zi, 1200/1201) | `recurring.service.ts`, `recurring.test.ts` | 2026-10-28 · programmer (F5-A) |
| Revizuirea `security` F5, I1: workerul fără storage montat și fără `STORAGE_DIR` | DONE | `docker-compose.yml`, `config.ts`, `config.test.ts` | 2026-10-28 · programmer (F5-A) |
| Revizuirea `security` F5, L1: web și worker folosesc același rol `finet_app` (web poate scrie `service_heartbeats` și `pgboss.*`); rolul `finet_worker` separat amânat (rol + secret nou, Faza 6) | ACCEPTED (amânat) | ADR 0011 „Riscuri acceptate” | 2026-10-28 · programmer (F5-A) |
| Revizuirea `security` F5, I3: semnalul de viață arată doar că procesul trăiește; semnal pe ultimul job terminat = TODO | TODO | ADR 0011 | — |
| Revizuirea `security` F5, I5: cu `Idempotency-Key`, rollback-ul tranzacției externe anulează și înregistrarea eșecului pe regulă (fără pierdere sau dublare de date) | ACCEPTED (limitare cunoscută) | ADR 0011 | 2026-10-28 · programmer (F5-A) |
| TLS-ul workerului fail-closed (review automat, MEDIUM): doar `sslmode` scris exact, o dată; orice alt parametru TLS/grafie/valoare/duplicat → eroare la pornire; în producție doar `verify-full` + `DATABASE_CA_FILE` (și în `parseConfig`); `ssl: { ca, rejectUnauthorized: true }` explicit (driverul `pg` ar suprascrie CA-ul din URL) | DONE (unitar + bundle real) / NOT RUN pe Supabase | `src/worker/boss.ts`, `src/lib/config.ts`, `worker.test.ts`, `config.test.ts` | 2026-10-28 · programmer (F5-A) |
| Logurile workerului: doar contoare și coduri, fără sume, descrieri, comercianți, id-uri, URL-uri sau mesaje de eroare | DONE (test) | `jobs.ts`, `main.ts` (`errorCode`), `worker.test.ts`, `pgboss.test.ts` | 2026-10-28 · programmer (F5-A) |
| Joburile la cerere: date validate strict (Zod), membrul verificat în bază | DONE (PG17 efemer) | `jobs.ts`, `worker.test.ts` | 2026-10-28 · programmer (F5-A) |
| Containerul worker: imaginea de unelte, user `node`, `read_only`, `cap_drop: ALL`, doar secretul lui, `mem_limit: 150m` | DONE (`test-env-examples.sh`) | `docker-compose.yml`, `ops/docker/test-env-examples.sh` | 2026-10-28 · programmer (F5-A) |
| `pg-boss` 12.38.0 (MIT, fără scripturi de instalare); upgrade = migrație nouă (testul pică dacă `0007` nu mai corespunde) | DONE | `package.json`, `scripts/pgboss-plan.test.ts`, ADR 0011 | 2026-10-28 · programmer (F5-A) |
| Revizuirea `security` a F5-A | DONE (PASS_WITH_FINDINGS, 0 High/Medium; corecțiile de mai sus) | agentul `security` | 2026-10-28 · security |
| F5-B: rutele `/api/v1/recurring/**`: sesiune, CSRF pe cookie, gospodăria din bază (niciodată din corp), Zod strict (chei necunoscute → 400), resursă străină → 404 uniform | DONE (PG17 efemer) | `recurring-handlers.ts`, `recurring-api.test.ts` | 2026-10-28 · programmer (F5-B) |
| F5-B: `POST /recurring/generate`: `Idempotency-Key` obligatoriu, „azi” din ceasul serverului (nu din cerere), limită proprie 6/min (429) peste limita mutațiilor, fără pg-boss în web; audit doar cu contoare | DONE (PG17 efemer) | `recurring-api.test.ts` | 2026-10-28 · programmer (F5-B) |
| F5-B: contractul OpenAPI verificat pe fiecare răspuns (`assertContract`), `recurringRuleId` pe `Transaction` | DONE | `openapi.test.ts`, `ledger-api.test.ts`, `planning-api.test.ts`, `recurring-api.test.ts` | 2026-10-28 · programmer (F5-B) |
| F5-B: paginile noi fără `style=`, un singur `h1`, câmpuri etichetate, zero încălcări CSP | DONE (static) / NOT RUN local (E2E în CI) | `ui-rules.test.ts`, `a11y-rules.test.ts`, `e2e/recurring.spec.ts` (d) | 2026-10-28 · programmer (F5-B) |
| Revizuirea `security` a F5-B | TODO | agentul `security` | — |

## 16. Ingestia documentelor (F6-A, 2026-10-29)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Tipul după conținut (semnătura la offset 0): JPEG, PNG, WebP, PDF; SVG, HTML, EXE, ZIP, poligloți (marcaje HTML/SVG la început), HEIC/AVIF refuzați cu cod stabil | DONE (teste) | `content.ts`, `content.test.ts`, `multipart.test.ts` | 2026-10-29 · programmer (F6-A) |
| Bombe de decompresie: dimensiunile din antet ≤ `MAX_IMAGE_PIXELS` înainte de stocare; `limitInputPixels` în sharp | DONE (teste) | `content.ts`, `preprocess.ts` | 2026-10-29 · programmer (F6-A) |
| Corp în flux (busboy), `Content-Length` și plafon dur pe corp, ≤ 4 fișiere, câmpuri permise, corp trunchiat respins, fișierele cererii șterse la orice eroare | DONE (teste) | `multipart.ts`, `multipart.test.ts` | 2026-10-29 · programmer (F6-A) |
| `src/proxy.ts` trunchiază corpurile > 10 MB fără eroare (Next 16 `proxyClientMaxBodySize`): ruta publică trebuie exclusă din proxy sau limita ridicată | DONE (F6-C: exclusă exact `/api/v1/documents`, Access refăcut în rută; secțiunea 18) | `proxy.ts`, `access-guard.ts`, `proxy.test.ts`, `access.spec.ts` | 2026-10-29 · programmer (F6-C) |
| Rate limit dedicat încărcării (`api_document_upload`, 30/10 min) înaintea citirii corpului; apartenența verificată înainte de citire | DONE (teste) | `documents-handlers.ts`, `documents-api.test.ts`, `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| Cotă pe gospodărie și limită zilnică sub lock; limita zilnică dintr-un contor care doar crește (ștergerea nu o eliberează; revizuire M3) | DONE (PG17 efemer) | `documents.service.ts`, `document_usage_daily`, `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| Deduplicarea (SHA-256) înaintea limitelor; unic `(household_id, sha256)` în bază | DONE (PG17 efemer) | `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| Chei de storage generate de server, legate de rând prin CHECK (`households/<gospodărie>/documents/<id>`); fără traversare | DONE (teste) | `0008_documents.sql`, `storage.test.ts`, `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| RLS ENABLE + FORCE pe cele 7 tabele noi, 0 rânduri fără context, străinii → 42501/404; GRANT-uri pe coloane; `ai_calls` și contorul zilnic fără UPDATE/DELETE relevante | DONE (PG17 efemer) | `grants.test.ts`, `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| `queued_documents`: SECURITY DEFINER, `search_path = pg_catalog`, doar id-uri, EXECUTE doar pentru `finet_app` | DONE (PG17 efemer) | `grants.test.ts`, `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| EXIF/GPS eliminat din imaginea preprocesată (verificat pe octeți), rotirea aplicată; tipul confirmat de decodor | DONE (teste) | `preprocess.test.ts`, `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| PDF citit într-un proces copil sub `prlimit` (adrese 1,8 GB, CPU, fără fișiere), SIGKILL la termen; copilul trimite doar JPEG ≤ 2048 px, părintele validează antetul și un buget fix de 32 MB înainte de a citi corpul (un singur buffer); bombă 12000×12000 ucide doar copilul (revizuiri M1/M2 și „parser differential”) | DONE (teste; `prlimit` verificat în `finet:tools`) | `pdf-sandbox.ts`, `pdf-child.mjs`, `pdf-sandbox.test.ts` | 2026-10-29 · programmer (F6-A) |
| Inventarul pe octeți al imaginilor PDF: doar fail-fast, fail-closed (`#xx`, `/W` `/H`, duplicate, indirecte, ObjStm, imagini inline vizibile) | DONE (teste de adversar) | `pdf-scan.ts`, `pdf-sandbox.test.ts` | 2026-10-29 · programmer (F6-A) |
| Timeout fără muncă în fundal (sharp `timeout`, copil ucis, termen verificat între pași) | DONE (teste) | `preprocess.ts`, `preprocess.test.ts` | 2026-10-29 · programmer (F6-A) |
| Workerul: storage DOAR citire (montaj + driver), `mem_limit` 384m, încercările numărate înainte de lucru (≤ 10) | DONE (`test-env-examples.sh`, teste) | `docker-compose.yml`, `documents-job.ts` | 2026-10-29 · programmer (F6-A) |
| Fără antivirus (ClamAV) — risc acceptat de operator, mitigări în ADR 0013 | ACCEPTED | ADR 0013, decizia 5 | 2026-10-29 · operator (F6-COMUN) |
| Originalele cu EXIF stau pe disc până la retenție; ștergerea automată la `expires_at` | DONE în repo (F6-C: `cleanup-documents`); TODO operator: cron-ul `finet-cleanup` (INFRA 4i) | `retention.ts`, `retention.test.ts` | 2026-10-29 · programmer (F6-C) |
| Audit fără nume de fișiere sau conținut (`document.uploaded` doar contoare, `document.deleted` doar id) | DONE (test) | `documents.test.ts` | 2026-10-29 · programmer (F6-A) |
| Revizuirea `security` a F6-A | TODO (revizuirile automate tratate: M1, M2, M3, „parser differential”) | agentul `security` | — |

## 17. Pipeline-ul AI al bonurilor (F6-B, 2026-10-29)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| `AI_BASE_URL` doar `http(s)`, `host:port` exact din `AI_ALLOWED_HOSTS`, fără utilizator/query/fragment; URL-ul final re-verificat; redirecționări refuzate (anti-SSRF) | DONE (teste) | `client.ts`, `client.test.ts`, `config.test.ts` | 2026-10-29 · programmer (F6-B) |
| Cheia LiteLLM doar din `AI_API_KEY_FILE`, doar în rolul worker (în clar sau în alt rol → refuz la pornire); doar în `Authorization`; niciodată în loguri, erori sau `ai_calls` | DONE (teste) | `config.ts`, `secret-files.ts`, `test-env-examples.sh`, `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| Timeout care oprește efectiv munca (`AbortController` pe încercare, termen total, termenul documentului de 12 min peste preprocesare și apeluri); reîncercări limitate doar la timeout/429/5xx | DONE (teste) | `client.ts`, `receipt-job.ts` | 2026-10-29 · programmer (F6-B) |
| Răspunsul AI plafonat ÎNAINTE de alocare/parsare: `Content-Length`, citire în flux cu plafon (512 KB), conținut ≤ 128 000 de caractere, adâncime și număr de valori verificate înainte de `JSON.parse` | DONE (teste) | `client.ts`, `json-guard.ts`, `client.test.ts` | 2026-10-29 · programmer (F6-B) |
| Ieșirea modelului = date neîncrezătoare: Zod strict (chei în plus respinse, ≤ 500 de linii), sume doar șiruri → bigint (fără float), plafon 10^13, text curățat (control/bidi/lățime zero); fără `tools`, nimic executat, nicio tranzacție automată | DONE (teste) | `extraction.schema.ts`, `normalize.ts`, `receipts.test.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| Injecția de prompt pe textul bonului: delimitare + „date, nu instrucțiuni”; controlul real = ieșire validată + verificări în cod + `needs_review` mereu | DONE (test) | `prompts.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| Consimțământ `external_ai` al celui care a încărcat, verificat sub lock înaintea oricărui apel; fără el, 0 cereri | DONE (PG17 + server fals) | `receipt-job.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| Bugetul global dintr-un contor care doar crește (`ai_budget_usage`), independent de gospodării, fără drepturi directe pentru `finet_app`, rezervare atomică pesimistă înaintea fiecărei încercări; buget 0 = nimic nu pleacă | DONE (PG17: atomicitate cu 10 rezervări paralele) | `0009_receipt_pipeline.sql`, `ai-budget.ts`, `grants.test.ts` | 2026-10-29 · programmer (F6-B) |
| `ai_calls` fără conținut; tokenii raportați de furnizor plafonați | DONE (test) | `receipt-job.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| `queued_document`, `ai_budget_reserve`, `ai_budget_spent`: SECURITY DEFINER, proprietar `finet_migrator`, `search_path = pg_catalog`, EXECUTE doar `finet_app`; jobul re-derivă gospodăria și membrul din bază | DONE (PG17) | `grants.test.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| `vat_rates`: RLS ENABLE + FORCE, doar SELECT; `receipts` noi: GRANT-uri pe coloane | DONE (PG17) | `grants.test.ts`, `migrate.test.ts` | 2026-10-29 · programmer (F6-B) |
| Izolarea între gospodării în job (A nu vede bonul lui B; job cu gospodărie străină → fără efect); idempotența (de 2 ori, prin job, în paralel → un bon) | DONE (PG17) | `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| O constrângere a bazei nu declanșează o nouă extragere plătită (bon gol „De verificat” în loc de reîncercare) | DONE (teste: cantitate 0, > 500 de linii) | `receipt-job.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (F6-B) |
| `json_schema` acceptat de LiteLLM → Gemini (tipuri reuniune, `pattern`) | TODO (operator, primul deploy; plasă: `AI_RESPONSE_FORMAT=json_object`) | INFRA 4h, ADR 0014 | — |
| Jurnalele LiteLLM fără corpurile cererilor pentru cheia FINET | TODO (operator) | PRIVACY_NOTES | — |
| Textul PDF fără NUL/caractere de control (copil, părinte, prompt, `ocr_text`); test cu ToUnicode → U+0000 | DONE (PG17) | `pdf-child.mjs`, `pdf-sandbox.ts`, `normalize.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (revizuirea F6-A+B) |
| Erorile joburilor pg-boss: doar `job_failed:<cod>`, niciodată eroarea originală (parametrii SQL) în `pgboss.job.output`; după apelurile plătite, orice eroare de salvare → bon gol, fără reluare plătită | DONE (pg-boss real) | `main.ts` (`safeHandler`), `receipt-job.ts`, `pgboss.test.ts` | 2026-10-29 · programmer (revizuirea F6-A+B) |
| Consimțământul verificat înaintea fiecărei încercări (extragere, categorisire); retragerea în timpul jobului → 0 cereri următoare | DONE (test) | `receipt-job.ts`, `receipt-job.test.ts` | 2026-10-29 · programmer (revizuirea F6-A+B) |
| Selecția workerului echitabilă (≤ 5 pe gospodărie), fără loturi `failed`; lot cu poză respinsă → toate pozele `failed` | DONE (PG17) | `0010_worker_queue_fairness.sql`, `receipt-job.test.ts`, `migrate.test.ts` | 2026-10-29 · programmer (revizuirea F6-A+B) |
| Costul real peste rezervare intră în contorul bugetului | DONE (test) | `receipt-job.ts` | 2026-10-29 · programmer (revizuirea F6-A+B) |
| Revizuirea `security` a F6-B | TODO | agentul `security` | — |

## 18. API-ul și interfața bonurilor (F6-C, 2026-10-29)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Ruta de încărcare exclusă din proxy (flux, fără trunchiere la 10 MB) FĂRĂ a slăbi Access: matcher exact `api/v1/documents$`, sub-căile prin proxy; în rută aceeași `isRequestAllowed`, același verificator JWKS, aceleași antete, înainte de sesiune și de corp, pe GET/HEAD/POST/OPTIONS (celelalte metode: 405 al Next, fără handler); fail closed; `HEALTH_TOKEN` nu o deschide | DONE (teste unitare; E2E `access` pe serverul de producție în CI) | `proxy.ts`, `access-guard.ts`, `proxy.test.ts`, `e2e/access.spec.ts` | 2026-10-29 · programmer (F6-C) |
| Un fișier de 11 MB ajunge întreg la handler și e refuzat de limita aplicației (`413 file_too_large`, nu `invalid_multipart`) | DONE (handler, PG17); E2E prin serverul Next: CI | `receipts-api.test.ts`, `e2e/receipts.spec.ts` | 2026-10-29 · programmer (F6-C) |
| Fișierele servite doar membrilor (RLS, 404 uniform), tipul DETECTAT (niciodată HTML/SVG), `attachment` cu nume generat de server, `nosniff`, `no-store`, `CSP: default-src 'none'; sandbox`, `CORP: same-origin`; citirea plafonată la dimensiunea înregistrată | DONE (PG17) | `documents-handlers.ts`, `documents.service.ts`, `receipts-api.test.ts`, `testing.ts` (`assertContract`) | 2026-10-29 · programmer (F6-C) |
| Zod strict pe toate intrările noi (query, `PATCH`, `confirm`, `reprocess`); sumele doar întregi `…Minor`, cantitatea/TVA text, fără float; id-urile de linii doar ale bonului curent | DONE (PG17) | `receipts.schema.ts`, `receipts-api.test.ts` | 2026-10-29 · programmer (F6-C) |
| Scoping pe gospodărie + RLS în fiecare interogare (inclusiv subinterogările corelate, cu coloanele exterioare calificate explicit); izolare A/B pe listă, detaliu, fișier, corectare, confirmare, reprocesare, ștergere | DONE (PG17) | `receipts.service.ts`, `documents.repo.ts`, `receipts-api.test.ts` | 2026-10-29 · programmer (F6-C) |
| Căutarea: `LIKE` cu escape, suma prin `parseAmount` (fără regex pe conținut, fără float) | DONE (PG17) | `receipts.service.ts` (`amountOfQuery`), `receipts-api.test.ts` | 2026-10-29 · programmer (F6-C) |
| Nicio tranzacție fără confirmare explicită; confirmarea blochează bonul (`FOR UPDATE`), `Idempotency-Key`, moneda contului = a bonului, garda 2^53, duplicatul cere `allowDuplicate` | DONE (PG17) | `receipts.service.ts`, `receipts-api.test.ts` | 2026-10-29 · programmer (F6-C) |
| Reprocesarea (apel AI plătit): limită proprie de cereri, consumă limita zilnică (contorul doar crește), refuzată pentru bon salvat / fișier șters / document refuzat | DONE (PG17) | `receipts-handlers.ts`, `receipts.service.ts`, `receipts-api.test.ts` | 2026-10-29 · programmer (F6-C) |
| Erori cu cod fix fără conținut utilizator; SQLSTATE 22021 (NUL/caracter invalid) → 400 fix, fără parametrii interogării | DONE (teste) | `ledger/context.ts`, `context.test.ts`, `ro.ts` | 2026-10-29 · programmer (F6-C) |
| Auditul bonurilor fără sume, produse sau comercianți | DONE (PG17) | `receipts-api.test.ts` | 2026-10-29 · programmer (F6-C) |
| Retenția: `expired_documents` SECURITY DEFINER (doar identificatori, `search_path = pg_catalog`, EXECUTE doar `finet_app`, politică de citire doar pe expirate, fără BETWEEN); ștergerea ca membru sub RLS, fișierul întâi; storage nemontat → nimic marcat; storage în scriere doar în `finet-cleanup` | DONE (PG17, `test-env-examples.sh`) | `0011_document_retention.sql`, `retention.ts`, `retention.test.ts`, `migrate.test.ts`, `docker-compose.yml` | 2026-10-29 · programmer (F6-C) |
| UI: CSP cu nonce neschimbat (previzualizarea prin `data:`, fără `blob:`), fără `style=`/`dangerouslySetInnerHTML`, poze doar prin ruta autentificată, numele fișierelor nefolosite; zero încălcări CSP pe paginile noi | DONE (reguli statice); E2E în CI | `ui-rules.test.ts`, `e2e/receipts.spec.ts` | 2026-10-29 · programmer (F6-C) |
| E2E: fără consimțământ → `awaiting_consent` și zero cereri la serverul AI fals; CI fără furnizor real (`AI_ALLOWED_HOSTS` = loopback) | NOT RUN local (CI) | `e2e/receipts.spec.ts`, `ci.yml` | — |
| Revizuirea `security` a F6-C | TODO | agentul `security` | — |

## 19. Familia: date și servicii (F8-A, 2026-10-29)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Tabele noi (`household_invites`, `transaction_splits`, `settlements`) cu RLS ENABLE + FORCE în aceeași migrație; fără context: 0 rânduri; nimic pentru anon/authenticated/PUBLIC | DONE (PG17) | `0012_family.sql`, `family-rls.test.ts`, `migrate.test.ts` | 2026-10-29 · programmer (F8-A) |
| Drepturi minime pe coloane: `token_hash` necitibil de aplicație, INSERT pe invitații/decontări doar pe coloanele permise (fără `created_at`, `used_*`, anulare), fără DELETE pe invitații/decontări, fără UPDATE pe împărțiri, `household_members` UPDATE doar `role` | DONE (PG17) | `family-rls.test.ts` | 2026-10-29 · programmer (F8-A) |
| CHECK-uri plate (fără BETWEEN) în schema TS, migrație și snapshot; FK compusă `(transaction_id, household_id)` | DONE (test static) | `family.ts`, `0012_family.sql`, `0012_snapshot.json`, `migrate.test.ts` | 2026-10-29 · programmer (F8-A) |
| Funcții SECURITY DEFINER doar cele necesare (`accept_invite`, `check_transfer_group`, `due_recurring_rules`, triggerele plafon/ultimul owner), `search_path = pg_catalog`, REVOKE de la PUBLIC, EXECUTE doar `finet_app`, întorc doar identificatori; politicile `finet_migrator` noi sunt înguste (variabile de tranzacție, gospodăria curentă) | DONE (test static + PG17) | `migrate.test.ts`, `family-rls.test.ts` | 2026-10-29 · programmer (F8-A) |
| Tokenul invitației: 256 biți CSPRNG, stocat doar SHA-256, afișat o singură dată, expirabil (≤ 168 h, CHECK), de unică folosință (consum atomic `FOR UPDATE`; două acceptări concurente → una), revocabil, răspuns uniform (inexistent/expirat/folosit/revocat/malformat), limită de rată la acceptare înaintea verificărilor, 20 de invitații/zi/gospodărie doar crescător | DONE (PG17) | `invites.service.ts`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Ultimul owner (L3): nu pleacă, nu e scos, nu e retrogradat; baza refuză direct; cursa a doi owneri care se retrogradează reciproc → exact unul reușește (advisory lock); transfer explicit | DONE (PG17) | `household_members_guard_owner`, `members.service.ts`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Plafonul de 6 membri pe orice cale de inserare (CLI, invitație), sub lock | DONE (PG17) | `household_members_check_cap`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Vizibilitatea personal/comun impusă în bază și moștenită de tranzacții, transferuri, etichete, recurențe și agregate (dashboard, raport, buget, export CSV); un membru nu citește, nu modifică, nu șterge și nu scrie în contul personal al altuia (inclusiv prin obiective și confirmarea bonurilor) | DONE (PG17) | `0012_family.sql` (`ALTER POLICY`), `family-rls.test.ts`, `accounts.test.ts`, `ledger-rls.test.ts` | 2026-10-29 · programmer (F8-A) |
| Transfer personal → comun nu poate fi rupt de cine vede doar jumătatea comună (verificarea grupului vede ambele rânduri) | DONE (PG17) | `check_transfer_group` (0012), `family-rls.test.ts` | 2026-10-29 · programmer (F8-A) |
| Comutatorul de gospodărie activă: apartenența verificată la FIECARE cerere (`currentHouseholdIdOf` pornește din `household_members`); preferința rămasă după eliminare e ignorată; setarea unei gospodării străine → 404 | DONE (PG17) | `audit.ts`, `members.service.ts`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Împărțiri: suma = total exact (servicii, toate modurile și rotunjirile) ȘI în bază (trigger amânat pe părți și pe sumă/monedă/tip/cont); doar plătitorul (cont personal) scrie; participanți membri; Zod strict (plătitorul nu vine din input); cheltuiala împărțită nu se modifică (sumă/cont/tip) și nu se șterge prin serviciu | DONE (PG17 + unitar) | `split-math.ts`, `splits.service.ts`, `split-math.test.ts`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Solduri în `bigint`, pe monedă, identice pentru toți membrii (2 și 3 membri), decontări parțiale, garda 2^53 la JSON | DONE (PG17 + unitar) | `settlements.service.ts`, `family.schema.ts`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Permisiuni pe roluri testate pe fiecare acțiune; izolare între gospodării pe fiecare serviciu (404 uniform) | DONE (PG17) | `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Erori cu cod fix (constrângerile triggerelor mapate), audit fără tokenuri/sume/note | DONE (PG17) | `ledger/context.ts`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| Documentele/bonurile, obiectivele și numele conturilor personale: vizibile/ocupate în toată gospodăria | ACCEPTED RISK până la o fază următoare | ADR 0016 (1), ROADMAP „Faza 8”, PRIVACY_NOTES | 2026-10-29 · programmer (F8-A) |
| Verificarea operatorului înainte de 0012 (conturi cu `owner_user_id` deja setat) | TODO (operator) | INFRA 4j | — |
| Revizuirea `security` a F8-A | TODO | agentul `security` | — |

### 19.1 Revizuirea de securitate F8-A (2026-10-29): corecții

| Constatare | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| M1 — invitațiile unui owner scos/retrogradat/plecat rămâneau valabile | DONE (PG17): revocare automată în aceeași tranzacție (retrogradare, eliminare, plecare, transfer) + `accept_invite` cere creatorul încă owner (răspuns uniform) | `members.service.ts`, `family.repo.ts`, `0012_family.sql`, `family.test.ts` („M1”) | 2026-10-29 · programmer (F8-A) |
| M2 — decontări: plată „peste datorie”, creditorul nu putea anula, membru ținut captiv de sold | DONE (PG17): `from` doar dacă datorează și cel mult datoria curentă (creditorul nu-și creează creanțe; corecțiile le înregistrează destinatarul), `to` orice sumă, owner străin doar stingere, anulare de oricare parte sau de creator (nu de un owner străin; RLS + serviciu), plecarea/eliminarea nu mai sunt blocate (`unsettledBalance`, `formerMemberIds`) | `settlements.service.ts`, `members.service.ts`, `0012_family.sql`, `family.test.ts` | 2026-10-29 · programmer (F8-A) |
| m1 — ștergerea unei categorii dezvăluia folosirea în conturi personale (și ștergea bugetele personale ale altora) | DONE (PG17): `category_used_elsewhere` (SECURITY DEFINER, boolean) → ascundere în loc de ștergere | `categories.service.ts`, `0012_family.sql`, `family-rls.test.ts` | 2026-10-29 · programmer (F8-A) |
| m2 — ștergerea unei etichete comune șterge legăturile de pe tranzacțiile personale ale altora | ACCEPTED (decizie documentată, fără scurgere) | ADR 0016 (10) | 2026-10-29 · programmer (F8-A) |
| m3 — `audit_events` și `idempotency_keys.response` vizibile întregii gospodării în bază | ACCEPTED RISK / amânat (formularea corectată; restrângerea cere modificarea modulului `idempotency`) | ADR 0016 (10), PRIVACY_NOTES | 2026-10-29 · programmer (F8-A) |
| m4 — DoS al soldurilor peste 2^53 | DONE (PG17): plafon 10^14 pe pereche la împărțire, ștergere de împărțire, decontare, anulare | `split-math.ts` (`PAIR_BALANCE_CAP`), `family.test.ts` („m4”) | 2026-10-29 · programmer (F8-A) |
| m5 — politica proprietarului pe conturile personale prea largă | DONE (PG17): legată de `finet.definer_scope` | `0012_family.sql`, `migrate.test.ts`, `family-rls.test.ts` | 2026-10-29 · programmer (F8-A) |
| m6 — verificarea dinaintea 0012 incompletă | DONE (docs) | INFRA 4j | 2026-10-29 · programmer (F8-A) |


## 20. Familia: API, interfață, actualizări live (F8-B, 2026-10-29)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Tokenul de invitație în clar doar în răspunsul de creare; listarea fără token; crearea refuză `Idempotency-Key` (răspunsul memorat ar conține tokenul) — tokenul nu ajunge în `idempotency_keys` | DONE (PG17) | `family-handlers.ts`, `family-api.test.ts` | 2026-10-29 · programmer (F8-B) |
| Acceptarea: `POST` cu tokenul în corp (nu în URL-ul API-ului); 404 uniform pentru folosit/revocat/greșit/malformat (același corp); 429 + `Retry-After` (limita consumată și la tokenurile greșite); pagina `/join/[token]` nu consumă și nu verifică nimic la deschidere, nu afișează numele gospodăriei, `no-referrer`, `noindex` | DONE (PG17 + E2E scris) | `http.ts` (`errorPayload`), `family-api.test.ts`, `e2e/family.spec.ts` (b) | 2026-10-29 · programmer (F8-B) |
| Permisiuni pe rol prin API (member → 403 la invitații și roluri; ultimul owner → 409); gospodăria din sesiune/bază, niciodată din cerere; comutatorul → 404 pe gospodărie străină | DONE (PG17) | `family-api.test.ts` | 2026-10-29 · programmer (F8-B) |
| SSE: autentificat (sesiune + proxy Access, ruta nu e exclusă din `src/proxy.ts`), scopat pe gospodăria curentă, reverificare sesiune + apartenență la fiecare puls (`close`), închidere imediată la eliminare/plecare/comutare, durată maximă 5 min, plafon 4/utilizator (cea mai veche evacuată) și 200 total (429), curățare la abort, fără conexiune la bază ținută între pulsuri | DONE (PG17) | `family-handlers.ts` (`eventsHandler`), `live-bus.ts`, `family-api.test.ts` | 2026-10-29 · programmer (F8-B) |
| Evenimentul poartă DOAR tip + id; tranzacțiile/transferurile care ating doar conturi personale ajung doar la proprietar (publicul calculat sub RLS-ul actorului, fail closed) | DONE (PG17) | `_lib/live.ts`, `family-api.test.ts` („nici măcar id-ul”) | 2026-10-29 · programmer (F8-B) |
| UI fără `style=`/`dangerouslySetInnerHTML`, CSP cu nonce neschimbat (`connect-src 'self'`), fără float pe sume (procentele în puncte de bază prin parsarea exactă) | DONE (unitar) | `ui-rules.test.ts`, `a11y-rules.test.ts`, `family-ui.test.ts`; E2E (d) CSP — NOT RUN local | 2026-10-29 · programmer (F8-B) |
| Bufferizarea SSE prin tunelul Cloudflare / Traefik pe producție | TODO (operator) | INFRA 4k, pasul 6 | — |
| Tokenul în calea `/join/<token>` poate apărea în jurnalele proxy-urilor | ACCEPTED RISK (unică folosință, ≤ 168 h, revocabil) | ADR 0017, INFRA 4k pasul 8 | 2026-10-29 · programmer (F8-B) |
| Tokenul invitației în `/login?next=/join/<token>` și în emailul magic-link (când SMTP e configurat) | ACCEPTED RISK (unică folosință, expiră ≤ 168 h, cere Access + sesiune, destinatar = invitatul, revocabil); `Referrer-Policy: no-referrer` pe `/join/*` | INFRA 4k pasul 8, `security-headers.ts` (`referrerPolicyFor`), `proxy.test.ts` | 2026-10-29 · programmer (F8-A) |
| Owner care stinge unilateral o datorie și apoi elimină creditorul: acesta nu mai poate anula decontarea | ACCEPTED RISK (încredere de familie, Access); atenuare: dialogul de eliminare arată decontările active ale membrului | ADR 0016 §10, `members-panel.tsx` | 2026-10-29 · programmer (F8-A) |
| Ștergerea categoriei nu depinde de rânduri invizibile (mai mulți membri → mereu ascunsă, răspuns identic) | DONE (PG17) | `categories.service.ts`, `categories.test.ts`, `family-rls.test.ts` | 2026-10-29 · programmer (F8-A) |
| Revizuirea `security` a F8-B | TODO | agentul `security` | — |

## 21. PWA, service worker, IndexedDB (F9-A, 2026-10-29; ADR 0020)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Nicio excepție nouă de la Cloudflare Access: `/sw.js`, `/manifest.webmanifest`, `/icons/*`, `/offline`, `/pwa/*`, `/help`, `/settings/android`, `GET /api/v1/app/android/latest` → 403 fără JWT | DONE (unitar + E2E scris) | `src/proxy.test.ts`, `e2e/access.spec.ts` (NOT RUN local) | 2026-10-29 · programmer (F9-A) |
| Manifestul cerut cu `crossOrigin="use-credentials"` (altfel fără cookie Access) | DONE | `src/app/layout.tsx`, `src/pwa/pwa-files.test.ts`, `e2e/pwa.spec.ts` | 2026-10-29 · programmer (F9-A) |
| Iconițele cerute de browser fără cookie la instalare | ACCEPTED RISK (iconiță generică; fără date); bypass Cloudflare doar pe căi exacte, decizia operatorului | ADR 0020 §1, INFRA 4l | 2026-10-29 · programmer (F9-A) |
| SW: cache DOAR pentru asset-uri statice (`/_next/static/**` în producție, iconițe, manifest, fișierele `/offline`) și `/offline`; niciodată API, non-GET, altă origine, navigări, redirect, non-200, `no-store`/`private`, HTML (în afară de `/offline`) | DONE (unitar, codul servit în `node:vm`) | `src/pwa/sw.test.ts` | 2026-10-29 · programmer (F9-A) |
| SW: pe `/api/**` și metodele non-GET nu apelează `respondWith` (încărcarea multipart și SSE neatinse) | DONE (unitar) | `src/pwa/sw.test.ts` | 2026-10-29 · programmer (F9-A) |
| SW: precache validat înainte de scriere (pagina de login Access nu ajunge în cache); cache versionat cu BUILD_ID, curățarea versiunilor vechi, plafon 400 | DONE (unitar) | `src/pwa/sw.test.ts` | 2026-10-29 · programmer (F9-A) |
| SW: fără `skipWaiting` automat; activare doar la clic, amânată cu formular necomis | DONE (unitar + cod) | `sw.test.ts`, `src/components/app/pwa.tsx` | 2026-10-29 · programmer (F9-A) |
| `/offline`: HTML fix, fără sesiune/cookie, fără script/stil inline, fără `style=`, fără cereri de rețea în scriptul ei; CSP neschimbat | DONE (unitar) | `src/pwa/pwa-files.test.ts` | 2026-10-29 · programmer (F9-A) |
| IndexedDB: pozele doar pe dispozitiv, cu `userId` + `householdId`; încărcate DOAR pentru proprietarul curent (gospodăria activă); intrările altor utilizatori șterse la pornire; TTL 7 zile; baza ștearsă la deconectare | DONE (unitar + E2E scris) | `offline-scans.test.ts`, `app-nav.tsx`, `e2e/pwa.spec.ts` (NOT RUN local) | 2026-10-29 · programmer (F9-A) |
| Proprietarul impus de SERVER: încărcările din coadă trimit `X-FINET-Expected-User`/`-Household`; `POST /api/v1/documents` respinge nepotrivirea cu 409 `owner_mismatch` înainte de citirea corpului și de stocare (antete opționale, impuse când există); clientul nu retrimite (alt cont → șters, altă gospodărie → păstrat) și recitește proprietarul (`GET /api/v1/me`) înaintea fiecărei treceri | DONE (PG17 + unitar) | `documents-handlers.ts` (`assertExpectedOwner`), `documents-api.test.ts`, `offline-scans.test.ts`, `offline-scans-client.ts` | 2026-10-29 · programmer (F9-A, constatarea coordonatorului) |
| Coada: ștergere locală doar după 2xx; erori permanente vizibile; o retrimitere nu creează documente noi (SHA-256; reîncercarea exactă a bonului lung → 200 duplicat) | DONE (unitar + PG17) | `offline-scans.test.ts`, `documents.test.ts` | 2026-10-29 · programmer (F9-A) |
| Plafoane locale (10 intrări, 50 MB, tip JPEG/PNG, `MAX_UPLOAD_MB`), eroarea de cotă fără scrieri parțiale | DONE (unitar) | `offline-scans.test.ts` | 2026-10-29 · programmer (F9-A) |
| `GET /api/v1/app/android/latest`: sesiune obligatorie, fișier validat strict (https, sha256, semver, ≤ 16 KiB), invalid → 404 fără conținut în log | DONE (PG17) | `src/app/api/v1/app-api.test.ts` | 2026-10-29 · programmer (F9-A) |
| Codul QR generat local (fără dependență, fără JS în browser) | DONE (vectori python-qrcode) | `src/lib/qr.test.ts` | 2026-10-29 · programmer (F9-A) |
| Audit axe pe paginile noi | DONE (scris; NOT RUN local) | `e2e/a11y.spec.ts` (proiectul `a11y`, axe-core 4.14.0 injectat cu `page.evaluate`, compatibil cu CSP-ul cu nonce; WCAG 2.1 A/AA, zero `serious`/`critical` pe 2 pagini publice + 16 autentificate, inclusiv `/help`, `/settings`, `/settings/android`, `/settings/privacy`); rulează în CI (ambele moduri) | 2026-10-29 · programmer (F9-B) |
| Revizuirea `security` a F9-A | TODO | agentul `security` | — |

## 22. GDPR, retenție, statistici, upgrade PostgreSQL și auditul Fazei 9 (F9-B, 2026-10-29; ADR 0021)

### 22.1 Controalele noi

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Ștergerea contului cere reautentificarea (parola, sau o sesiune ≤ 15 min fără parolă) și confirmarea scrisă `ȘTERGE` (Zod strict, câmpuri în plus → 400); CSRF ca orice mutație cu cookie; două limite de rată: IP + utilizator (`account_delete`) și DOAR utilizator, 5/oră (`account_delete_user`, revizuirea F9) | DONE (PG17) | `account-deletion.ts`, `gdpr-handlers.ts`; `account-deletion.test.ts` („parola greșită…”, „fără parolă…”), `gdpr-api.test.ts` (400, 403 CSRF; „limită DOAR pe utilizator…”: 3 IP-uri diferite → a 3-a încercare 429) | 2026-10-29 · programmer (F9-B) |
| Ultimul owner cu alți membri → 409 `last_owner`, NIMIC șters (nici gospodăria proprie, nici sesiunile, nici fișierele) | DONE (PG17) | `account-deletion.test.ts` („ultimul owner…”) | 2026-10-29 · programmer (F9-B) |
| Administratorul platformei nu se șterge din aplicație (409 `platform_admin`; garda și în `finet.erase_current_user`, 42501): bootstrap-ul e irepetabil (M5) | DONE (PG17) | `account-deletion.test.ts` („administratorul platformei…”), `gdpr-api.test.ts` | 2026-10-29 · programmer (F9-B) |
| Conturile PERSONALE ale celui șters (inclusiv din gospodăriile părăsite demult) se șterg cu tranzacțiile lor; NU devin comune (`owner_user_id ON DELETE SET NULL` nu mai are pe cine atinge); jumătatea comună a unui transfer personal → comun devine o tranzacție obișnuită, soldul comun e neschimbat | DONE (PG17, PG18) | `0016_gdpr_stats.sql` (`erase_current_user`, pașii 1–3); `account-deletion.test.ts` („gospodăria comună…”: conturile șterse, sold comun identic, owner-ul vede doar contul comun și pe al lui) | 2026-10-29 · programmer (F9-B) |
| Rândul `users`: șters dacă nimic nu-l mai referă; altfel anonimizat („Cont șters”, `deleted-<id>@deleted.invalid`, `disabled`), fără sesiuni, parolă, preferințe, apartenențe, bugete personale | DONE (PG17, PG18) | `account-deletion.test.ts` („singurul membru…” → `deleted`; „gospodăria comună…” → `anonymized`) | 2026-10-29 · programmer (F9-B) |
| Gospodăria cu un singur membru: ștearsă cu tot conținutul; fișierele DOAR ale ei (`isKeyOfHousehold`) șterse după commit; un eșec la fișiere nu readuce datele, se numără în log fără id-uri sau chei; orfanele se curăță cu `finet-admin cleanup-orphan-storage` (dry-run implicit, `--yes`, plafon, legături ignorate, refuz fără storage montat sau când totul pare orfan) | DONE (PG17) | `account-deletion.test.ts` („singurul membru…”, „o eroare la ștergerea fișierelor…”), `cli.test.ts` („cleanup-orphan-storage…”), `finet.existing_households` (doar id-uri) în `migrate.test.ts` | 2026-10-29 · programmer (F9-B) |
| `finet.erase_current_user`: doar utilizatorul din context, refuzat cât e încă membru sau fără context (42501), idempotent (`not_found`) | DONE (PG17) | `account-deletion.test.ts` („finet.erase_current_user…”) | 2026-10-29 · programmer (F9-B) |
| Politicile noi ale proprietarului (`TO finet_migrator`) legate de `finet.definer_scope`, setată/resetată doar în cele 3 funcții; o variabilă setată de `finet_app` nu deschide nimic | DONE (PG17) | `migrate.test.ts` („0016_gdpr_stats: …” verifică fiecare politică), `stats.test.ts` („aplicația nu are niciun drept direct…”) | 2026-10-29 · programmer (F9-B) |
| Exportul: doar ce vede utilizatorul (RLS pe gospodărie: fără conturile personale ale altora), împărțiri/decontări în care e parte, audit doar ca actor, documente doar ale lui; fără parole, tokenuri, chei de storage, hash-uri; arhivă în flux, nume de fișier fix, `no-store`, `nosniff`; cu cookie doar `Sec-Fetch-Site: same-origin|none`; 3/oră; auditat fără conținut | DONE (PG17, PG18; E2E scris) | `data-export.ts`, `gdpr-handlers.ts`; `gdpr-api.test.ts` („exportul…”: conținutul citit cu Python `zipfile`, santinele absente); `e2e/gdpr.spec.ts` (NOT RUN local) | 2026-10-29 · programmer (F9-B) |
| Scriitorul ZIP: nume fără `..`, absolute, `\`, caractere de control; arhiva validă pentru un cititor independent; limitele formatului (4 GiB, 65 535 de intrări) verificate ÎNAINTE de flux (estimare sub RLS) → 413 `export_too_large` cu cod fix (revizuirea F9) | DONE | `src/lib/zip.ts`, `zip.test.ts` (Python `zipfile.testzip`, `unzip -t`); `estimateExport`/`assertExportFits` în `data-export.ts`, `gdpr-api.test.ts` („exportul peste limitele ZIP…”) | 2026-10-29 · programmer (F9-B) |
| Statisticile: doar administratorul activ (403/404 altfel, și pentru un administrator dezactivat); nicio sumă, descriere, comerciant sau email; membrii doar în `personal` | DONE (PG17, PG18; E2E scris) | `stats.test.ts` (santinele: sumă și text într-o tranzacție reală, absente din răspuns), `gdpr-api.test.ts`, `e2e/gdpr.spec.ts` | 2026-10-29 · programmer (F9-B) |
| `app_event_daily`: RLS ENABLE + FORCE, fără niciun drept pentru `finet_app`, fără coloane de utilizator/instalare/gospodărie | DONE (PG17) | `migrate.test.ts`, `stats.test.ts` (SELECT ca `finet_app` → 42501) | 2026-10-29 · programmer (F9-B) |
| Rutele noi (`/settings/privacy`, `/settings/statistics`, `/api/v1/me/export`, `/api/v1/me/deletion`, `/api/v1/me/delete`, `/api/v1/admin/stats`) fără excepție de la Access | DONE (unitar; E2E scris) | `src/proxy.test.ts`, `e2e/access.spec.ts` (NOT RUN local) | 2026-10-29 · programmer (F9-B) |
| Better Auth `deleteUser` neactivat (nicio a doua cale de ștergere, nepăzită) | DONE | `src/modules/auth/auth.ts` (fără `user.deleteUser`) | 2026-10-29 · programmer (F9-B) |
| Upgrade PostgreSQL 17 → 18: restaurarea backup-ului propriu pe versiunea următoare păstrează RLS, politici, funcții, ACL, date | DONE (încercat local, 2 rulări) | `ops/postgres/upgrade-test.sh` (amprenta identică, 1270 de linii), migrațiile „aplicate acum 0”, testele `src/db` + GDPR pe PG18; `.github/workflows/pg-next.yml` (săptămânal) | 2026-10-29 · programmer (F9-B) |
| Backup-urile păstrează datele unui cont șters până la expirarea instantaneelor (7/4/12) | ACCEPTED RISK (de menționat în politica `saas`) | `docs/PRIVACY_NOTES.md` („Export și ștergere GDPR…”) | 2026-10-29 · programmer (F9-B) |
| Revizuirea `security` a F9-B | TODO | agentul `security` | — |

### 22.2 HSTS `preload` — NU se activează (decizia operatorului)

Azi: `Strict-Transport-Security: max-age=31536000; includeSubDomains` (secțiunea 3). Ce ar însemna `preload` (și înscrierea pe hstspreload.org):
- domeniul de bază (de exemplu `levinetit.com`) și **toate** subdomeniile lui, inclusiv cele care nu sunt FINET (alte servicii de pe host, panouri, `*.levinetit.com` din tunel), ar fi accesibile **doar prin HTTPS** în toate browserele, codat în binarul browserului; orice subdomeniu fără certificat valid devine inaccesibil;
- condiția de înscriere cere antetul cu `preload` pe domeniul de bază (nu doar pe `finet.<domeniu>`), `includeSubDomains` și `max-age ≥ 1 an`;
- **retragerea** din listă durează luni (până la noile versiuni ale browserelor); greșeala nu se repară rapid;
- câștigul pentru FINET e mic: aplicația e oricum doar în spatele Cloudflare Access și al tunelului (HTTPS de la primul contact cu Cloudflare), iar HSTS fără `preload` protejează deja după prima vizită.
Concluzie: rămâne fără `preload`; dacă operatorul îl vrea, întâi inventarul tuturor subdomeniilor, apoi antetul pe domeniul de bază, apoi înscrierea.

### 22.3 Parcurgerea listei (secțiunile 1–21), 2026-10-29

Fiecare rând din secțiunile 1–21 are o dovadă (fișier, test sau comandă) în coloana „Dovadă”, ori e marcat explicit TODO/PARTIAL cu responsabilul. În F9-B au fost **re-rulate** (PASS): pe PostgreSQL 17 — `src/db/migrate.test.ts`, `src/app/api/v1/idempotency.test.ts`, `me.test.ts`, `documents-api.test.ts`, `src/modules/documents/documents.test.ts`, `src/proxy.test.ts`, `src/app/{ui-rules,a11y-rules,contrast,smoke}.test.ts`, `src/openapi`, `src/tools/admin/cli.test.ts`, plus testele noi F9-B; pe PostgreSQL 18 — `src/db/{migrate,rls,grants,family-rls,ledger-rls,planning-rls,household-limit}.test.ts`, `src/modules/family/family.test.ts`, `transactions`, `transfers` și testele F9-B. Restul dovezilor sunt cele din fazele lor (neschimbate de F9-B) și din CI.

| Secțiune | Rânduri | Deschise (TODO / PARTIAL / risc acceptat) | Cine le închide |
|---|---|---|---|
| 1. Autentificare | 15 | 2: înregistrarea `saas` (Faza 11); E2E `auth` în browser (CI) | Faza 11; CI |
| 2. Autorizare și RLS | 21 | 4: migrațiile pe Supabase; revizuirile `security` F2-A/F2-B | operatorul; `security` |
| 3. Antete | 10 | 1: fără încălcări CSP în browser (E2E, CI) | CI |
| 4. Secrete | 7 | 1: gitleaks în CI | fază viitoare |
| 5. Încărcări | 5 | 2: limite ZIP (import, Faza 7); cron-ul `cleanup-documents` | Faza 7; operatorul |
| 6. Loguri | 9 | 1: loguri structurate (pino) | fază viitoare |
| 7. CI | 6 | 3: `pnpm audit` blocant; acțiuni fixate pe SHA; E2E în CI | fază viitoare; CI |
| 8. Infrastructură | 11 | 5: arhiva `/home/docker`; Data API pe proiectul real; N4; N5; N2 | operatorul; fază viitoare |
| 9. Revizuirea Fazei 1 | 15 | 3: L6, L7, L8 (L2, L3 și ștergerea contului: închise în F9-B) | actualizarea Better Auth; operatorul; clientul Android |
| 10. Registrul (UI) | 16 | 2: LOW-3 (text în URL, acceptat); LOW-4 plafoane per gospodărie (LOW-2 închis în F9-B) | fază viitoare |
| 11. Planificare (F3-A) | 19 | 4: revizuirile `security` F3-A/F3-B; 2^53 pe totaluri (rezidual); `0004` pe Supabase | `security`; operatorul |
| 12. Planificare (UI) | 13 | 6: verificări în browser / build în CI; text în URL (acceptat); revizuirea `security` F3-C | CI; `security` |
| 13. Backup | 17 | 5: rol `finet_backup` pe Supabase; SFTP (dacă e ales); Drive fără Object Lock (acceptat); parola restic în afara serverului; primul backup real | operatorul |
| 14. Stabilizare | 8 | 4: verificări în browser; `0005` pe Supabase; revizuirea `security` | CI; operatorul; `security` |
| 15. Recurențe și worker | 27 | 8: riscuri reziduale acceptate (rol comun web/worker, semnalul de viață), verificări pe producție, revizuirea F5-B | `security`; operatorul |
| 16. Documente (F6-A) | 19 | 3: fără antivirus (acceptat); cron-ul retenției; revizuirea `security` | operatorul; `security` |
| 17. Pipeline AI (F6-B) | 21 | 3: `json_schema` la primul deploy; jurnalele LiteLLM; revizuirea `security` | operatorul; `security` |
| 18. Bonuri (F6-C) | 14 | 2: E2E cu serverul AI fals (CI); revizuirea `security` | CI; `security` |
| 19. Familia (F8-A) | 25 | 5: vizibilitatea documentelor/obiectivelor (amânat); pre-check 0012; m2, m3 (acceptate); revizuirea `security` | fază viitoare; operatorul; `security` |
| 20. Familia (F8-B) | 12 | 5: SSE prin tunel; tokenul în URL/email (acceptat); datoria stinsă de owner (acceptat); revizuirea `security` | operatorul; `security` |
| 21. PWA (F9-A) | 16 | 2: iconițele fără cookie Access (acceptat); revizuirea `security` (auditul axe: închis în F9-B) | operatorul; `security` |
| 22. F9-B | 17 | 2: backup-urile cu date șterse (acceptat); revizuirea `security` | `security` |

### 22.4 Rămase deschise după Faza 9 (lista consolidată)

- **Operatorul (producție):** migrațiile `0013`–`0016` pe Supabase (cu Faza 7) și verificările lor; deploy-urile F9 (INFRA 4l, 4m); cron-urile `cleanup-idempotency`, `finet-cleanup`, `aggregate-events`; primul backup real și restaurarea de probă; parola restic în afara serverului; Data API oprit (test pe proiectul real), N4; arhiva necriptată `/home/docker`; SSE prin tunel; jurnalele LiteLLM fără corpuri; `json_schema` la primul deploy; HSTS `preload` (22.2).
- **CI (prima rulare a branch-ului):** E2E în ambele moduri (`auth`, `ledger`, `planning`, `regressions`, `recurring`, `receipts`, `family`, `pwa`, `gdpr`, `a11y`, `access`), `check:bundle`, `pg-next` (manual o dată).
- **Revizuirile `security` independente:** F2-A, F2-B, F3-A, F3-B, F3-C, Faza 4, F5-B, F6-A, F6-B, F6-C, F8-A, F8-B, F9-A, F9-B.
- **Faze viitoare:** gitleaks, acțiuni GitHub pe SHA și `pnpm audit` blocant, loguri structurate, plafoane per gospodărie (LOW-4), L6/L7/L8, vizibilitatea per membru a documentelor și obiectivelor, eșecurile de autentificare agregate în „Statistici”, Lighthouse ≥ 90 rulat pe producție.
- **Riscuri acceptate (documentate):** fără antivirus; text liber în URL (LOW-3); iconițele PWA fără cookie Access; tokenul invitației în URL/email; datoria stinsă unilateral de owner; Drive fără Object Lock; datele unui cont șters în backup-uri până la expirarea instantaneelor. (Fișierele orfane la o ștergere eșuată: comanda `cleanup-orphan-storage`, revizuirea F9.)

## 23. Extrase bancare: date, extracție, parsere, servicii (F7-A, 2026-10-29)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Tabele noi (`statement_imports`, `statement_lines`, `statement_usage_daily`) cu RLS ENABLE + FORCE, politici pe comandă; fără context: 0 rânduri; nimic pentru anon/authenticated/PUBLIC | DONE (PG17) | `0013_statements.sql`, `statements-rls.test.ts`, `migrate.test.ts` | 2026-10-29 · programmer (F7-A) |
| Vizibilitatea contului personal (0012) moștenită: importul și rândurile unui cont personal doar ale proprietarului (citire, scriere, confirmare, anulare, acoperire) | DONE (PG17) | `statements-rls.test.ts`, `statements.test.ts` | 2026-10-29 · programmer (F7-A) |
| Legătura rând → tranzacție: doar o tranzacție din același cont și vizibilă (trigger INVOKER), pusă o dată la import, golită doar de ștergerea tranzacției; rânduri inserate doar în previzualizări, cu stări inițiale; ștergerea rândurilor doar pentru previzualizări; tranzițiile de stare ale importului și rândurilor verificate în bază (revizuirea automată F7-A, 2 runde) | DONE (PG17) | `statements-rls.test.ts` | 2026-10-29 · programmer (F7-A) |
| Drepturi minime: UPDATE doar pe coloanele de stare/contoare/anulare, respectiv `state`/`transaction_id`; contorul zilnic fără DELETE (doar crește); `created_by_user_id` = utilizatorul curent | DONE (PG17) | `statements-rls.test.ts` | 2026-10-29 · programmer (F7-A) |
| CHECK-uri și politici PLATE (min/max separate, fără BETWEEN, fără OR imbricat); politici, constrângeri, indecși, triggere, funcții și ACL-uri 0013 identice după pg_dump → restore pe PG17 | DONE (static + verificare manuală PG17) | `migrate.test.ts`; raportul F7-A | 2026-10-29 · programmer (F7-A) |
| PDF: tip după conținut; extracție în proces copil (`prlimit` AS/CPU/fsize/nofile/core, SIGKILL la termen, mediu minim), ieșire plafonată și validată, text curățat; plafoane pagini/elemente/octeți; copil lipsă → refuz | DONE (unitar, proces real) | `pdf-items-sandbox.ts`, `pdf-items-sandbox.test.ts` | 2026-10-29 · programmer (F7-A) |
| ZIP malițios: bombă (mărime/raport), traversare de cale, absolut, `\`, `:`, duplicate, criptat, legătură simbolică, imbricat (inclusiv XLSX în ZIP), suprapus, CRC, ZIP64, prea multe intrări | DONE (unitar) | `zip.ts`, `files.test.ts` | 2026-10-29 · programmer (F7-A) |
| XLSX: fără DOCTYPE/ENTITY (XXE, billion laughs), fără macro/ActiveX/obiecte/legături externe, formule neevaluate, scanner liniar (fără regex cu backtracking pe XML), plafoane în timpul parcurgerii, 8 MB/parte; intrări adversariale terminate rapid (revizuirea automată F7-A) | DONE (unitar) | `xlsx.ts`, `files.test.ts` | 2026-10-29 · programmer (F7-A) |
| CSV: plafoane (octeți, rânduri, coloane, celulă), binar refuzat; celulele `=+-@` importate ca text și neutralizate la export (prefix `'`) | DONE (unitar + PG17) | `csv.ts`, `files.test.ts`, `statements.test.ts` | 2026-10-29 · programmer (F7-A) |
| Sume doar `bigint` din formate explicite per bancă (regex strict → `parseAmount`), fără euristici „1.004”; zecimale/mii explicite la maparea CSV; plafon 1e13; date reale validate | DONE (unitar) | `text.ts`, `mapping.ts`, `parsers.test.ts`, `files.test.ts` | 2026-10-29 · programmer (F7-A) |
| Soldurile verificate în cod (final, pe zi, pe rând, totaluri, continuitate); nepotrivire → `mismatch`, confirmarea cere recunoaștere explicită | DONE (unitar + PG17) | `balances.ts`, `statements.test.ts` | 2026-10-29 · programmer (F7-A) |
| Deduplicare deterministă și idempotentă (fișier, rând, ID Revolut, schimb valutar), importuri concurente serializate pe cont, confirmare idempotentă, anulare care nu atinge tranzacțiile editate fără decizie | DONE (PG17) | `dedup.ts`, `statements.service.ts`, `statements.test.ts` | 2026-10-29 · programmer (F7-A) |
| Erori cu cod fix (fără conținut din fișier), audit fără sume/descrieri/IBAN; cota zilnică doar crescătoare | DONE (PG17) | `types.ts`, `statements.service.ts`, `statements.test.ts` | 2026-10-29 · programmer (F7-A) |
| Confidențialitate: extrasele reale ale operatorului nu intră în repo/teste/docs/CI; fixture-uri sintetice; verificarea de scurgeri rulată local înaintea fiecărui commit | DONE (local) | `scripts/make-statement-fixtures.mjs`; raportul F7-A | 2026-10-29 · programmer (F7-A) |
| PDF-urile băncilor fără parser prin AI local/extern (`external_ai_statements`) | TODO (amânat, refuz clar azi) | ADR 0018 §10, ROADMAP | — |
| Revizuirea `security` a F7-A | TODO | agentul `security` | — |

## 24. Extrase bancare: API, worker, interfață, potrivire, recurențe (F7-B, 2026-10-29)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Revizuirea F7-A aplicată: cheia `fx` doar printre schimburi; marcajele de secțiune ignorate pe rândurile de continuare (toate cele 4 bănci, teste adversariale); perioada citită o dată; chei duplicate în același fișier marcate la previzualizare; anularea verifică tot grupul unui transfer și refuză explicit piciorul invizibil; contorul zilnic nu scade (trigger); IBAN-uri tăiate/litere mici eliminate; niciun IBAN valid (mod-97) în fixture-uri | DONE (unitar + PG17) | `parsers.test.ts`, `coverage-dedup.test.ts`, `statements.test.ts`, `statement-uploads-rls.test.ts` | 2026-10-29 · programmer (F7-B) |
| `statement_uploads`, `receipt_match_rejections`, `recurring_suggestion_dismissals`: RLS ENABLE+FORCE, politici pe comandă, vizibilitatea contului personal; tranzițiile încărcărilor în trigger; legătura spre previzualizare pe același cont (cheie compusă); ștergerea rândului doar după fișier; fără UPDATE pe respingeri | DONE (PG17) | `0014_statement_uploads.sql`, `statement-uploads-rls.test.ts`, `migrate.test.ts` | 2026-10-29 · programmer (F7-B) |
| Funcțiile SECURITY DEFINER (coada, curățarea, golirea cheii, previzualizările vechi): `search_path = pg_catalog`, REVOKE public, doar identificatori; politicile proprietarului doar pe rândurile în lucru / de curățat | DONE (PG17) | `statement-uploads-rls.test.ts` | 2026-10-29 · programmer (F7-B) |
| pg_dump → restore pe PG17: politicile, constrângerile, funcțiile, triggerele și indecșii identici după 0014 | DONE (verificare manuală PG17) | raportul F7-B | 2026-10-29 · programmer (F7-B) |
| Încărcarea: contul verificat (RLS) înaintea oricărei citiri; cota consumată înainte de parsare; un singur fișier ≤ 20 MB, câmpuri strict permise, tip după conținut; ruta exactă exclusă din proxy cu aceeași verificare Cloudflare Access pe calea fixă (toate metodele, inclusiv OPTIONS); limită proprie de cereri; numele fișierului nu se trimite | DONE (PG17 + unitar) | `statements-handlers.ts`, `multipart.ts`, `statements-api.test.ts`, `proxy.test.ts` | 2026-10-29 · programmer (F7-B) |
| PDF doar în worker, un copil odată (concurență 1), încercări plafonate (3), fișier citit plafonat la mărimea înregistrată, doar id-uri în `pgboss.job`, coduri fixe; fișierul șters la confirmare/renunțare/expirare (24 h) | DONE (PG17, copil real) | `statement-jobs.ts`, `uploads.test.ts`, `cleanup.ts` | 2026-10-29 · programmer (F7-B) |
| API: autorizare pe fiecare endpoint (sesiune, CSRF pe cookie), IDOR pe `{id}` = 404 uniform (altă gospodărie, cont personal), `Idempotency-Key` la confirmare și la acceptarea propunerii, contract OpenAPI verificat pe fiecare răspuns | DONE (PG17) | `statements-api.test.ts` | 2026-10-29 · programmer (F7-B) |
| Potrivirea: candidat doar sub RLS (re-citit la decizie), trigger INVOKER + index unic pe `receipts.transaction_id`, respingeri vizibile doar cu tranzacția, fără tranzacție nouă la confirmare | DONE (PG17) | `matching.test.ts`, `statement-uploads-rls.test.ts` | 2026-10-29 · programmer (F7-B) |
| Propunerile: istoric doar vizibil, recalculate pe server la acceptare (clientul trimite doar amprenta), respingerea memorează doar amprenta | DONE (PG17 + unitar) | `suggestions.test.ts`, `matching.test.ts` | 2026-10-29 · programmer (F7-B) |
| E2E (extrase sintetice: import, duplicat, anulare, acoperire, fișier invalid/ZIP, izolare gospodărie/membru, propunere, potrivire) | NOT RUN local (CI) | `e2e/statements.spec.ts` | — |
| Revizuirea `security` a F7-B | TODO | agentul `security` | — |


## 25. Liste de cumpărături și comparația cu bonul (F10-A, 2026-10-30; ADR 0022)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| RLS ENABLE + FORCE pe `shopping_lists`, `shopping_list_items`, `shopping_list_ai_requests`; drepturi minime pe coloane pentru `finet_app`; nimic pentru PUBLIC/anon/authenticated | DONE (PG17) | `shopping-rls.test.ts` („RLS ENABLE + FORCE; drepturi minime…”) | 2026-10-30 · programmer (F10-A) |
| Lista comună: toți membrii; PERSONALĂ: doar proprietarul (citire, scriere, ștergere); altă gospodărie: nimic; nici id-ul nu scapă (404 uniform) | DONE (PG17) | `shopping-rls.test.ts` („lista comună…”), `shopping.test.ts` („lista personală e invizibilă…”), `shopping-api.test.ts` | 2026-10-30 · programmer (F10-A) |
| Chei străine compuse cu gospodăria (articol → listă, articol → linie de bon); o linie de bon propusă/confirmată pentru cel mult UN articol al listei | DONE (PG17) | `shopping-rls.test.ts` („cheia compusă…”, „o linie de bon e propusă…”) | 2026-10-30 · programmer (F10-A) |
| CHECK-uri și plafoane (nume, cantitate `numeric(9,3)`, unitate, notă, poziție, scor; 100 de liste, 300 de articole) pe baza de date și în Zod strict | DONE (PG17) | `shopping-rls.test.ts` („CHECK-uri…”), `shopping.test.ts` („plafoanele…”) | 2026-10-30 · programmer (F10-A) |
| Coada AI: doar pentru liste vizibile, în numele celui care cere; funcțiile SECURITY DEFINER (`queued_list_matches`, `queued_list_match`, `erase_user_shopping_lists`) cu `search_path = pg_catalog`, doar identificatori | DONE (PG17) | `shopping-rls.test.ts` („coada AI: doar pentru liste vizibile…”) | 2026-10-30 · programmer (F10-A) |
| Reîncercarea unui al doilea membru nu dă eroare de politică: cererea activă a altuia rămâne neatinsă, cea terminată e preluată (testul pică fără garda `setWhere` din `upsertAiRequest`) | DONE (PG17) | `shopping-rls.test.ts` („coada AI: al doilea membru…”) | 2026-10-30 · programmer (F10-A) |
| Pasul LLM: oprit implicit (`AI_LIST_MATCH=0`); cere consimțământul `external_ai` (la coadă, la revendicare, la fiecare încercare); buget AI rezervat înainte de încercare; pleacă doar nume normalizate; ieșire constrânsă la id-urile candidate (Zod); nimic din conținut în `pgboss.job`, loguri, erori | DONE (PG17, server AI fals) | `list-match-job.test.ts`, `ai-match.test.ts`, `shopping.test.ts` („pasul AI…”) | 2026-10-30 · programmer (F10-A) |
| Comparația nu modifică tranzacții sau bonuri; deciziile utilizatorului (confirmat/respins) nu se rescriu la reluare sau de AI; bon neconfirmat → 409; bon/listă străine → 404 | DONE (PG17) | `shopping.test.ts` („comparația listă ↔ bon…”) | 2026-10-30 · programmer (F10-A) |
| Ștergerea contului șterge listele PERSONALE din toate gospodăriile | DONE (PG17) | `shopping-rls.test.ts` („ștergerea contului…”), `account-deletion.test.ts` | 2026-10-30 · programmer (F10-A) |
| Exportul GDPR (`/me/export`) include listele și articolele vizibile utilizatorului (sub RLS) | IMPLEMENTAT, fără test dedicat | `src/modules/gdpr/data-export.ts` | — |
| API: 401 fără sesiune pe toate rutele, `Idempotency-Key` la creare (replay, reutilizare cu alt corp), validare strictă, limită de rată pe comparație și sugestii, evenimente live doar tip + id (lista personală doar la proprietar), contract OpenAPI la zi (`openapi --check`) | DONE (PG17) | `shopping-api.test.ts`, `node scripts/openapi.mjs --check` | 2026-10-30 · programmer (F10-A) |
| CSRF pe mutațiile cu cookie ale listelor | NEVERIFICAT în teste dedicate (mecanismul comun al `/api/v1`) | — | — |
| E2E (creare listă din interfață, bifare la raft cu persistență, izolarea listei personale între gospodării, comparație cu un bon sintetic confirmat, zero încălcări CSP); actualizarea live între doi membri e acoperită doar de testul de integrare `shopping-api.test.ts` | SCRIS, NOT RUN local (CI) | `e2e/shopping.spec.ts` | — |
| Axe pe paginile `/shopping-lists` | NEFĂCUT (nu e în `e2e/a11y.spec.ts`) | — | — |
| Revizuirea `security` a F10-A | TODO | agentul `security` | — |

## 26. Prețuri, inflație, rapoarte de micro-cheltuieli (F10-B, 2026-10-30; ADR 0023)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| `report_definitions`: RLS ENABLE + FORCE; PUBLIC/anon fără drepturi; UPDATE doar pe coloanele permise; câmpurile fixe nu se schimbă (42501) | DONE (PG17) | `report-definitions-rls.test.ts` („RLS ENABLE + FORCE…”, „câmpurile fixe…”) | 2026-10-30 · programmer (F10-B) |
| Rapoartele de sistem: citibile de orice utilizator autentificat, invizibile fără utilizator, nescriibile; cele ale gospodăriei izolate, scrierea cere gospodăria curentă și autorul = utilizatorul | DONE (PG17) | `report-definitions-rls.test.ts` („sistem: citibil…”, „rândurile gospodăriei: izolate…”), `report-definitions.test.ts` („citibile de toți membrii…”) | 2026-10-30 · programmer (F10-B) |
| CHECK-uri plate pe forma regulilor, mărime, nume; plafon de 100 de rapoarte proprii (`report_limit`); numele unic fără diferență de litere | DONE (PG17) | `report-definitions-rls.test.ts` („CHECK-uri…”, „nume unic…”), `report-definitions.test.ts` | 2026-10-30 · programmer (F10-B) |
| Conturile personale: agregatele (prețuri, inflație, rulare, previzualizare, export) exclud liniile bonurilor legate de contul personal al altui membru; filtrul este `EXISTS` pe tranzacție sub RLS, nu `LEFT JOIN … IS NULL`; bonurile neconfirmate nu intră | DONE (PG17) | `report-definitions.test.ts` („pungi: totalul exclude…”, „acoperirea proiecției…”), `prices-api.test.ts` („rulare: pungi — conturile personale…”) | 2026-10-30 · programmer (F10-B) |
| Regulile se evaluează în cod (funcții pure), niciodată ca SQL/LIKE/regex construit din date de utilizator; Zod strict, limite de reguli, lungimi și linii citite (409 `too_many_lines`) | DONE (unitar + PG17) | `rules.ts`, `report-definitions.test.ts` („validare strictă…”), `prices-api.test.ts` | 2026-10-30 · programmer (F10-B) |
| API: 401 pe fiecare endpoint nou, parametri strict validați, 404 uniform, `Idempotency-Key` la creare, rate limit pe rulare/previzualizare (429 + `Retry-After`) și export | DONE (PG17) | `prices-api.test.ts` („fără sesiune…”, „definiții…”, „rate limit…”) | 2026-10-30 · programmer (F10-B) |
| Export CSV: BOM, escape, protecție contra formulelor, garda `Sec-Fetch-Site`, izolare; auditat fără conținut | DONE (PG17) | `prices-api.test.ts` („export CSV…”), `report-definitions.test.ts` („export CSV…”) | 2026-10-30 · programmer (F10-B) |
| Sume pe `bigint` (fără float); medie ponderată; conversii doar între unități compatibile; monede separate; inflația cu exemplu numeric (421 pb) | DONE (unitar) | `units.test.ts`, `inflation.test.ts`, `prices.test.ts` | 2026-10-30 · programmer (F10-B) |
| Rapoartele de sistem din bază = constanta din cod (șase rapoarte) | DONE (PG17) | `report-definitions.test.ts` („rândurile din bază sunt identice cu constanta din cod”) | 2026-10-30 · programmer (F10-B) |
| pg_dump → restore: politicile, constrângerile și triggerele identice după 0018 | DONE (PG17, test de amprentă) | `migrate.test.ts` | 2026-10-30 · programmer (F10-B) |
| Exportul GDPR include rapoartele create de utilizator (nu cele de sistem) | DONE (PG17) | `gdpr-api.test.ts`, `data-export.ts` | 2026-10-30 · programmer (F10-B) |
| Performanță pe ~50.000 de linii | MĂSURAT, NU sub o secundă: 0,1–6,7 s (mediana) pe PG17 cu 256 MB; de reluat pe Supabase | `perf-prices.test.ts` (`FINET_PERF=1`), INFRA 4p | 2026-10-29 · programmer (F10-B) |
| E2E (raport predefinit pe bonuri sintetice confirmate, raport propriu, export CSV, „date insuficiente”, izolare) și axe pe `/insights` | NOT RUN local (CI) | `e2e/insights.spec.ts`, `e2e/a11y.spec.ts` | — |
| Revizuirea `security` a F10-B | TODO | agentul `security` | — |

## 27. Exporturi Excel/PDF și export pentru contabil (F10-C, partea 1, 2026-10-30; ADR 0024)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Aceleași reguli ca CSV-ul din Faza 3: sesiune (401), `Sec-Fetch-Site` pentru cookie (403 cross-site/same-site), limită proprie de cereri (429), nume de fișier fix, `no-store`, `nosniff` | DONE (PG17) | `exports-tables-api.test.ts`, `exports-accounting-api.test.ts` | 2026-10-30 · agent |
| Izolare: altă gospodărie nu primește nimic al altuia; un membru nu vede bonurile din contul PERSONAL al altuia (agregat, Excel, CSV, PDF) | DONE (PG17) | `exports-accounting-api.test.ts` (vizibilitate), `exports-tables-api.test.ts` (izolare) | 2026-10-30 · agent |
| Doar bonuri CONFIRMATE (`saved`) cu dată; cele `needs_review` și din alte perioade nu apar | DONE (PG17) | `exports-accounting-api.test.ts` | 2026-10-30 · agent |
| Perioada obligatorie, ordonată, ≤ 1.100 de zile; parametri necunoscuți → 400; dialect CSV necunoscut → 400 (constatare de revizuire automată, MEDIUM; plus defensă în `csvRow`) | DONE | `exports-accounting-api.test.ts`, `csv.test.ts` | 2026-10-30 · agent |
| Plafoane: CSV 50.000, Excel 20.000, PDF 3.000 de rânduri; peste → 409 `export_too_large` fără conținut parțial | DONE | `exports-tables-api.test.ts`; consum măsurat (INFRA 4q): Excel 20.000 ≈ 133 MB RSS | 2026-10-30 · agent |
| Excel: textul liber nu devine formulă (celule `inlineStr`, fără `<f>`); caractere XML interzise eliminate; numele foii curățat; fișier valid pentru un cititor independent | DONE | `xlsx.test.ts` (inclusiv `python3 zipfile`+`ElementTree`); verificat manual cu `openpyxl` | 2026-10-30 · agent |
| PDF: nu execută nimic (fără JavaScript, fără acțiuni, fără fonturi/imagini încorporate din date); textul din date intră doar ca șiruri hexazecimale | DONE | `pdf.ts` (revizuire de cod), `pdf.test.ts` | 2026-10-30 · agent |
| Sume exacte (`bigint` → text zecimal, fără float); TVA pe grup de cotă, rotunjit o dată; liniile fără cotă nu se estimează; diferențele sunt coloane de control | DONE | `accounting.test.ts` | 2026-10-30 · agent |
| Audit `export.downloaded`: doar `kind`, `rows` și (Excel/PDF) `format`, fără conținut | DONE (PG17) | testele de audit din ambele fișiere | 2026-10-30 · agent |
| Randarea PDF în cititoare reale (Acrobat, Chrome, Preview) | NEVERIFICAT (doar `pdf.js` și poppler cu font de înlocuire) | — | — |
| Deschiderea în Excel/LibreOffice desktop | NEVERIFICAT (doar `openpyxl`) | — | — |
| Revizuirea `security` a F10-C | TODO | agentul `security` | — |

## 28. „Întreabă FINET” și rezumatul lunii (F10-C, partea 2, 2026-10-30; ADR 0025)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Set închis de interogări: Zod strict, valori libere doar `categoryId` (uuid din categoriile vizibile) și `merchant` (comparat exact, parametru legat); text ostil din întrebare nu ajunge în SQL | DONE | `parse.test.ts` (text ostil), `ask-api.test.ts` | 2026-10-30 · agent |
| Interogarea e validată a doua oară în executor; clasamentele nu acceptă filtre | DONE | `ask.service.ts`, `query.ts`, `parse.test.ts` | 2026-10-30 · agent |
| 401 fără sesiune; corp invalid/câmp necunoscut/întrebare prea lungă sau scurtă → 400; `householdId` din corp respins | DONE (PG17) | `ask-api.test.ts` | 2026-10-30 · agent |
| Rate limit propriu (429 la depășire) | DONE (PG17) | `ask-api.test.ts` | 2026-10-30 · agent |
| Vizibilitate: conturile personale ale altor membri nu intră în cifre, clasamente sau rezumat; altă gospodărie nu vede nimic | DONE (PG17) | `ask-api.test.ts` (inclusiv rezumatul) | 2026-10-30 · agent |
| Textul întrebării nu se păstrează (nicio tabelă din schema `finet`, audit, chei de limită) | DONE (PG17) | `ask-api.test.ts` (marcaj unic căutat în toate tabelele) | 2026-10-30 · agent |
| Textul întrebării nu apare în loguri și mesaje de eroare | NEVERIFICAT automat (nu există logare a corpului în handler; verificare manuală la deploy, INFRA 4r) | `ask-handlers.ts` | — |
| Fără AI și fără trafic în afara aplicației | DONE (cod: niciun apel de rețea în `ask`/`summary`) | ADR 0025 §1–2 | 2026-10-30 · agent |
| Rezumatul: fiecare cifră din text vine din raport (șabloane), variația pe `bigint`; eticheta fixă | DONE | `summary.test.ts`, `ask-api.test.ts` | 2026-10-30 · agent |
| CSRF: `POST /ask` nu modifică nimic (citire) și nu are efecte secundare; protecția cookie cross-site = cea comună a `/api/v1` pentru `POST` | NEVERIFICAT în teste dedicate | mecanismul comun | — |
| Performanța agregatelor pe volume mari | NEMĂSURAT (interogări agregate pe fereastra cerută; aceleași ca la rapoarte) | — | — |
| Revizuirea `security` a F10-C partea 2 | TODO | agentul `security` | — |

## 29. „Întreabă FINET”: pasul cu LLM din serverul web (F10-C, 2026-10-31; ADR 0026)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Modelul se apelează doar când parserul din cod nu înțelege, doar cu consimțământul SEPARAT `external_ai_ask`, înainte de fiecare încercare; fără acord → zero cereri | DONE (PG17) | `ask-llm-api.test.ts` | 2026-10-31 · agent |
| Ce pleacă: doar întrebarea, data și numele categoriilor; fără sume, comercianți, id-uri, emailuri | DONE (PG17) | `ask-llm-api.test.ts` („ce pleacă”), `ask-llm.test.ts` | 2026-10-31 · agent |
| Cheie dedicată: doar `AI_ASK_API_KEY_FILE`, doar rolul web, doar cu `AI_ASK=1`; cheia workerului interzisă pe web; `AI_ASK=1` fără URL/cheie → eroare la pornire; cheia în clar refuzată | DONE | `config.test.ts` | 2026-10-31 · agent |
| Ieșirea modelului: Zod strict, perioadă ca specificație (modelul nu scrie date), nume potrivite în cod, nume necunoscut → refuz, câmpuri în plus/metrici inventate → `failed_validation` | DONE (PG17) | `ask-llm.test.ts`, `ask-llm-api.test.ts` | 2026-10-31 · agent |
| Buget rezervat înainte de fiecare încercare; buget epuizat → nimic nu pleacă | DONE (PG17) | `ask-llm-api.test.ts` | 2026-10-31 · agent |
| `ai_calls`: rând `ask_finet` fără conținut; întrebarea nu rămâne în nicio tabelă a schemei `finet` | DONE (PG17) | `ask-llm-api.test.ts` (marcaj unic în toate tabelele) | 2026-10-31 · agent |
| Erori ale furnizorului (5xx, timeout): răspuns curat, fără cheie sau detalii în răspuns | DONE (PG17: 5xx); timeout NEVERIFICAT end-to-end | `ask-llm-api.test.ts` | 2026-10-31 · agent |
| Migrația `0019` (două CHECK înlocuite, nimic altceva) și amprenta pg_dump → restore | DONE (PG17) | `migrate.test.ts` | 2026-10-31 · agent |
| Secretul se montează doar prin `docker-compose.ask.yml` (deploy-urile fără pas LLM nu se schimbă) | DONE (config); aplicarea pe gazdă: NEFĂCUTĂ | `ops/docker/docker-compose.ask.yml`, `test-env-examples.sh` | 2026-10-31 · agent |
| Accesul rețea web → LiteLLM (firewall, rețea Docker) și cheia virtuală dedicată cu plafon | NEFĂCUT (pas de operator, INFRA 4s) | — | — |
| Revizuirea `security` a pasului LLM | TODO | agentul `security` | — |

## 30. Site-ul public `saas` (Faza 11-A, 2026-10-31; ADR 0027)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Rutele publice (`/pricing`, `/terms`, `/privacy`) dau 404 în `personal`; `/` duce la `/login` ca înainte | DONE (cod); E2E în CI | `e2e/site.spec.ts`, `src/lib/site.ts` | 2026-10-31 · agent |
| CSP strict (`'self'`) pe toată aplicația; domeniile Google doar pe cele patru pagini publice și doar cu `SITE_ANALYTICS_ID` | DONE | `consent.test.ts` (CSP), `src/proxy.ts` | 2026-10-31 · agent |
| Analytics: semnalele Consent Mode v2 implicit `denied`; `gtag.js` se încarcă doar după „Accept”; reclamele mereu `denied`; fără ID nu există banner și nu pleacă cereri către Google | DONE (unit + E2E fără ID); cu ID și Google real: NEVERIFICAT | `consent.test.ts`, `e2e/site.spec.ts` | 2026-10-31 · agent |
| Datele firmei fără valori implicite, validate la pornire; lipsa lor e vizibilă în subsol și blochează indexarea | DONE | `config.test.ts` | 2026-10-31 · agent |
| Textele juridice sunt ciorne marcate vizibil; indexarea doar cu `SITE_LEGAL_REVIEWED=1` și datele complete | DONE (mecanism); revizuirea juridică: NEFĂCUTĂ (om) | `e2e/site.spec.ts`, ADR 0027 §2 | — |
| Legături ANPC SAL și SOL pe fiecare pagină publică | DONE | `e2e/site.spec.ts` | 2026-10-31 · agent |
| Revizuirea `security` a Fazei 11-A | TODO | agentul `security` | — |

## 31. Feedback, anunțuri, erori, panou de administrare `saas` (Faza 11-B, 2026-10-31; ADR 0028)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Toate rutele noi dau 404 în `personal` (inclusiv pentru un administrator); `/admin/*` dă 404 non-administratorilor și 401 fără sesiune | DONE (PG17) | `admin-api.test.ts`, `e2e/admin.spec.ts` | 2026-10-31 · agent |
| RLS ENABLE + FORCE pe `feedback`, `announcements`, `app_errors`; autorul își vede doar feedback-ul propriu; UPDATE-ul unui non-administrator nu atinge niciun rând; INSERT în numele altuia respins | DONE (PG17) | `admin-api.test.ts` (izolare), `migrate.test.ts` | 2026-10-31 · agent |
| Funcțiile de administrare: SECURITY DEFINER, `search_path = pg_catalog`, verifică administratorul (`42501` altfel), doar coloane nefinanciare | DONE (PG17) | `migrate.test.ts` (conținut), `admin-api.test.ts` (chei exacte) | 2026-10-31 · agent |
| `app_errors` fără scriere directă pentru `finet_app`; doar `record_app_error`; valori invalide ignorate (rută cu parametri, cod cu spații, câmpuri în plus), cel mult 500 de erori distincte | DONE (PG17; plafonul de 500: NEVERIFICAT în test) | `admin-api.test.ts`, `migrate.test.ts` | 2026-10-31 · agent |
| Un administrator nu își poate schimba propriul cont și nu poate schimba starea altui administrator (0022); un cont dezactivat pierde sesiunea; stare nevalidă → 400 | DONE (PG17) | `admin-api.test.ts` | 2026-10-31 · agent |
| Acțiunile de schimbare se auditează (țintă + stare, fără conținut) | DONE (PG17) | `admin-api.test.ts` | 2026-10-31 · agent |
| Validare strictă (câmpuri necunoscute, tip, lungimi, `userId` din corp) pe feedback, anunțuri, stări | DONE (PG17) | `admin-api.test.ts` | 2026-10-31 · agent |
| Mesajele de feedback (text liber) pot conține date personale: se șterg cu contul; interfața avertizează să nu se scrie date financiare | DONE (cod); ștergerea în cascadă nu are test dedicat | `0020_admin_feedback.sql`, `ro.feedback.intro` | — |
| Limită de cereri pe feedback/erori: doar limita generală a mutațiilor; spam de erori limitat de cheia de amprentă și de plafonul de 500 | PARȚIAL | ADR 0028 | — |
| Audit în gospodăria administratorului (vizibil membrilor ei) | CUNOSCUT (ADR 0028 §4) | — | — |
| Revizuirea `security` a Fazei 11-B | TODO | agentul `security` | — |

## 32. Înregistrarea publică `saas` și pagina de suport (Faza 11-C1, 2026-10-31; ADR 0029)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Rutele există doar în `saas` cu `SIGNUP_ENABLED=1` și SMTP; altfel 404 (și în `personal`, chiar cu flag) | DONE (PG17) | `register-api.test.ts`, `e2e/site.spec.ts` | 2026-10-31 · agent |
| Primul utilizator NU devine administrator pe această cale (nici pe o bază goală) | DONE (PG17) | `register-api.test.ts` | 2026-10-31 · agent |
| Parola nu trece prin pasul 1; contul neverificat nu are credențiale; parola o alege cine primește emailul | DONE (PG17) | `register-api.test.ts` (fără `auth_accounts` înainte de pasul 2) | 2026-10-31 · agent |
| Link semnat HMAC (scop, expirare 48 h, email legat de utilizator), unică folosință; parolă respinsă nu îl consumă | DONE (PG17) | `register-api.test.ts` (modificat, alt secret, alt email, expirat, reutilizat) | 2026-10-31 · agent |
| Răspuns identic pentru adresă nouă/existentă (202), emailuri în fundal | DONE (PG17); nemăsurat timpul efectiv | `register-api.test.ts` | 2026-10-31 · agent |
| CSRF (`Origin`), doar JSON, schemă strictă, rate limiting pe email și pe IP | DONE (PG17); IP de încredere doar prin Access | `register-api.test.ts` | 2026-10-31 · agent |
| `/register*` nu sunt pagini cu analytics/CSP relaxat | DONE | `consent.test.ts` | 2026-10-31 · agent |
| Anti-bot (Turnstile) | TODO (11-C2); `SIGNUP_ENABLED` rămâne 0 pe deploy public până atunci | ADR 0029 §5 | — |
| Curățarea conturilor neconfirmate | TODO (înainte de expunerea publică) | ADR 0029, limite | — |
| Revizuirea `security` a Fazei 11-C1 | TODO | agentul `security` | — |

## 33. Turnstile pe înregistrarea publică (Faza 11-C2, 2026-10-31; ADR 0030)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Verificare fail-closed (rețea, timeout, non-200, JSON invalid, `success:false`, gazdă diferită, token gol/prea lung) | DONE | `turnstile.test.ts` | 2026-10-31 · agent |
| Cheile se dau împreună; secretul doar din fișier, doar rolul web, absent din mesajele de eroare | DONE | `config.test.ts` | 2026-10-31 · agent |
| Turnstile după limitele de rate (fără amplificare către Cloudflare) și înainte de orice scriere; respingere → fără cont și fără email | DONE (PG17) | `register-api.test.ts` | 2026-10-31 · agent |
| CSP Cloudflare doar pe `/register` și doar cu chei; restul paginilor neschimbat | DONE | `consent.test.ts` | 2026-10-31 · agent |
| `remoteip` doar din sursă de încredere | DONE | `turnstile.test.ts` | 2026-10-31 · agent |
| Widgetul real în browser (CI fără chei; regula „resurse doar de pe propriul domeniu”) | NEVERIFICAT în CI; de verificat manual cu cheile reale (INFRA 4v) | ADR 0030, limite | — |
| Revizuirea `security` a Fazei 11-C2 | TODO | agentul `security` | — |

## 34. Engleza pe paginile publice `saas` și expunerea publică (Faza 11-C3, 2026-10-31; ADR 0031)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Limba din cookie explicit, niciodată din `Accept-Language`; valori alterate → română | DONE | `site-locale.test.ts`, `e2e/site.spec.ts` | 2026-10-31 · agent |
| `<html lang>` dinamic doar prin antet intern pus de proxy (suprascris la fiecare cerere); `en` doar în `saas`, pe cale publică | DONE | `site-locale.test.ts`, `a11y-rules.test.ts`, `e2e/site.spec.ts` | 2026-10-31 · agent |
| Paritate chei/liste între `ro.site` și `enSite`; fără valori goale sau diacritice românești în engleză | DONE | `site-locale.test.ts` | 2026-10-31 · agent |
| Textele juridice englezești: aceleași secțiuni, datele firmei inserate, „to be completed” când lipsesc, ciornă sub `SITE_LEGAL_REVIEWED` | DONE (textul NU e revizuit juridic) | `site-locale.test.ts` | 2026-10-31 · agent |
| Cookie-ul `finet_lang` nu conține date personale; politica (ciornă) îl menționează | DONE | `legal.ts` | 2026-10-31 · agent |
| `proxy.ts` nealterat în privința Access: nicio cale nu devine publică | DONE | `proxy.test.ts` (neschimbat, verde) | 2026-10-31 · agent |
| Expunerea publică: politica Access, excepția de cod, sursa IP, WAF, SMTP, juridic, marcă | TODO (decizii ale operatorului) | `docs/EXPOSURE.md` | — |
| Revizuirea `security` a Fazei 11-C3 | TODO | agentul `security` | — |
## 35. Autentificarea cu Google, doar conturi existente (Faza 11-C2, 2026-10-31; ADR 0032)

| Punct | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Fără furnizor configurat, `/sign-in/social` și `/callback/google` dau 404; în `personal` configurarea e eroare | DONE | `google-oauth.test.ts`, `config.test.ts` | 2026-10-31 · agent |
| Nicio creare de cont: email necunoscut → `signup_disabled`, zero utilizatori și conturi noi | DONE (PG17, Better Auth 1.7.13) | `google-oauth.test.ts` | 2026-10-31 · agent |
| Legare doar cu email local verificat ȘI `email_verified` de la Google; Google nu e „de încredere” | DONE (PG17) | `google-oauth.test.ts` (neverificat local, neverificat Google) | 2026-10-31 · agent |
| Fără preluare de cont: același `sub` cu alt email → sesiunea proprietarului legat; niciun cont Google legat de alt utilizator | DONE (PG17) | `google-oauth.test.ts` | 2026-10-31 · agent |
| Cont dezactivat: nicio sesiune; stare falsificată sau lipsă: respins fără apel extern | DONE (PG17) | `google-oauth.test.ts` | 2026-10-31 · agent |
| Jetoanele OAuth nu se păstrează (acces, reîmprospătare, id, scope = null) | DONE (PG17) | `google-oauth.test.ts` | 2026-10-31 · agent |
| Doar cele trei scope-uri de identitate; un singur apel extern (schimbul de cod) | DONE | `google-oauth.test.ts` | 2026-10-31 · agent |
| Rate limiting pe pornirea fluxului; erorile nu reflectă valori din URL | DONE | `google-oauth.test.ts`, `login/page.tsx` | 2026-10-31 · agent |
| Testat cu Google REAL | NEVERIFICAT (fără credențiale); INFRA 4w | ADR 0032, limite | — |
| Facebook | NEIMPLEMENTAT intenționat (ADR 0032 §5) | — | — |
| Revizuirea `security` a Fazei 11-C2 (OAuth) | TODO | agentul `security` | — |

## 36. Revizia de securitate a Fazei 11 (2026-10-30)

Revizie manuală a înregistrării (ADR 0029), a panoului de administrare (ADR 0028), a Turnstile (0030) și a autentificării cu Google (0032).

- [x] **Plafon pe adresă, indiferent de IP** (înregistrare): limitele existente sunt pe IP + email, deci o rețea de IP-uri putea inunda căsuța unei victime cu linkuri. Acum, după Turnstile, o adresă primește cel mult 5 cereri pe oră la nivel global (`MAILBOX_RULE`); peste plafon nu se scrie și nu se trimite nimic, iar răspunsul rămâne același 202 (fără semnal despre adresă). Test: `register-api.test.ts`.
- [x] Verificat fără modificări: tokenul de înregistrare e legat de utilizator și email, expiră, se consumă o singură dată (`email_verified = false`), iar parola o alege proprietarul adresei; rutele `/admin/*` verifică administratorul în tranzacție și răspund 404; `admin_set_user_status` refuză propriul cont; schemele sunt stricte și nu primesc `userId`/`householdId`; rapoartele de erori au câmpuri restrânse prin regex.
- [x] **Conturi neverificate neșterse** (rezolvat în 0021 + `admin cleanup-unverified`, 2026-10-31): un cont creat la pasul 1 și neconfirmat se șterge după 7 zile (`--days`, 1–365). Alegerea o face `finet.stale_unverified_users` (doar citire, SECURITY DEFINER): email neverificat, activ, fără parolă, fără sesiune, fără gospodărie comună, nu administrator. Ștergerea folosește aceeași logică ca ștergerea contului GDPR (`eraseAccount`, ADR 0021), câte o tranzacție per cont. Implicit dry-run; `--yes` șterge; ieșirea are doar contoare. Testat pe Postgres real (`unverified-purge.test.ts`, `cli.test.ts`). Rămâne de programat de operator (INFRA 4x).
- [x] **Un administrator nu mai poate schimba starea altui administrator** (rezolvat în 0022_admin_guard: `admin_set_user_status` refuză orice țintă administrator, la `disabled` și la `active`, ca un admin compromis să nu poată nici scoate din joc, nici readuce un admin dezactivat de operator; `admin-api.test.ts`, `migrate.test.ts`). Starea unui administrator o schimbă doar operatorul, direct în bază.

## 37. Expunerea publică `saas`: Access opțional, IP de încredere (2026-10-31; ADR 0034)

Cod în branch `phase/11-public-edge`; **nedeployat, implicit oprit**. Nu s-a schimbat nicio politică Cloudflare.

- [x] Niciun flag nu are efect în `personal`: `SAAS_PUBLIC_ACCESS=true` cu `APP_MODE=personal` este configurație invalidă (serverul nu pornește; `proxy` cu mediu invalid răspunde 403 pe tot). `config.test.ts`, `proxy.test.ts`.
- [x] `saas` fără flag: comportament identic (403 fără JWT pe orice cale). `proxy.test.ts`.
- [x] Cu `SAAS_PUBLIC_ACCESS=true`: `/admin`, `/api/v1/admin/*` și `/api/health*` cer în continuare JWT Access valid, inclusiv în variante (`/Admin`, `//admin`, `/%61dmin`, `/API/V1/admin`, `..`, codificări invalide); JWT cu cheie străină sau audiență greșită nu le deschide; tokenul de sănătate deschide doar `/api/health`.
- [x] `cf-connecting-ip` nu mai e crezut doar fiindcă Access e „obligatoriu”: noul `access.clientIpTrusted` e `false` cu `publicSaas` fără `TRUST_CF_CONNECTING_IP`; antet falsificat → ignorat. `request.test.ts`.
- [ ] **Operator, înainte de activare:** originea accesibilă DOAR prin tunel (fără port publicat; verificat pe producție: `docker port finet-web` e gol), politica Access „Bypass” pe căile publice cu excepția `/admin`, WAF/rate limiting, SMTP, juridic (`docs/EXPOSURE.md` secțiunile 3–5).
- [ ] Risc rezidual de acceptat: cu `publicSaas`, rutele `/api/v1/documents` și `/api/v1/statements/uploads` (excluse din proxy) sunt protejate doar de sesiune, care se verifică înainte de a citi corpul (ADR 0015/0018).

## 38. Planuri, abonamente și `entitlements` în `saas` (Faza 12-A, 2026-10-31; ADR 0035)

Cod în branch `phase/12a-plans`; **migrația 0023 neaplicată, nedeployat**.

- [x] `saas` nu mai aruncă `NotImplementedError`: planul vine din `finet.household_plan`. FAIL CLOSED: fără plan (`none`), abonament expirat/anulat (`read_only`), cheie lipsă, negativă, ne-întreagă sau de alt tip în plan → `can` false, `limit` 0. `plans.test.ts`.
- [x] `personal` nu citește tabelele de planuri (test cu client care aruncă); `saas` fără client de bază aruncă `TypeError`. `plans.test.ts`.
- [x] Aplicația (`finet_app`) nu poate scrie `plans`/`subscriptions` (nici INSERT, UPDATE, DELETE): doar `SELECT`, cu RLS (abonament doar pentru membri, planuri doar pentru utilizatori autentificați); scrierea o face operatorul ca `finet_migrator`. Funcția `household_plan` nu e executabilă de `PUBLIC`. `plans.test.ts`, `migrate.test.ts`.
- [x] Abonament expirat: orice `POST/PUT/PATCH/DELETE` → 402 în `handle`, citirea și exportul merg, excepțiile sunt explicite (`handleAlways`); fără plan configurat → 503. `plans-api.test.ts`.
- [x] Plafonul de membri la invitație (membri + invitații active) și la acceptare (depășirea anulează intrarea); `ask.finet` și `reports.custom` cer funcția în plan (403). `plans-api.test.ts`.
- [ ] De decis/făcut: valorile planurilor (operator), 12-A.2 (dimensiunea fișierului, tipurile de fișier, prioritatea cozii, istoricul de bonuri pe plan), 12-B Stripe (webhook-uri idempotente, funcție de scriere dedicată), revizuirea de securitate a Fazei 12.
- [ ] Risc rezidual de acceptat: `household_plan` primește orice UUID de gospodărie și răspunde fără verificarea apartenenței (planul unei gospodării neghicibile); datele nu sunt financiare.
