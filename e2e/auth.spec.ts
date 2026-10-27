import { type Page, expect, test } from "@playwright/test";

import { MODE, login, loginOk, password, userEmail } from "./fixtures";

// Serverul `next dev` cu Access dezactivat doar pentru test (proiectul `auth` din
// playwright.config.ts), pe un Postgres de test, în modul `E2E_APP_MODE` (personal | saas).

test.describe(`autentificare (${MODE})`, () => {
  test("login corect → dashboard cu gospodăria și rolul", async ({ page }) => {
    await loginOk(page, userEmail("main"), password());
    await expect(page.getByRole("heading", { level: 1, name: "Acasă" })).toBeVisible();
    await expect(page.getByText("Aici va apărea dashboard-ul (Faza 3).")).toBeVisible();
    await expect(page.getByTestId("household-name")).toHaveText("Gospodăria mea");
    await expect(page.getByTestId("household-role")).toHaveText("Proprietar");
    await expect(page.getByRole("navigation", { name: "Navigare principală" })).toBeVisible();
  });

  test("parolă greșită și email inexistent → același mesaj", async ({ page }) => {
    await login(page, userEmail("main"), "parola-gresita-123");
    const alert = page.getByRole("alert").filter({ hasText: "Email sau parolă greșită." });
    await expect(alert).toBeVisible();
    await expect(page).toHaveURL(/\/login/);

    await login(page, `nimeni-${Date.now()}@finet.test`, "parola-gresita-123");
    await expect(alert).toBeVisible();
  });

  test("logout → /login, iar paginile protejate cer din nou login", async ({ page }) => {
    await loginOk(page, userEmail("main"), password());
    await page.getByRole("button", { name: "Deconectează-te" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
  });

  test("rută protejată fără sesiune → /login?next=…, apoi revenire după login", async ({
    page,
  }) => {
    const response = await page.request.get("/profile", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toBe("/login?next=%2Fprofile");

    await page.goto("/profile");
    await expect(page).toHaveURL(/\/login\?next=%2Fprofile$/);
    await page.getByLabel("Email").fill(userEmail("main"));
    await page.getByLabel("Parolă", { exact: true }).fill(password());
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole("heading", { level: 1, name: "Profil" })).toBeVisible();
  });

  test("`/` trimite la /login fără sesiune și la /dashboard cu sesiune", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await loginOk(page, userEmail("main"), password());
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("/register: 404 în personal; mesaj „nu e disponibilă încă” în saas", async ({ page }) => {
    const response = await page.goto("/register");
    if (MODE === "personal") {
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "Pagina nu există" })).toBeVisible();
    } else {
      // Înregistrarea publică vine în Faza 11; până atunci pagina spune asta, iar API-ul de
      // sign-up rămâne închis (404).
      expect(response?.status()).toBe(200);
      await expect(page.getByText(/nu e disponibilă încă/)).toBeVisible();
    }
    const signUp = await page.request.post("/api/auth/sign-up/email", {
      data: { email: `nou-${Date.now()}@finet.test`, password: "parola-noua-12345", name: "Nou" },
    });
    expect(signUp.status()).toBe(404);
  });

  test("?next=//evil.com (și variante) nu redirecționează în afara site-ului", async ({
    page,
    baseURL,
  }) => {
    for (const next of ["//evil.com", "https://evil.com/", "/\\evil.com", "/%2F%2Fevil.com"]) {
      await page.context().clearCookies();
      await login(page, userEmail("main"), password(), next);
      await expect(page).toHaveURL(/\/dashboard$/);
      expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    }
  });

  test("rate limiting vizibil: a 6-a încercare dă „Prea multe încercări”", async ({ page }) => {
    // Email inexistent (contorul e pe email, fără IP de încredere în dezvoltare): nu blochează
    // utilizatorii celorlalte scenarii. Răspunsul e 429, uniform.
    const ghost = `rate-${MODE}-${Date.now()}@finet.test`;
    const statuses: number[] = [];
    page.on("response", (r) => {
      if (r.url().endsWith("/api/auth/sign-in/email")) statuses.push(r.status());
    });
    for (let i = 0; i < 5; i++) {
      await login(page, ghost, "parola-gresita-123");
      await expect(page.getByRole("alert").filter({ hasText: "greșită" })).toBeVisible();
    }
    await login(page, ghost, "parola-gresita-123");
    await expect(page.getByRole("alert").filter({ hasText: "Prea multe încercări" })).toBeVisible();
    expect(statuses.at(-1)).toBe(429);
  });

  test("antetele de securitate și CSP cu nonce pe pagini; fără încălcări CSP", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) violations.push(m.text());
    });
    const response = await page.goto("/login");
    const headers = response!.headers();
    const csp = headers["content-security-policy"] ?? "";
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toBe("camera=(self), microphone=(), geolocation=()");
    expect(Object.keys(headers).filter((h) => h.startsWith("access-control-allow-"))).toEqual([]);

    // Fiecare <script> din HTML poartă nonce-ul din antet.
    const html = await response!.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);

    // Hidratarea funcționează sub CSP (formularul răspunde) și nu apar încălcări.
    await loginOk(page, userEmail("main"), password());
    await page.goto("/profile");
    await expect(page.getByRole("heading", { level: 1, name: "Profil" })).toBeVisible();
    expect(violations).toEqual([]);
  });

  test("profilul: numele și preferințele se salvează", async ({ page }) => {
    await loginOk(page, userEmail("main"), password());
    await page.goto("/profile");
    const name = page.getByLabel("Nume", { exact: true });
    await name.fill(`E2E main ${MODE}`);
    await page.getByLabel("Temă").selectOption("dark");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(name).toHaveValue(`E2E main ${MODE}`);
    await expect(page.getByLabel("Temă")).toHaveValue("dark");
    // Revenire la tema sistemului.
    await page.getByLabel("Temă").selectOption("system");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  });
});

test.describe(`sesiuni și parolă (${MODE})`, () => {
  async function changePassword(page: Page, current: string, next: string) {
    await page.goto("/profile");
    await page.getByLabel("Parola curentă").fill(current);
    await page.getByLabel("Parola nouă", { exact: true }).fill(next);
    await page.getByLabel("Confirmă parola nouă").fill(next);
    await page.getByRole("button", { name: "Schimbă parola" }).click();
    await expect(page.getByText(/Parola a fost schimbată/)).toBeVisible();
  }

  test("schimbarea parolei revocă celelalte sesiuni (două contexte)", async ({
    browser,
    baseURL,
  }) => {
    const email = userEmail("parola");
    const original = password();
    const changed = `${original}-nou-${Date.now() % 100000}`;
    const a = await browser.newContext({ baseURL });
    const b = await browser.newContext({ baseURL });
    try {
      const pageA = await a.newPage();
      const pageB = await b.newPage();
      await loginOk(pageA, email, original);
      await loginOk(pageB, email, original);

      await changePassword(pageA, original, changed);

      // B a fost deconectat; A (sesiunea care a schimbat parola) rămâne conectat.
      await pageB.goto("/dashboard");
      await expect(pageB).toHaveURL(/\/login\?next=%2Fdashboard$/);
      await pageA.goto("/dashboard");
      await expect(pageA).toHaveURL(/\/dashboard$/);

      // Parola veche nu mai merge; cea nouă da.
      await login(pageB, email, original);
      await expect(pageB.getByRole("alert").filter({ hasText: "greșită" })).toBeVisible();
      await loginOk(pageB, email, changed);
    } finally {
      // Revenire la parola inițială, ca testul să rămână repetabil.
      const c = await browser.newContext({ baseURL });
      const pageC = await c.newPage();
      await login(pageC, email, changed);
      // Dacă parola nu apucase să fie schimbată, login-ul eșuează și nu e nimic de refăcut.
      if (
        await pageC.waitForURL(/\/dashboard$/, { timeout: 15_000 }).then(
          () => true,
          () => false,
        )
      ) {
        await changePassword(pageC, changed, original);
      }
      await c.close();
      await a.close();
      await b.close();
    }
  });

  test("lista de sesiuni: revocare individuală și „Deconectează celelalte”", async ({
    browser,
    baseURL,
  }) => {
    const email = userEmail("sesiuni");
    const a = await browser.newContext({ baseURL });
    const b = await browser.newContext({
      baseURL,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/140.0",
    });
    try {
      const pageA = await a.newPage();
      const pageB = await b.newPage();
      await loginOk(pageA, email, password());
      // Curățenie: sesiunile rămase de la rulări anterioare.
      await pageA.goto("/profile");
      const others = pageA.getByRole("button", { name: "Deconectează celelalte" });
      if (await others.isVisible()) {
        await others.click();
        await pageA.getByRole("button", { name: "Da, revocă" }).click();
        await expect(pageA.getByText("Nu există alte sesiuni active.")).toBeVisible();
      }
      await loginOk(pageB, email, password());

      await pageA.goto("/profile");
      const rows = pageA.getByTestId("session-row");
      await expect(rows).toHaveCount(2);
      await expect(pageA.locator('[data-testid="session-row"][data-current="true"]')).toHaveCount(
        1,
      );
      await expect(pageA.getByText("Sesiunea curentă")).toBeVisible();
      await expect(rows.filter({ hasText: "Firefox pe Linux" }).first()).toBeVisible();

      // Revocarea individuală a sesiunii lui B (cere confirmare).
      const rowB = rows.filter({ hasText: "Firefox pe Linux" }).first();
      await rowB.getByRole("button", { name: /^Revocă/ }).click();
      await rowB.getByRole("button", { name: "Anulează" }).click();
      await rowB.getByRole("button", { name: /^Revocă/ }).click();
      await rowB.getByRole("button", { name: "Da, revocă" }).click();
      await expect(pageA.getByText("Sesiunea a fost închisă.")).toBeVisible();
      await pageB.goto("/dashboard");
      await expect(pageB).toHaveURL(/\/login\?next=%2Fdashboard$/);

      // „Deconectează celelalte”.
      await loginOk(pageB, email, password());
      await pageA.goto("/profile");
      await pageA.getByRole("button", { name: "Deconectează celelalte" }).click();
      await pageA.getByRole("button", { name: "Da, revocă" }).click();
      await expect(pageA.getByText("O sesiune a fost închisă.")).toBeVisible();
      await expect(pageA.getByText("Nu există alte sesiuni active.")).toBeVisible();
      await pageB.goto("/dashboard");
      await expect(pageB).toHaveURL(/\/login\?next=%2Fdashboard$/);
      await pageA.goto("/dashboard");
      await expect(pageA).toHaveURL(/\/dashboard$/);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
