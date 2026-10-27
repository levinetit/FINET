# FINET — arhitectura (ce există la finalul Fazei 0)

Acest document descrie **doar codul existent**. Ce e planificat apare separat, marcat „planificat”. Specificația completă: `docs/FINET_MASTER_PROMPT.md` (secțiunile 3 și 6). Deploy: `docs/INFRA.md`.

## Pe scurt
Monolit Next.js 16 (App Router, TypeScript strict), rulat ca server Node `standalone` într-un container Docker. Nu există încă bază de date proprie (schema), autentificare, module de business sau worker real.

## Structura existentă

```
src/
  app/
    layout.tsx, page.tsx        # pagina goală cu logo-ul (<Logo />), lang="ro"
    _components/logo.tsx        # wordmark-ul FINET (master prompt 3.4)
    fonts.ts, fonts/            # next/font/local: Bricolage Grotesque, IBM Plex Sans/Mono (OFL)
    globals.css                 # tokenii FINET, temă luminoasă/întunecată
    api/health/route.ts         # GET /api/health (protejat)
    api/health/checks.ts        # verificări db, storage, disc; queue/ai = unknown
    api/health/live/route.ts    # GET /api/health/live (liveness)
  proxy.ts                      # protecția Cloudflare Access (fostul middleware)
  instrumentation.ts            # validarea configurației la pornire
  lib/
    config.ts, config-startup.ts # mediul, validat cu Zod; oprește pornirea dacă e invalid
    access.ts                   # verificarea JWT Access, liveness local, HEALTH_TOKEN
    money.ts                    # bani în bigint (unități minore), alocare, parsare, formatare RO
    storage.ts, storage/        # interfața Storage; driver local; S3 = schelet
    errors.ts, utils.ts
  modules/entitlements/         # `can`/`limit` pentru `personal`; `saas` neimplementat
  db/, worker/                  # goale (.gitkeep)
scripts/scan-client-secrets.mjs # caută secrete în .next/static (CI)
e2e/                            # Playwright: smoke (browser), access (HTTP)
ops/                            # docker, cloudflare, supabase, notify, postgres
```

## Fluxul unei cereri
1. Cloudflare (Access) → `cloudflare-tunnel` sau `traefik-main` → `finet-web:3000` (`docs/INFRA.md`).
2. `src/proxy.ts` rulează pe toate căile, cu matcher-ul `["/((?!_next/static/).*)"]`, și apelează `isRequestAllowed` din `src/lib/access.ts`. Ordinea excepțiilor:
   1. asset-urile statice Next (`/_next/static/`), excluse și din matcher, și din cod (`isStaticAssetPath`);
   2. `GET /api/health/live` doar dacă cererea e locală (`isLocalProbe`: `Host` loopback, fără `cf-connecting-ip`, `cf-ray`, `cf-ipcountry`, `x-real-ip`, `cf-access-jwt-assertion`, `X-Forwarded-*` doar loopback);
   3. `/api/health` cu `X-Finet-Health-Token` egal cu `HEALTH_TOKEN` (comparare în timp constant), doar dacă tokenul e configurat;
   4. altfel, cu `CF_ACCESS_REQUIRED=true`, e nevoie de un JWT `Cf-Access-Jwt-Assertion` valid (RS256, cheile de la `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, `aud`, `iss`, `exp`).
   - `/favicon.ico` **nu** e exclus (nu există favicon; cererea ar fi randată prin layout).
   - **Fail closed:** orice eroare (configurație invalidă, chei indisponibile, token greșit) → 403 JSON `{"error":{"code":"forbidden",...}}`, `Cache-Control: no-store`.
3. Route handler-ele / paginile răspund.

## Configurația
`src/lib/config.ts` citește `process.env` o singură dată (leneș, nu la `next build`) și validează cu Zod. Reguli notabile: `APP_MODE` obligatoriu; în producție `CF_ACCESS_REQUIRED=false` e refuzat și `STORAGE_DIR` e obligatoriu; `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` obligatorii când Access e cerut; `HEALTH_TOKEN` ≥ 32 caractere; `AI_MONTHLY_BUDGET` parsat ca bani (bigint), monedă `AI_MONTHLY_BUDGET_CURRENCY`; Telegram cere ambele variabile; `SMTP_HOST` cere `SMTP_FROM`. Mesajele de eroare nu conțin valori. Lista: `.env.example`.

## Bani
`src/lib/money.ts`: sume `bigint` în unități minore, monedă obligatorie, fără `Number` pentru sume; alocare cu metoda restului cel mai mare; parsare și formatare românească. Acoperit de `src/lib/money.test.ts`.

## Storage
Interfața `Storage` (`put`/`get`/`delete`/`exists`); cheile `<prefix>/<uuid>` sunt generate de storage, validate strict la citire. Driverul `local` e confinat în `STORAGE_DIR` (realpath, `O_NOFOLLOW`, scriere atomică). Driverul `s3` aruncă `NotImplementedError` (Faza 6).

## Sănătatea
`/api/health`: `db` (`select 1`, client cu o conexiune, `prepare: false`), `storage` (scriere/citire/ștergere), `diskFreePercent`; `queue` și `ai` = `unknown`. `ok` doar dacă `db` și `storage` sunt `ok`; `down` (503) dacă oricare e `down`; altfel `degraded`. Fără versiuni, căi sau mesaje de eroare în răspuns.

## Deploy și CI
- Imaginea: `Dockerfile` (multi-stage, user non-root, healthcheck). Compose: `ops/docker/docker-compose.yml`.
- CI: `.github/workflows/ci.yml` (install, lint, format, typecheck, teste cu PostgreSQL `ops/postgres/VERSION`, build, scanarea secretelor, audit non-blocant). E2E și coverage **nu** rulează în CI.

## Planificat (nu există încă)
Schema Drizzle în schema `finet` + RLS și rolurile `finet_app`/`finet_migrator` (Faza 1), `lib/authz.ts`, Better Auth (Faza 1), modulele de business (`accounts`, `transactions` etc., Faza 2+), API-ul `/api/v1/` + OpenAPI (Faza 2+), pg-boss și workerul real (Faza 5/6), driverul S3, `lib/ai/`, sharp (Faza 6), componente shadcn/ui, Recharts, lucide-react, modul `saas` (Faza 11).
