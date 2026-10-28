# FINET — arhitectura (ce există în Faza 1, după F1-C)

Acest document descrie **doar codul existent**. Ce e planificat apare separat, marcat „planificat”. Specificația completă: `docs/FINET_MASTER_PROMPT.md` (secțiunile 3 și 6). Deploy: `docs/INFRA.md`.

## Pe scurt
Monolit Next.js 16 (App Router, TypeScript strict), rulat ca server Node `standalone` într-un container Docker. Din Faza 1: schema Drizzle `finet` cu RLS, Better Auth (parole Argon2id, sesiuni în bază, `bearer`), API-ul `/api/v1/me*`, CLI-ul admin și interfața web de autentificare și profil (F1-C). Nu există încă module financiare sau worker real. Detaliile deciziilor Fazei 1: ADR 0003.

## Structura existentă

```
src/
  app/
    layout.tsx                  # html lang="ro", tema din cookie-ul finet_theme; dinamic (nonce CSP)
    page.tsx                    # `/` → /dashboard sau /login
    login/, register/           # login (email + parolă, magic link doar cu SMTP); /register 404 în personal
    (app)/layout.tsx            # navigare jos pe telefon, meniu lateral pe desktop
    (app)/dashboard, (app)/profile  # paginile protejate (profil: preferințe, parolă, sesiuni)
    not-found.tsx, error.tsx    # 404 și eroarea generică, fără stiluri inline
    _lib/                       # session.ts (sesiunea în pagini, fail closed), next-path.ts (?next= sigur),
                                #   api-client.ts (fetch JSON spre /api), theme.ts, use-hydrated.ts
    _components/logo.tsx        # wordmark-ul FINET (master prompt 3.4)
    fonts.ts, fonts/            # next/font/local: Bricolage Grotesque, IBM Plex Sans/Mono (OFL)
    globals.css                 # tokenii FINET (+ surface-2, accent-soft) și numele shadcn
    api/auth/[...all]           # Better Auth, prin src/modules/auth/handler.ts
    api/v1/me*                  # profil, sesiuni, parolă (src/app/api/v1/_lib/me-handlers.ts)
    api/health/                 # /api/health (protejat) și /api/health/live (liveness)
  components/ui/, components/app/ # Button, Input/Select, Label, Card, Alert; navigarea, iconițele
  messages/ro.ts                # textele interfeței
  proxy.ts                      # Cloudflare Access (fail closed) + antetele de securitate cu nonce
  instrumentation.ts            # validarea configurației la pornire
  lib/
    config.ts, config-startup.ts # mediul, validat cu Zod; oprește pornirea dacă e invalid
    security-headers.ts         # CSP cu nonce, HSTS și celelalte antete (6.3)
    secret-files.ts             # secretele din fișiere (`*_FILE`, Docker secrets)
    db-client.ts, db-url.ts     # clientul Postgres comun (TLS cu DATABASE_CA_FILE)
    access.ts                   # verificarea JWT Access, liveness local, HEALTH_TOKEN
    authz.ts                    # requireMember / withMember (stratul 1 de autorizare)
    money.ts                    # bani în bigint (unități minore), alocare, parsare, formatare RO
    storage.ts, storage/        # interfața Storage; driver local; S3 = schelet
    errors.ts, utils.ts
  db/                           # schema Drizzle, migrațiile (0000_core, 0001_rls), runner-ul, RLS
  modules/auth, profile, sessions, entitlements
  tools/admin/                  # CLI-ul admin (dist/tools/admin.mjs)
scripts/scan-client-secrets.mjs # caută secrete în .next/static (CI)
e2e/                            # Playwright: smoke, auth (browser, next dev), access (HTTP, standalone)
ops/                            # docker, cloudflare, supabase, notify, postgres
```

## Fluxul unei cereri
1. Cloudflare (Access) → `cloudflare-tunnel` sau `traefik-main` → `finet-web:3000` (`docs/INFRA.md`).
2. `src/proxy.ts` rulează pe toate căile, cu matcher-ul `["/((?!_next/static/).*)"]`, și apelează `isRequestAllowed` din `src/lib/access.ts`. Ordinea excepțiilor:
   1. asset-urile statice Next (`/_next/static/`), excluse și din matcher, și din cod (`isStaticAssetPath`);
   2. `GET /api/health/live` (doar metoda `GET` și exact această cale; `HEAD`/`POST` etc. cer Access, iar `/api/health/live/` primește întâi un 308 de la Next spre calea exactă) doar dacă cererea e locală (`isLocalProbe`: `Host` loopback, fără `cf-connecting-ip`, `cf-ray`, `cf-ipcountry`, `x-real-ip`, `cf-access-jwt-assertion`, `X-Forwarded-*` doar loopback);
   3. `/api/health` cu `X-Finet-Health-Token` egal cu `HEALTH_TOKEN` (comparare în timp constant), doar dacă tokenul e configurat;
   4. altfel, cu `CF_ACCESS_REQUIRED=true`, e nevoie de un JWT `Cf-Access-Jwt-Assertion` valid (RS256, cheile de la `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud`, `iss`, `exp`).
   - `/favicon.ico` **nu** e exclus (nu există favicon; cererea ar fi randată prin layout).
   - **Fail closed:** orice eroare (configurație invalidă, chei indisponibile, token greșit) → 403 JSON `{"error":{"code":"forbidden",...}}`, `Cache-Control: no-store`.
3. După decizia de acces, `src/proxy.ts` pune antetele de securitate (`src/lib/security-headers.ts`) pe ambele ramuri (403 și cererea permisă): CSP cu un nonce nou per cerere (pus și în antetele cererii, ca Next să-l atașeze scripturilor), HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`; fără antete CORS. `/_next/static/` primește antetele fixe din `next.config.ts`.
4. Route handler-ele / paginile răspund. Paginile protejate verifică sesiunea pe server (`src/app/_lib/session.ts` → `requireSession`); fără sesiune: 307 spre `/login?next=<cale>`. Mutațiile din browser trec prin aceleași rute `/api/auth/*` și `/api/v1/*` ca aplicația Android (rate limiting, CSRF prin `Origin`, audit).

## Configurația
`src/lib/config.ts` citește `process.env` o singură dată (leneș, nu la `next build`) și validează cu Zod. Reguli notabile: `APP_MODE` obligatoriu; `FINET_ROLE` (`web` implicit, `worker`, `migrate`) alege singurul URL de bază de date permis procesului (`DATABASE_URL`, `WORKER_DATABASE_URL`, respectiv `MIGRATOR_DATABASE_URL`); URL-ul altui rol prezent în mediu oprește pornirea, iar serverul Next.js pornește doar cu `FINET_ROLE=web` (`src/lib/config-startup.ts`); `Config.database` are `url` (al rolului curent) și `ca` (PEM-ul din `DATABASE_CA_FILE`, citit o dată; cere `sslmode=verify-full`/`verify-ca`, iar `sslrootcert` din URL e refuzat); fiecare secret poate veni dintr-un fișier, `<NUME>_FILE` (`src/lib/secret-files.ts`: `X` și `X_FILE` împreună = eroare, fișier obișnuit ≤ 4096 octeți, o linie, regula pe rol se aplică și `_FILE`-urilor, ale căror fișiere nici nu se deschid); în producție `CF_ACCESS_REQUIRED=false` e refuzat și `STORAGE_DIR` e obligatoriu (nu pentru `migrate`); `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` obligatorii când Access e cerut, doar pentru `web`; `HEALTH_TOKEN` ≥ 32 caractere; `AI_MONTHLY_BUDGET` parsat ca bani (bigint), monedă `AI_MONTHLY_BUDGET_CURRENCY`; Telegram cere ambele variabile; `SMTP_HOST` cere `SMTP_FROM`. Mesajele de eroare nu conțin valori. Lista: `.env.example`.

## Bani
`src/lib/money.ts`: sume `bigint` în unități minore, monedă obligatorie, fără `Number` pentru sume; alocare cu metoda restului cel mai mare; parsare și formatare românească. Acoperit de `src/lib/money.test.ts`.

## Storage
Interfața `Storage` (`put`/`get`/`delete`/`exists`); cheile `<prefix>/<uuid>` sunt generate de storage, validate strict la citire. Driverul `local` e confinat în `STORAGE_DIR` (realpath, `O_NOFOLLOW`, scriere atomică). Driverul `s3` aruncă `NotImplementedError` (Faza 6).

## Sănătatea
`/api/health`: `db` (`select 1`, clientul comun din `src/lib/db-client.ts` cu o conexiune, `prepare: false`, TLS după `sslmode` și CA), `storage` (scriere/citire/ștergere), `diskFreePercent`; `queue` și `ai` = `unknown`. `ok` doar dacă `db` și `storage` sunt `ok`; `down` (503) dacă oricare e `down`; altfel `degraded`. Fără versiuni, căi sau mesaje de eroare în răspuns.

## Deploy și CI
- Imaginea: `Dockerfile` (multi-stage, user non-root, healthcheck). Compose: `ops/docker/docker-compose.yml` (`finet-web`, `finet-worker` și `finet-migrate`, fiecare cu `FINET_ROLE` fixat, propriul `env_file` nesecret din `/srv/finet/env/`, doar secretele rolului său ca fișiere `secrets:` din `/srv/finet/secrets/` și CA-ul Supabase montat read-only).
- CI: `.github/workflows/ci.yml`: job-ul `ci` (install, lint, format, typecheck, migrații de două ori, teste cu PostgreSQL `ops/postgres/VERSION`, build, scanarea secretelor, audit non-blocant) și job-ul `e2e` (migrații, utilizatori prin CLI, Playwright Chromium: `personal` apoi `saas`, plus `access` pe serverul de producție). Coverage nu rulează în CI.

## Planificat (nu există încă)
Modulele de business (`accounts`, `transactions` etc., Faza 2+), restul API-ului `/api/v1/` + OpenAPI (Faza 2+), pg-boss și workerul real (Faza 5/6), driverul S3, `lib/ai/`, sharp (Faza 6), Recharts, înregistrarea publică și modul `saas` (Faza 11).
