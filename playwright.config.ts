import { defineConfig, devices } from "@playwright/test";

/**
 * Teste E2E, în mai multe proiecte, pe două servere (Faza 9: `pwa`, scanarea offline):
 * - `smoke`, `auth`, `ledger` și `planning` (browser): `pnpm dev` cu Access dezactivat DOAR pentru test
 *   (NODE_ENV=development, CF_ACCESS_REQUIRED=false; `src/lib/config.ts` refuză asta în
 *   producție și nu e slăbit). `auth` cere un Postgres de test migrat (`DATABASE_URL` = rolul
 *   `finet_app`), utilizatorii E2E creați cu CLI-ul admin (`e2e/fixtures.ts`) și `E2E_PASSWORD`;
 *   `ledger` (Faza 2: conturi, tranzacții, transferuri, categorii) și `planning` (Faza 3:
 *   dashboard, bugete, obiective, etichete, rapoarte, export CSV), `regressions` (Faza 4) și
 *   `recurring` (Faza 5: plăți recurente) au aceleași cerințe; `receipts` (Faza 6: bonuri) cere în
 *   plus workerul și serverul AI fals (`E2E_AI_MOCK_URL`, pornite de CI; altfel sărit);
 *   Modul aplicației: `E2E_APP_MODE=personal|saas` (implicit `personal`); cele două moduri se
 *   rulează unul după altul (două `next dev` în același director s-ar bloca reciproc);
 * - `access` (doar HTTP, fără browser): serverul de producție (`.next/standalone/server.js`,
 *   după `pnpm build`) cu CF_ACCESS_REQUIRED=true, ca să dovedească refuzul fără JWT și
 *   antetele de securitate de producție (CSP fără `unsafe-*`).
 *
 * `E2E_SERVER=dev|prod` pornește doar serverul necesar (de exemplu `E2E_SERVER=prod
 * pnpm test:e2e --project=access`). Cu `E2E_BASE_URL` se testează o instanță deja pornită
 * (proiectul `smoke`), fără servere locale.
 */

const devPort = Number(process.env.E2E_DEV_PORT ?? 3000);
const appMode = process.env.E2E_APP_MODE === "saas" ? "saas" : "personal";
const prodPort = Number(process.env.E2E_PROD_PORT ?? 3001);
const devURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${devPort}`;
const prodURL = `http://127.0.0.1:${prodPort}`;
const only = process.env.E2E_SERVER;

// Mediul fiecărui server, peste mediul curent (fără secrete: valori fictive). Serverul e rolul
// `web`, care refuză să pornească dacă vede URL-urile workerului sau ale migratorului; ele se
// golesc aici, ca un mediu de dezvoltare care le exportă să nu oprească testele.
const webRole: Record<string, string> = {
  FINET_ROLE: "web",
  WORKER_DATABASE_URL: "",
  MIGRATOR_DATABASE_URL: "",
};
const devEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...webRole,
  NODE_ENV: "development",
  APP_MODE: appMode,
  CF_ACCESS_REQUIRED: "false",
  // Originea exactă a serverului: Better Auth (`trustedOrigins`) și CSRF-ul din `/api/v1`
  // compară `Origin` cu `APP_URL`.
  APP_URL: `http://127.0.0.1:${devPort}`,
  // Secret FICTIV, doar pentru serverul de test (fără cuvintele refuzate de `config.ts`).
  BETTER_AUTH_SECRET: "e2e-local-0123456789abcdefghijklmnopqrstuv",
  // Faza 6: același director ca workerul pornit de CI (proiectul `receipts`).
  STORAGE_DIR: process.env.STORAGE_DIR || ".data/e2e-storage-dev",
  AI_DAILY_DOCUMENT_LIMIT: process.env.AI_DAILY_DOCUMENT_LIMIT || "200",
};
const prodEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...webRole,
  NODE_ENV: "production",
  APP_MODE: "personal",
  CF_ACCESS_REQUIRED: "true",
  // Domeniu `.invalid` (RFC 2606): cheile Access nu pot fi descărcate, deci orice JWT e refuzat.
  CF_ACCESS_TEAM_DOMAIN: "echipa-e2e.invalid",
  CF_ACCESS_AUD: "e2e-aud",
  STORAGE_DIR: ".data/e2e-storage",
  // Rolul `web` de producție cere APP_URL https și secretul Better Auth (valori FICTIVE);
  // fără ele serverul s-ar opri la pornire (`src/instrumentation.ts`).
  APP_URL: "https://finet-e2e.invalid",
  BETTER_AUTH_SECRET: "e2e-local-0123456789abcdefghijklmnopqrstuv",
  PORT: String(prodPort),
  HOSTNAME: "127.0.0.1",
};

const devServer = {
  command: `pnpm dev --port ${devPort} --hostname 127.0.0.1`,
  url: devURL,
  env: devEnv,
  reuseExistingServer: !process.env.CI,
  timeout: 180_000,
};
const prodServer = {
  command: "node .next/standalone/server.js",
  url: `${prodURL}/api/health/live`,
  env: prodEnv,
  reuseExistingServer: false,
  timeout: 60_000,
};

const webServer = process.env.E2E_BASE_URL
  ? undefined
  : only === "dev"
    ? [devServer]
    : only === "prod"
      ? [prodServer]
      : [devServer, prodServer];

export default defineConfig({
  testDir: "./e2e",
  // Secvențial (decizia mea): scenariile de autentificare împart utilizatori și contoare de rate
  // limiting; paralelismul ar face rezultatele dependente de ordine.
  fullyParallel: false,
  workers: 1,
  // `next dev` compilează paginile la prima cerere.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      testMatch: /smoke\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      name: "auth",
      testMatch: /auth\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Registrul (Faza 2): același server și aceeași bază ca `auth`, utilizatori proprii.
      name: "ledger",
      testMatch: /ledger\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Planificarea (Faza 3): același server și aceeași bază, utilizatori proprii.
      name: "planning",
      testMatch: /planning\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Regresiile Fazei 4 (cereri doar către propriul domeniu, prefetch RSC fără sesiune,
      // titluri și `lang`): același server și aceeași bază, utilizatorul `regresii`.
      name: "regressions",
      testMatch: /regressions\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Plățile recurente (Faza 5): același server și aceeași bază, utilizatorii `recurring` și
      // `recurring2` (izolarea).
      name: "recurring",
      testMatch: /recurring\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Bonurile (Faza 6): același server și aceeași bază, plus WORKERUL și SERVERUL AI FALS
      // (`e2e/ai-mock-server.mjs`), pornite de CI în fundal (`E2E_AI_MOCK_URL`); fără ele, sărit.
      name: "receipts",
      testMatch: /receipts\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Familia (Faza 8): același server și aceeași bază, utilizatorii `family`, `family2`,
      // `family3`; doar în modul `personal` (în `saas` testul se sare).
      name: "family",
      testMatch: /family\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Extrasele (Faza 7, F7-B): utilizatorii `statements`, `statements2`, `statements3`; doar
      // date SINTETICE. Partea cu PDF și potrivirea cer workerul + serverul AI fals (ca `receipts`).
      name: "statements",
      testMatch: /statements\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // PWA și offline (Faza 9, ADR 0020): același server și aceeași bază, utilizatorii `pwa` și
      // `pwa2`; service worker-ul permis explicit (implicit oricum).
      // În `saas`, testele cozii offline (cer `/import` și încărcarea, deci entitlements) se sar
      // până în Faza 11, ca proiectul `receipts`.
      name: "pwa",
      testMatch: /pwa\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL, serviceWorkers: "allow" },
    },
    {
      // GDPR și statistici (Faza 9, F9-B, ADR 0021): exportul, ștergerea contului (utilizatorul
      // `gdpr2` dispare), „Statistici” (administratorul = `main` din modul personal).
      name: "gdpr",
      testMatch: /gdpr\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Accesibilitatea (Faza 9, F9-B): axe-core pe paginile principale, utilizatorul `a11y`.
      name: "a11y",
      testMatch: /a11y\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Listele de cumpărături (Faza 10, F10-A): utilizatorii `shopping` și `shopping2`; bonul
      // confirmat este SINTETIC, inserat direct în baza de test (fără worker sau AI).
      name: "shopping",
      testMatch: /shopping\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Feedback, anunțuri și panoul de administrare (Faza 11-B): `main` (administrator) și `ask`.
      name: "admin",
      testMatch: /admin\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Site-ul public al modului `saas` (Faza 11): fără autentificare, fără utilizatori proprii.
      name: "site",
      testMatch: /site\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // „Întreabă FINET” și rezumatul lunii (Faza 10, F10-C): utilizatorul `ask`; datele se creează
      // prin API (fără worker sau AI).
      name: "ask",
      testMatch: /ask\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Rapoartele inteligente (Faza 10, F10-B): utilizatorii `insights` și `insights2`; bonurile
      // confirmate sunt SINTETICE, inserate direct în baza de test (fără worker sau AI).
      name: "insights",
      testMatch: /insights\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], baseURL: devURL },
    },
    {
      // Doar fixture-ul `request`: nu pornește niciun browser.
      name: "access",
      testMatch: /access\.spec\.ts$/,
      use: { baseURL: prodURL },
    },
  ],
  webServer,
});
