import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";

import { MODE, type UserKind, loginOk, password, userEmail } from "./fixtures";

/**
 * „Întreabă FINET” și rezumatul lunii în browser (F10-C, proiectul `ask`; ADR 0025). Datele se
 * creează prin API (un cont, o cheltuială și un venit în luna curentă). Scenarii:
 * (a) întrebare înțeleasă: răspuns cu suma exactă și interogarea folosită;
 * (b) întrebare neînțeleasă: mesaj clar, fără presupuneri; (c) un exemplu se rulează cu un click;
 * (d) rezumatul lunii pe `/reports`, cu eticheta fixă; (e) zero încălcări CSP.
 */

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const states = new Map<UserKind, StorageState>();

async function pageAs(browser: Browser, baseURL: string, kind: UserKind): Promise<Page> {
  let state = states.get(kind);
  if (!state) {
    const ctx = await browser.newContext({ baseURL });
    const p = await ctx.newPage();
    await loginOk(p, userEmail(kind), password());
    state = await ctx.storageState();
    states.set(kind, state);
    await ctx.close();
  }
  const ctx = await browser.newContext({ baseURL, storageState: state });
  return ctx.newPage();
}

const unique = (p: string) =>
  `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Un cont și două tranzacții în luna curentă (un comerciant cu nume unic, ca să nu se amestece rulările). */
async function seed(page: Page, baseURL: string): Promise<{ merchant: string }> {
  const headers = { Origin: new URL(baseURL).origin };
  const acc = await page.request.post("/api/v1/accounts", {
    headers,
    data: { name: unique("Card ask"), type: "bank", currency: "RON" },
  });
  expect(acc.status(), await acc.text()).toBe(201);
  const accountId = ((await acc.json()) as { data: { id: string } }).data.id;
  const merchant = `Magazin${Date.now().toString(36)}`;
  const today = new Date().toISOString().slice(0, 10);
  for (const body of [
    { type: "expense", amountMinor: 12345, merchant },
    { type: "income", amountMinor: 250000, description: "Venit test" },
  ]) {
    const r = await page.request.post("/api/v1/transactions", {
      headers,
      data: { accountId, occurredOn: today, ...body },
    });
    expect(r.status(), await r.text()).toBe(201);
  }
  return { merchant };
}

test.describe(`Întreabă FINET (${MODE})`, () => {
  test.setTimeout(180_000);

  test("(a) întrebare înțeleasă: suma exactă și interogarea folosită", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ask");
    const { merchant } = await seed(page, baseURL!);
    await page.goto("/ask");
    await expect(page.locator("h1")).toHaveCount(1);
    await page.getByTestId("ask-question").fill(`Cât am cheltuit la ${merchant} luna aceasta?`);
    await page.getByTestId("ask-submit").click();
    await expect(page.getByTestId("ask-text")).toContainText("Ai cheltuit");
    await expect(page.getByTestId("ask-text")).toContainText("123,45");
    await expect(page.getByTestId("ask-query")).toContainText(`comerciantul ${merchant}`);
  });

  test("(b) întrebare neînțeleasă: mesaj clar, fără răspuns inventat", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ask");
    await page.goto("/ask");
    await page.getByTestId("ask-question").fill("Ce vreme e mâine?");
    await page.getByTestId("ask-submit").click();
    await expect(page.getByTestId("ask-not-understood")).toContainText("Nu am înțeles");
    await expect(page.getByTestId("ask-answer")).toHaveCount(0);
  });

  test("(c) un exemplu se rulează cu un click", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL!, "ask");
    await page.goto("/ask");
    await page.getByRole("button", { name: "Cât am încasat anul acesta?" }).click();
    await expect(page.getByTestId("ask-text")).toContainText("Ai încasat");
    await expect(page.getByTestId("ask-question")).toHaveValue("Cât am încasat anul acesta?");
  });

  test("(d) rezumatul lunii pe /reports, cu eticheta fixă", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL!, "ask");
    await page.goto("/reports");
    const card = page.getByTestId("report-summary");
    await expect(card).toBeVisible();
    await expect(card).toContainText("ai cheltuit");
    await expect(page.getByTestId("report-summary-label")).toHaveText(
      "Rezumat automat, nu sfat financiar.",
    );
  });

  test("(e) zero încălcări CSP pe paginile noi", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL!, "ask");
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto("/ask");
    await page.getByTestId("ask-question").fill("Cât am cheltuit luna aceasta?");
    await page.getByTestId("ask-submit").click();
    await expect(page.getByTestId("ask-answer")).toBeVisible();
    await page.goto("/reports");
    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });
});
