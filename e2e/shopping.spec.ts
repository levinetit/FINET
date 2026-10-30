import { createHash, randomUUID } from "node:crypto";

import { type Browser, type BrowserContext, type Page, expect } from "@playwright/test";
import postgres from "postgres";

import { MODE, type UserKind, loginOk, password, userEmail, test } from "./fixtures";

/**
 * Listele de cumpărături în browser (F10-A, proiectul `shopping`; ADR 0022). Bonul CONFIRMAT este
 * SINTETIC și se inserează direct în baza de test (rolul `finet_app`, cu contextul RLS al
 * utilizatorului), ca testul să nu depindă de worker sau de serverul AI fals. Scenarii:
 * (a) listă nouă din interfață → articole → bifare la raft (persistă după reîncărcare);
 * (b) o listă PERSONALĂ nu e vizibilă altei gospodării (404 uniform pe toate rutele de citire);
 * (c) comparația cu un bon sintetic confirmat: potrivite / neplanificate / uitate, apoi ecranul
 *     „Comparație cu bonul”;
 * (d) zero încălcări CSP pe paginile noi.
 * Utilizatori: `shopping` (gospodăria lui) și `shopping2` (altă gospodărie, pentru izolare).
 * Actualizarea live între doi membri ai aceleiași gospodării e acoperită de testul de integrare
 * `shopping-api.test.ts` („evenimente live”): aici nu există un al doilea membru fără invitație.
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

type Seed = { userId: string; householdId: string; accountId: string };

async function ids(page: Page, baseURL: string): Promise<Seed> {
  const headers = { Origin: new URL(baseURL).origin };
  const me = await page.request.get("/api/v1/me");
  const userId = ((await me.json()) as { data: { user: { id: string } } }).data.user.id;
  const hh = await page.request.get("/api/v1/households");
  const households = ((await hh.json()) as { data: { id: string; current: boolean }[] }).data;
  const householdId = (households.find((h) => h.current) ?? households[0]!).id;
  const acc = await page.request.post("/api/v1/accounts", {
    headers,
    data: { name: unique("Card liste"), type: "bank", currency: "RON" },
  });
  expect(acc.status(), await acc.text()).toBe(201);
  const accountId = ((await acc.json()) as { data: { id: string } }).data.id;
  return { userId, householdId, accountId };
}

/** Un bon confirmat sintetic (document + tranzacție + bon + linii), ca `finet_app` cu RLS. */
async function seedReceipt(seed: Seed, lines: { name: string; total: number }[]): Promise<string> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește (baza de test a E2E)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const on = new Date().toISOString().slice(0, 10);
    const total = lines.reduce((s, l) => s + l.total, 0);
    const docId = randomUUID();
    let receiptId = "";
    await sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${seed.userId}, true),
                      set_config('app.household_id', ${seed.householdId}, true)`;
      await tx`insert into finet.documents (id, household_id, kind, status, detected_mime, size_bytes,
          sha256, storage_key, uploaded_by_user_id)
        values (${docId}, ${seed.householdId}, 'receipt', 'done', 'image/jpeg', 10,
          ${createHash("sha256").update(docId).digest("hex")},
          ${`households/${seed.householdId}/documents/${docId}`}, ${seed.userId})`;
      const [t] = await tx<
        { id: string }[]
      >`insert into finet.transactions (household_id, account_id,
          type, amount_minor, currency, occurred_on, description, source, created_by_user_id)
        values (${seed.householdId}, ${seed.accountId}, 'expense', ${Math.max(total, 1)}, 'RON', ${on},
          'Bon sintetic', 'receipt', ${seed.userId}) returning id`;
      const [r] = await tx<{ id: string }[]>`insert into finet.receipts (household_id, document_id,
          status, total_minor, currency, occurred_on, merchant_name, merchant_tax_id, transaction_id)
        values (${seed.householdId}, ${docId}, 'saved', ${total}, 'RON', ${on},
          'LIDL DISCOUNT SRL', 'RO22891860', ${t!.id}) returning id`;
      receiptId = r!.id;
      let position = 0;
      for (const l of lines) {
        position += 1;
        await tx`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name,
            normalized_name, quantity, line_total_minor, kind)
          values (${receiptId}, ${seed.householdId}, ${position}, ${l.name}, ${normalize(l.name)},
            '1', ${l.total}, 'product')`;
      }
    });
    return receiptId;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Numele normalizat al unui produs (aceeași regulă simplă ca în aplicație, pentru nume fără diacritice). */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^a-z0-9.% ]+/g, " ")
    .replace(/(\d)\s*(kg|g|ml|l|buc)\b/g, "$1$2")
    .replace(/ {2,}/g, " ")
    .trim();
}

type Item = { id: string; name: string; checked: boolean };
type ListDetail = { list: { id: string; name: string }; items: Item[] };

test.describe(`liste de cumpărături (${MODE})`, () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL lipsește: bonul sintetic nu se poate insera");
  test.setTimeout(240_000);

  test("(a) listă nouă, articole, bifare la raft; bifarea persistă după reîncărcare", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "shopping");
    const name = unique("Săptămâna");
    await page.goto("/shopping-lists");
    await expect(page.locator("h1")).toHaveCount(1);
    await page.getByTestId("new-list-name").fill(name);
    await page.getByTestId("new-list-submit").click();
    await expect(page).toHaveURL(/\/shopping-lists\/[0-9a-f-]{36}$/);
    for (const item of ["lapte", "paine", "cafea"]) {
      await page.getByTestId("add-item-name").fill(item);
      await page.getByTestId("add-item-submit").click();
      await expect(page.getByRole("list", { name: "Articole" })).toContainText(item);
    }
    // Bifarea e optimistă: așteptăm răspunsul serverului înainte de reîncărcare (altfel cererea se anulează).
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && /\/items\/[0-9a-f-]{36}$/.test(r.url()),
    );
    await page.getByLabel("Bifează: lapte").check();
    expect((await saved).status()).toBe(200);
    await expect(page.getByText("1 din 3 bifate")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Bifează: lapte")).toBeChecked();
    await expect(page.getByLabel("Bifează: paine")).not.toBeChecked();
  });

  test("(b) lista PERSONALĂ nu se vede din altă gospodărie (404 uniform)", async ({
    browser,
    baseURL,
  }) => {
    const owner = await pageAs(browser, baseURL!, "shopping");
    const other = await pageAs(browser, baseURL!, "shopping2");
    const headers = { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" };
    const created = await owner.request.post("/api/v1/shopping-lists", {
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      data: JSON.stringify({ name: unique("Personală"), personal: true, items: [{ name: "ouă" }] }),
    });
    expect(created.status(), await created.text()).toBe(201);
    const detail = ((await created.json()) as { data: ListDetail }).data;
    const id = detail.list.id;
    expect((await owner.request.get(`/api/v1/shopping-lists/${id}`)).status()).toBe(200);
    expect((await other.request.get(`/api/v1/shopping-lists/${id}`)).status()).toBe(404);
    const theirs = await other.request.get("/api/v1/shopping-lists");
    const names = ((await theirs.json()) as { data: { id: string }[] }).data.map((l) => l.id);
    expect(names).not.toContain(id);
  });

  test("(c) comparația cu un bon sintetic confirmat: potrivite, neplanificate, uitate", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "shopping");
    const seed = await ids(page, baseURL!);
    const headers = { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" };
    const created = await page.request.post("/api/v1/shopping-lists", {
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      data: JSON.stringify({
        name: unique("Cumpărături"),
        items: [{ name: "lapte" }, { name: "pâine" }, { name: "cafea" }],
      }),
    });
    expect(created.status(), await created.text()).toBe(201);
    const listId = ((await created.json()) as { data: ListDetail }).data.list.id;
    const receiptId = await seedReceipt(seed, [
      { name: "LAPTE ZUZU 1,5% 1L", total: 749 },
      { name: "PAINE FELIATA 500G", total: 399 },
      { name: "SAMPON HAIR 400ML", total: 1899 },
    ]);
    const run = await page.request.post(`/api/v1/shopping-lists/${listId}/comparisons`, {
      headers,
      data: JSON.stringify({ receiptId }),
    });
    expect(run.status(), await run.text()).toBe(200);
    const view = (
      (await run.json()) as {
        data: {
          matched: { item: { name: string } }[];
          unplanned: { name: string }[];
          forgotten: { name: string }[];
        };
      }
    ).data;
    expect(view.matched.map((m) => m.item.name).sort()).toEqual(["lapte", "pâine"]);
    expect(view.unplanned.map((l) => l.name)).toEqual(["SAMPON HAIR 400ML"]);
    expect(view.forgotten.map((i) => i.name)).toEqual(["cafea"]);

    await page.goto(`/shopping-lists/${listId}/compare?receipt=${receiptId}`);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: /^Potrivite/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Neplanificate/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Uitate/ })).toBeVisible();
    await expect(page.getByTestId("unplanned-line")).toContainText("SAMPON HAIR 400ML");
  });

  test("(d) zero încălcări CSP pe paginile noi", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL!, "shopping");
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) violations.push(m.text());
    });
    await page.goto("/shopping-lists");
    await page.getByTestId("new-list-name").fill(unique("CSP"));
    await page.getByTestId("new-list-submit").click();
    await expect(page).toHaveURL(/\/shopping-lists\/[0-9a-f-]{36}$/);
    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });
});
