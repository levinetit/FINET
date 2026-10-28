# FINET — lista de verificare de securitate

Creată în Faza 1 (F1-C) și completată la fiecare revizuire de securitate. Referința: master prompt 6.3 (OWASP ASVS nivel 2). Stări: **DONE** (implementat și verificat prin dovada din coloană), **PARTIAL** (implementat, dar verificarea sau o parte lipsește), **TODO** (neimplementat). „NOT RUN” în dovadă înseamnă că testul există, dar nu a fost rulat încă în mediul indicat.

Identificatorii F1–F9 și N1–N5 sunt constatările revizuirii de securitate din Faza 0 (`docs/ROADMAP.md`, `docs/reports/faza-0.md`).

Revizori: `programmer` = agentul care a implementat (auto-verificare, nu revizuire independentă); `security` = revizuirea dedicată (T5 în Faza 0, F1-A în Faza 1). Revizuirea de securitate a Fazei 1 complete (F1-B + F1-C) **nu a avut loc încă**.

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

## 3. Antete

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| CSP cu nonce per cerere: `default-src 'self'`, `script-src 'self' 'nonce-…'`, `style-src 'self' 'nonce-…'`, `img-src 'self' data:`, `font-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` | DONE | `src/lib/security-headers.ts`, `src/proxy.ts`, `proxy.test.ts`, `security-headers.test.ts`; standalone: `e2e/access.spec.ts` (PASS local) | 2026-10-28 · programmer |
| Fiecare `<script>` randat poartă nonce-ul; nicio pagină statică | DONE | `next build`: toate rutele `ƒ`; `next dev` `/login`: 21 de scripturi, 0 fără nonce, 0 atribute `style=` | 2026-10-28 · programmer |
| Fără încălcări CSP în browser | PARTIAL | E2E „antetele de securitate… fără încălcări CSP” (NOT RUN local) | 2026-10-28 · programmer |
| Antetele și pe răspunsurile 403 ale proxy-ului | DONE | `proxy.test.ts`, `access.spec.ts` (PASS local) | 2026-10-28 · programmer |
| F8 (rest) — HSTS `max-age=31536000; includeSubDomains` (fără `preload`: decizia operatorului) | DONE | idem | 2026-10-28 · programmer |
| `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()` | DONE | idem; asset-urile statice prin `next.config.ts` (`headers()`, fără CSP) | 2026-10-28 · programmer |
| CORS închis (niciun `Access-Control-Allow-*`) | DONE | `proxy.test.ts`, `access.spec.ts` (preflight → 403 fără antete CORS) | 2026-10-28 · programmer |
| `'unsafe-eval'` / `'unsafe-inline'` doar în dezvoltare | DONE | `buildCsp`, testele pe ambele moduri | 2026-10-28 · programmer |
| Pagina `global-error` implicită Next (stiluri inline) | TODO | apare doar la o eroare în layout-ul rădăcină; înlocuită în Faza 9 | — |

## 4. Secrete

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| N1 / F2 (rest) — secretele prin fișiere (`*_FILE`, Docker `secrets:`), inclusiv `BETTER_AUTH_SECRET` | DONE | `src/lib/secret-files.ts`, `ops/docker/docker-compose.yml`, `pnpm test:ops` (PASS) | 2026-10-27 · security (N1, T7) |
| F8 (parțial) — `.env.example` fără secrete; valorile de exemplu refuzate la pornire | DONE | `config.ts` (`PLACEHOLDER_SECRET`), `config.test.ts` | 2026-10-27 · programmer |
| F1 — secrete pe rol (`FINET_ROLE`), URL-urile altor roluri refuzate | DONE | `config.ts`, `config.test.ts` (F1) | 2026-10-27 · security |
| Niciun secret în `.next/static` | DONE | `pnpm scan:client-secrets` (PASS, 2026-10-28) | 2026-10-28 · programmer |
| F5 — tipare noi în scanerul de secrete (`scripts/scan-client-secrets.mjs`) | DONE | `scan-client-secrets.test.ts`, `pnpm scan:client-secrets` (PASS) | 2026-10-27 · security (T5) |
| N3 — scanerul: id bot Telegram 8–12 cifre, excepția JWT `anon` | TODO | `docs/ROADMAP.md` | — |
| F6 — scanare de secrete în istoric/PR (gitleaks) | TODO | `docs/ROADMAP.md` | — |

## 5. Încărcări de fișiere (viitor, Faza 6)

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Tip după conținut, dimensiune maximă, cotă, EXIF eliminat, nume generate, servire autorizată, limite ZIP | TODO | Faza 6 | — |
| Storage local confinat (realpath, `O_NOFOLLOW`, scriere atomică) | DONE | `src/lib/storage/local.ts`, `storage.test.ts` | 2026-10-27 · security (T5) |
| F9 — curățarea fișierelor temporare orfane și limita la `put` | TODO | Faza 6 | — |

## 6. Date personale în loguri

| Cerință | Stare | Dovadă | Data · revizor |
|---|---|---|---|
| Erorile de configurație numesc variabila, nu valoarea | DONE | `config.ts`, `config.test.ts` | 2026-10-27 · programmer |
| Better Auth: doar nivelul și mesajul în log | DONE | `auth.ts` (`logger`) | 2026-10-27 · programmer |
| Audit fără emailuri, IP-uri, user-agent (doar id-uri și tipuri) | DONE | `audit.ts`, ADR 0003 | 2026-10-27 · programmer |
| UI: erorile neprevăzute fără detalii (`[ui] sesiunea nu a putut fi verificată`) | DONE | `src/app/_lib/session.ts`, `src/app/error.tsx` | 2026-10-28 · programmer |
| Loguri structurate (pino) | TODO | faza în care apar logurile de business | — |

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
| **L2** — `audit_events` șterse în CASCADE la ștergerea gospodăriei | TODO | amânat: ștergerea gospodăriilor nu există încă în aplicație; se decide odată cu ea (Faza 8 / ștergerea contului) | — |
| **L3** — „ultimul owner” poate pleca/fi scos | TODO | amânat: gestiunea membrilor din UI vine în Faza 8; CLI-ul doar adaugă | — |
| **L6** — tokenul de resetare stocat în clar în `auth_verifications` | TODO | amânat: opțiunea Better Auth pentru resetare nu există ca la magic link (`storeToken: "hashed"`); token de 24 de caractere, 30 de minute, de unică folosință; de revăzut la actualizarea Better Auth | — |
| **L7** — parola generată de CLI pe stdout | TODO | amânat: comportament documentat (afișată o singură dată, operatorul o copiază); alternativa (fișier 0600 / doar `--password-stdin`) se decide cu operatorul | — |
| **L8** — `viaBearer` scutește de CSRF și când există și cookie | TODO | amânat: Bearer cere antet explicit (imposibil cross-site fără CORS, închis); de restrâns la „bearer și fără cookie” la prima revizuire a clientului Android | — |
| Ștergerea contului (GDPR) | TODO | fază viitoare: funcție SECURITY DEFINER care refuză administratorii și gospodăriile cu un singur membru (`finet_app` nu are DELETE pe `users`, M5) | — |

