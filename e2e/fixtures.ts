import { type Page, expect } from "@playwright/test";

/**
 * Datele testelor E2E de autentificare. Utilizatorii se creează ÎNAINTE de rulare, cu CLI-ul
 * admin (parola din stdin), câte treisprezece pentru fiecare mod, ca scenariile să nu se încurce (fără IP
 * de încredere în dezvoltare, rate limiting-ul e pe email; mutațiile API au 120/min per
 * utilizator, de aceea seed-ul de paginare are utilizatorul lui):
 *
 *   for u in main parola sesiuni ledger ledger2 seed planning planning2 regresii recurring recurring2 receipts receipts2; do
 *     printf '%s\n' "$E2E_PASSWORD" | FINET_ROLE=admin DATABASE_URL=<finet_app> \
 *       node dist/tools/admin.mjs create-user --email "e2e-$u-<mod>@finet.test" \
 *       --name "E2E $u" --password-stdin
 *   done
 *
 * `E2E_PASSWORD` e doar pentru baza de test (job-ul `e2e` din CI); nu e un secret real.
 */

export const MODE = process.env.E2E_APP_MODE === "saas" ? "saas" : "personal";

export function password(): string {
  const value = process.env.E2E_PASSWORD;
  if (!value || value.length < 10) {
    throw new Error("E2E_PASSWORD lipsește (minimum 10 caractere): vezi e2e/fixtures.ts");
  }
  return value;
}

/**
 * Utilizatorii E2E: `auth` (main, parola, sesiuni), `ledger` (ledger, ledger2, seed) și
 * `planning` (planning, planning2; Faza 3: exporturile au 10/min per utilizator) și `regressions`
 * (regresii; Faza 4), `recurring` (recurring, recurring2; Faza 5) și `receipts` (receipts,
 * receipts2; Faza 6: al doilea fără consimțământ AI, și pentru izolare).
 */
export const USER_KINDS = [
  "main",
  "parola",
  "sesiuni",
  "ledger",
  "ledger2",
  "seed",
  "planning",
  "planning2",
  "regresii",
  "recurring",
  "recurring2",
  "receipts",
  "receipts2",
] as const;
export type UserKind = (typeof USER_KINDS)[number];

export function userEmail(kind: UserKind): string {
  return `e2e-${kind}-${MODE}@finet.test`;
}

export async function login(page: Page, email: string, pass: string, next?: string): Promise<void> {
  await page.goto(next === undefined ? "/login" : `/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parolă", { exact: true }).fill(pass);
  await page.getByRole("button", { name: "Intră în cont" }).click();
}

export async function loginOk(page: Page, email: string, pass: string): Promise<void> {
  await login(page, email, pass);
  await expect(page).toHaveURL(/\/dashboard$/);
}
