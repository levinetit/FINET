import { type Page, expect } from "@playwright/test";

/**
 * Datele testelor E2E de autentificare. Utilizatorii se creează ÎNAINTE de rulare, cu CLI-ul
 * admin (parola din stdin), câte trei pentru fiecare mod, ca scenariile să nu se încurce (fără IP
 * de încredere în dezvoltare, rate limiting-ul e pe email):
 *
 *   for u in main parola sesiuni; do
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

export function userEmail(kind: "main" | "parola" | "sesiuni"): string {
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
