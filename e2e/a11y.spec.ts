import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { type Page, expect, test } from "@playwright/test";

import { loginOk, password, userEmail } from "./fixtures";

/**
 * Auditul de accesibilitate (Faza 9, F9-B; master prompt Faza 9 „Lighthouse ≥ 90”), proiectul
 * `a11y`: axe-core (WCAG 2.0/2.1 A și AA) pe paginile principale, cu utilizatorul `a11y`.
 *
 * axe se injectează cu `page.evaluate` (prin protocolul DevTools, deci nu e blocat de CSP-ul cu
 * nonce; un `<script>` adăugat în pagină ar fi refuzat, corect). Dependența e `axe-core` (aceeași
 * versiune exista deja în arbore, tranzitiv), fără `@axe-core/playwright`.
 *
 * Criteriul: ZERO încălcări cu impact `serious` sau `critical`; cele `minor`/`moderate` se
 * raportează în log (de urmărit), fără să pice testul. Lighthouse nu rulează în CI (ar cere
 * Chrome + `lighthouse` și rulare pe build-ul de producție cu Access): ținta ≥ 90 și metoda sunt în
 * `docs/reports/faza-9.md`.
 */

const require = createRequire(import.meta.url);
let axeSource: string | null = null;
/** Sursa axe-core, citită la primul audit (listarea testelor nu cere pachetul instalat). */
function axe(): string {
  axeSource ??= readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
}

type Violation = { id: string; impact: string | null; help: string; nodes: unknown[] };
type Found = { id: string; impact: string | null; help: string; targets: string[] };

async function audit(page: Page, path: string): Promise<Found[]> {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.evaluate(axe());
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Violation[] }> };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    // Selectorii elementelor (cel mult 3), ca un eșec în CI să arate direct ce trebuie reparat.
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: (v.nodes as { target: unknown[] }[]).slice(0, 3).map((n) => n.target.join(" ")),
    }));
  });
}

function blocking(violations: Found[]): string[] {
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.help} [${v.targets.join(" | ")}]`);
}

function log(path: string, v: Found[]): void {
  if (v.length > 0) {
    console.log(
      `[a11y] ${path}:`,
      v.map((x) => `${x.id}/${x.impact} ${x.targets.join(" | ")}`).join(", "),
    );
  }
}

test("paginile publice: /login și /offline fără încălcări grave", async ({ page }) => {
  const problems: Record<string, string[]> = {};
  for (const path of ["/login", "/offline"]) {
    const v = await audit(page, path);
    log(path, v);
    if (blocking(v).length > 0) problems[path] = blocking(v);
  }
  expect(problems).toEqual({});
});

test("paginile autentificate principale fără încălcări grave (WCAG 2.1 A/AA)", async ({ page }) => {
  await loginOk(page, userEmail("a11y"), password());
  const problems: Record<string, string[]> = {};
  for (const path of [
    "/dashboard",
    "/transactions",
    "/accounts",
    "/categories",
    "/budgets",
    "/goals",
    "/reports",
    "/insights",
    "/recurring",
    "/import",
    "/receipts",
    "/family",
    "/profile",
    "/settings",
    "/settings/privacy",
    "/settings/android",
    "/help",
  ]) {
    const v = await audit(page, path);
    log(path, v);
    if (blocking(v).length > 0) problems[path] = blocking(v);
  }
  // Toate paginile se auditează (nu doar până la prima cu probleme), apoi o singură aserțiune.
  expect(problems).toEqual({});
});
