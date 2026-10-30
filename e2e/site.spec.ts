import { expect } from "@playwright/test";

import { MODE, test } from "./fixtures";

/**
 * Site-ul public (Faza 11, ADR 0027). În `personal` paginile publice nu există (404, `/` duce la
 * login). În `saas`: prezentarea, prețurile, termenii și confidențialitatea, cu subsolul legal
 * (ANPC SAL, SOL, datele firmei sau „de completat”), bannerul de ciornă cât textele nu sunt
 * revizuite, `noindex` cât site-ul nu e gata și bannerul de cookie-uri doar cu ID analytics.
 */
test.describe(`site public (${MODE})`, () => {
  if (MODE === "personal") {
    test("paginile publice nu există în personal: 404; `/` duce la login", async ({ page }) => {
      for (const path of ["/pricing", "/terms", "/privacy"]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(404);
      }
      await page.goto("/");
      await expect(page).toHaveURL(/\/login$/);
    });
    return;
  }

  test("prezentarea: conținut, legături și subsolul legal", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByTestId("landing-features").locator("li")).toHaveCount(6);
    await expect(page.getByTestId("landing-register")).toHaveAttribute("href", "/register");
    const footer = page.getByTestId("legal-footer");
    await expect(footer.getByRole("link", { name: "ANPC SAL" })).toHaveAttribute(
      "href",
      /^https:\/\/anpc\.ro\//,
    );
    await expect(footer.getByRole("link", { name: "Platforma SOL (UE)" })).toHaveAttribute(
      "href",
      /^https:\/\/ec\.europa\.eu\//,
    );
    // Fără datele firmei în mediul de test: se afișează „de completat”, nu valori inventate.
    await expect(footer.getByTestId("footer-company")).toContainText("de completat");
  });

  test("termeni și confidențialitate: ciornă vizibilă, noindex, subsol legal", async ({ page }) => {
    for (const [path, heading] of [
      ["/terms", "Termeni și condiții"],
      ["/privacy", "Politica de confidențialitate"],
    ] as const) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByTestId("draft-banner")).toContainText("în curs de revizuire");
      await expect(page.getByTestId("legal-footer")).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    }
  });

  test("prețuri: fără sume inventate", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByTestId("pricing-body")).toContainText("nu are încă planuri plătite");
    await expect(page.getByTestId("pricing-body")).not.toContainText(/\d/);
  });

  test("fără ID analytics: niciun banner de cookie-uri și niciun script Google; zero încălcări CSP", async ({
    page,
  }) => {
    const violations: string[] = [];
    const googleRequests: string[] = [];
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) violations.push(m.text());
    });
    page.on("request", (r) => {
      if (/google(tagmanager|-analytics)\.com/.test(r.url())) googleRequests.push(r.url());
    });
    for (const path of ["/", "/pricing", "/terms", "/privacy"]) await page.goto(path);
    await expect(page.getByTestId("cookie-consent")).toHaveCount(0);
    expect(googleRequests).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("paginile aplicației cer tot autentificare (302 la login, nu public)", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
