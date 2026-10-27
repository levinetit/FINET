import { defineConfig, devices } from "@playwright/test";

/**
 * Teste E2E, în două proiecte cu servere separate:
 * - `smoke` (browser): `pnpm dev` cu Access dezactivat (NODE_ENV=development,
 *   CF_ACCESS_REQUIRED=false), ca pagina să poată fi verificată fără JWT;
 * - `access` (doar HTTP, fără browser): serverul de producție (`.next/standalone/server.js`,
 *   după `pnpm build`) cu CF_ACCESS_REQUIRED=true, ca să dovedească refuzul fără JWT.
 *
 * `E2E_SERVER=dev|prod` pornește doar serverul necesar (de exemplu `E2E_SERVER=prod
 * pnpm test:e2e --project=access`). Cu `E2E_BASE_URL` se testează o instanță deja pornită
 * (proiectul `smoke`), fără servere locale.
 */

const devPort = Number(process.env.E2E_DEV_PORT ?? 3000);
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
  APP_MODE: "personal",
  CF_ACCESS_REQUIRED: "false",
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
  PORT: String(prodPort),
  HOSTNAME: "127.0.0.1",
};

const devServer = {
  command: `pnpm dev --port ${devPort}`,
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
  fullyParallel: true,
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
      // Doar fixture-ul `request`: nu pornește niciun browser.
      name: "access",
      testMatch: /access\.spec\.ts$/,
      use: { baseURL: prodURL },
    },
  ],
  webServer,
});
