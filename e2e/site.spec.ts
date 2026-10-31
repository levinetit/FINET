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
      for (const path of ["/pricing", "/terms", "/privacy", "/support", "/register"]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(404);
      }
      const api = await page.request.post("/api/v1/register", {
        data: { email: "x@exemplu.ro", name: "X", acceptTerms: true },
        headers: { Origin: new URL(page.url()).origin },
      });
      expect(api.status()).toBe(404);
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

  test("suport: secțiuni, contact „de completat”, subsol legal; ghidul /help rămâne privat", async ({
    page,
  }) => {
    const response = await page.goto("/support");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Suport" })).toBeVisible();
    await expect(page.getByTestId("support-sections").locator("section")).toHaveCount(7);
    await expect(page.getByTestId("legal-footer")).toBeVisible();
    // Ghidul din aplicație cere autentificare (anonimul ajunge la login).
    await page.goto("/help");
    await expect(page).toHaveURL(/\/login/);
  });

  test("înregistrarea e închisă implicit: /register explică, /register/complete și API-ul dau 404", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(page.getByTestId("register-unavailable")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    expect((await page.goto("/register/complete?token=x"))?.status()).toBe(404);
    const api = await page.request.post("/api/v1/register", {
      data: { email: "x@exemplu.ro", name: "X", acceptTerms: true },
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(api.status()).toBe(404);
  });

  test("limba: româna e implicită oricare ar fi Accept-Language; engleza doar prin cookie explicit", async ({
    browser,
    baseURL,
  }) => {
    // Chromium trimite `en-US` implicit: tot ce se afirmă în română trebuie să rămână în română.
    const ctx = await browser.newContext({ baseURL, locale: "en-US" });
    const page = await ctx.newPage();
    await page.goto("/support");
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    await expect(page.getByRole("heading", { level: 1, name: "Suport" })).toBeVisible();
    // Comutatorul scrie cookie-ul; pagina devine engleză, inclusiv `<html lang>`, titlul și subsolul.
    await page.getByTestId("lang-en").click();
    await expect(page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(/Support/);
    await expect(page.getByTestId("support-sections").locator("section")).toHaveCount(7);
    await expect(page.getByTestId("legal-footer")).toContainText("to be completed");
    for (const [path, heading] of [
      ["/", "FINET: your finances and your family's, in one place"],
      ["/pricing", "Pricing"],
      ["/terms", "Terms and conditions"],
      ["/privacy", "Privacy policy"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading }), path).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    }
    // Textul juridic englez e tot ciornă, cu bannerul vizibil.
    await page.goto("/terms");
    await expect(page.getByTestId("draft-banner")).toContainText("Text under review");
    // Pagina de login rămâne în română, cu lang="ro" (aplicația nu e tradusă).
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    // Înapoi la română.
    await page.goto("/support");
    await page.getByTestId("lang-ro").click();
    await expect(page.getByRole("heading", { level: 1, name: "Suport" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    await ctx.close();
  });

  test("limbi noi (Faza 13): franceza și germana prin cookie explicit; juridicul rămâne englez, cu notă; cookie străin → română", async ({
    browser,
    baseURL,
  }) => {
    const ctx = await browser.newContext({ baseURL, locale: "de-DE" });
    const page = await ctx.newPage();
    await page.goto("/support");
    // `Accept-Language: de-DE` nu schimbă nimic: româna rămâne implicită.
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    await page.getByTestId("lang-fr").click();
    await expect(page.getByRole("heading", { level: 1, name: "Assistance" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.getByTestId("legal-footer")).toContainText("à compléter");
    await page.goto("/terms");
    await expect(page.getByTestId("draft-banner")).toContainText("Texte en cours de révision");
    await expect(page.getByTestId("legal-translation-note")).toContainText("affiché en anglais");
    // Textul juridic englez are `lang="en"` propriu, în pagina `fr`.
    await expect(page.locator('article div[lang="en"]')).toBeVisible();
    await page.getByTestId("lang-de").click();
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { level: 1, name: "Preise" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    // Pagina de login rămâne în română, indiferent de limba aleasă.
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    // Un cookie cu o valoare străină cade pe română.
    await ctx.addCookies([{ name: "finet_lang", value: "xx", url: baseURL! }]);
    await page.goto("/pricing");
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    await ctx.close();
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
