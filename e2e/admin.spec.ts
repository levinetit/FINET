import { type Browser, type BrowserContext, type Page, expect } from "@playwright/test";

import { MODE, type UserKind, loginOk, password, test, userEmail } from "./fixtures";

/**
 * Feedback, anunțuri și panoul de administrare (Faza 11-B, ADR 0028; proiectul `admin`). Doar `saas`:
 * în `personal` rutele nu există (404). Primul utilizator creat cu CLI-ul `create-user` devine
 * administratorul platformei; CI creează utilizatorii întâi pentru `personal`, deci administratorul e
 * `e2e-main-personal` (baza e comună celor două moduri); `ask` e un utilizator obișnuit. Scenarii:
 * (a) un utilizator obișnuit primește 404 pe `/admin` și pe rutele API de administrare;
 * (b) trimite feedback, iar administratorul îl vede în panou;
 * (c) administratorul creează un anunț, utilizatorul îl vede, apoi administratorul îl arhivează.
 */

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const states = new Map<UserKind | "admin", StorageState>();

/** Primul utilizator creat de CI (modul `personal`) = administratorul platformei, în ambele moduri. */
const ADMIN_EMAIL = "e2e-main-personal@finet.test";

async function pageAs(browser: Browser, baseURL: string, kind: UserKind | "admin"): Promise<Page> {
  let state = states.get(kind);
  if (!state) {
    const ctx = await browser.newContext({ baseURL });
    const p = await ctx.newPage();
    await loginOk(p, kind === "admin" ? ADMIN_EMAIL : userEmail(kind), password());
    state = await ctx.storageState();
    states.set(kind, state);
    await ctx.close();
  }
  const ctx = await browser.newContext({ baseURL, storageState: state });
  return ctx.newPage();
}

const unique = (p: string) =>
  `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test.describe(`administrare (${MODE})`, () => {
  test.setTimeout(180_000);

  if (MODE === "personal") {
    test("în personal: /admin și /feedback nu există (404)", async ({ browser, baseURL }) => {
      const page = await pageAs(browser, baseURL!, "main");
      for (const path of ["/admin", "/feedback"]) {
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(404);
      }
      const api = await page.request.get("/api/v1/admin/users");
      expect(api.status()).toBe(404);
    });
    return;
  }

  test("(a) un utilizator obișnuit: 404 pe /admin și pe rutele API de administrare", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ask");
    expect((await page.goto("/admin"))?.status()).toBe(404);
    for (const path of [
      "/api/v1/admin/users",
      "/api/v1/admin/households",
      "/api/v1/admin/jobs",
      "/api/v1/admin/feedback",
      "/api/v1/admin/errors",
      "/api/v1/admin/announcements",
    ]) {
      expect((await page.request.get(path)).status(), path).toBe(404);
    }
  });

  test("(b) feedback trimis de utilizator, văzut de administrator", async ({
    browser,
    baseURL,
  }) => {
    const message = unique("Mesaj de test");
    const user = await pageAs(browser, baseURL!, "ask");
    await user.goto("/feedback");
    await user.getByTestId("feedback-message").fill(message);
    await user.getByTestId("feedback-submit").click();
    await expect(user.getByText("Mesajul a fost trimis.")).toBeVisible();

    const admin = await pageAs(browser, baseURL!, "admin");
    await admin.goto("/admin");
    await expect(
      admin.getByRole("heading", { level: 1, name: "Panou de administrare" }),
    ).toBeVisible();
    await expect(admin.getByTestId("admin-feedback-list")).toContainText(message);
    await expect(admin.getByTestId("admin-users-list")).toContainText(userEmail("ask"));
  });

  test("(c) anunț creat de administrator, văzut de utilizator, apoi arhivat", async ({
    browser,
    baseURL,
  }) => {
    const title = unique("Anunț");
    const admin = await pageAs(browser, baseURL!, "admin");
    await admin.goto("/admin");
    await admin.getByTestId("ann-title").fill(title);
    await admin.getByTestId("ann-body").fill("Mentenanță programată.");
    await admin.getByTestId("ann-submit").click();
    await expect(admin.getByText(title)).toBeVisible();

    const user = await pageAs(browser, baseURL!, "ask");
    await user.goto("/dashboard");
    await expect(user.getByTestId("announcements")).toContainText(title);

    const row = admin.getByRole("listitem").filter({ hasText: title });
    await row.getByRole("button", { name: "Arhivează" }).click();
    await expect(row).toContainText("arhivat");
    await user.reload();
    await expect(user.getByText(title)).toHaveCount(0);
  });
});
