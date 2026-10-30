import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
} from "@playwright/test";

import { formatMoney, money } from "../src/lib/money";

import { MODE, type UserKind, loginOk, password, userEmail, test } from "./fixtures";

/**
 * Registrul în browser (F2-C, proiectul `ledger`): conturi, tranzacții, transferuri, categorii,
 * filtre și paginare, izolare între gospodării, CSP, consimțământul `usage_stats`. Serverul e
 * `next dev` pe Postgres-ul de test migrat (ca `auth`), în modul `E2E_APP_MODE`.
 *
 * Testele se pot relua pe aceeași bază (CI reîncearcă o dată): numele conturilor și ale
 * categoriilor au un sufix unic, iar verificările sunt pe diferențe, nu pe totaluri absolute.
 */

const RUN = `${MODE}-${Date.now().toString(36)}`;
let seq = 0;
const unique = (prefix: string) => `${prefix} ${RUN}-${++seq}`;

const ron = (minor: bigint) => formatMoney(money(minor, "RON"));
const eur = (minor: bigint) => formatMoney(money(minor, "EUR"));

// --- Sesiuni (o autentificare per utilizator, apoi `storageState`) ---------------------------

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

/** Cererile API cu cookie-ul sesiunii: mutațiile cer `Origin` = APP_URL (CSRF, ADR 0005). */
function api(page: Page, baseURL: string) {
  const request: APIRequestContext = page.request;
  const headers = { Origin: new URL(baseURL).origin };
  return {
    async post<T>(path: string, data: unknown): Promise<T> {
      const r = await request.post(path, { data, headers });
      expect(r.status(), `${path}: ${await r.text()}`).toBe(201);
      return ((await r.json()) as { data: T }).data;
    },
    async get<T>(path: string): Promise<{ data: T; nextCursor?: string | null }> {
      const r = await request.get(path);
      expect(r.status(), path).toBe(200);
      return (await r.json()) as { data: T; nextCursor?: string | null };
    },
  };
}

type Account = { id: string; name: string; currency: string; balanceMinor: number };
type Category = { id: string; name: string; kind: string; isSystem: boolean };
type Tx = { id: string; categoryId: string | null; description: string | null };

// --- Pași de UI ------------------------------------------------------------------------------

async function createAccount(page: Page, name: string, currency: string, opening: string) {
  await page.goto("/accounts/new");
  await page.getByLabel("Numele contului").fill(name);
  await page.getByLabel("Moneda", { exact: true }).selectOption(currency);
  await page.getByLabel("Soldul inițial").fill(opening);
  await page.getByRole("button", { name: "Salvează" }).click();
  await expect(page).toHaveURL(/\/accounts$/);
}

function balanceOf(page: Page, name: string) {
  return page
    .getByTestId("active-accounts")
    .locator(`[data-account-name="${name}"]`)
    .getByTestId("account-balance");
}

async function addEntry(
  page: Page,
  kind: "Adaugă cheltuială" | "Adaugă venit",
  account: string,
  currency: string,
  amount: string,
  description: string,
) {
  await page.goto("/transactions");
  await page.getByRole("link", { name: kind }).click();
  await expect(page).toHaveURL(/\/transactions\/new\?type=/);
  await page.getByLabel("Contul").selectOption({ label: `${account} (${currency})` });
  await page.getByLabel(/^Suma \(/).fill(amount);
  await page.getByLabel("Descriere").fill(description);
  await page.getByRole("button", { name: "Salvează" }).click();
  await expect(page).toHaveURL(/\/transactions$/);
}

// ---------------------------------------------------------------------------------------------

test.describe(`registrul (${MODE})`, () => {
  test("(a) cont cu sold inițial, o cheltuială și un venit → soldul exact, format românesc", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ledger");
    const name = unique("Cont curent");
    await createAccount(page, name, "RON", "1.000,00");
    await expect(balanceOf(page, name)).toHaveText(ron(100000n));

    await addEntry(page, "Adaugă cheltuială", name, "RON", "250,50", unique("Cumpărături"));
    await addEntry(page, "Adaugă venit", name, "RON", "1.234,56", unique("Salariu"));
    // Transferurile și tranzacțiile apar în listă; soldul = 1000 − 250,50 + 1234,56.
    await page.goto("/accounts");
    await expect(balanceOf(page, name)).toHaveText(ron(100000n - 25050n + 123456n));
    await expect(balanceOf(page, name)).toHaveText("1.984,06 lei");
  });

  test("(b) transfer RON→RON: ambele solduri se schimbă, totalul nu; RON→EUR cu două sume", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ledger");
    const a = unique("Card");
    const b = unique("Economii");
    const c = unique("Euro");
    await createAccount(page, a, "RON", "500");
    await createAccount(page, b, "RON", "0");
    await createAccount(page, c, "EUR", "0");
    const totalRon = page.getByTestId("total-RON").locator("dd");
    const before = await totalRon.textContent();

    await page.goto("/transfers/new");
    await page.getByLabel("Din contul").selectOption({ label: `${a} (RON)` });
    await page.getByLabel("În contul").selectOption({ label: `${b} (RON)` });
    await page.getByLabel(/^Suma \(RON\)/).fill("120,25");
    await page.getByRole("button", { name: "Fă transferul" }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page.getByTestId("transfer-badge").first()).toBeVisible();

    await page.goto("/accounts");
    await expect(balanceOf(page, a)).toHaveText(ron(50000n - 12025n));
    await expect(balanceOf(page, b)).toHaveText(ron(12025n));
    await expect(totalRon).toHaveText(before!);

    await page.goto("/transfers/new");
    await page.getByLabel("Din contul").selectOption({ label: `${a} (RON)` });
    await page.getByLabel("În contul").selectOption({ label: `${c} (EUR)` });
    await page.getByLabel("Suma trimisă (RON)").fill("100");
    await page.getByLabel("Suma primită (EUR)").fill("19,80");
    await page.getByRole("button", { name: "Fă transferul" }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await page.goto("/accounts");
    await expect(balanceOf(page, a)).toHaveText(ron(50000n - 12025n - 10000n));
    await expect(balanceOf(page, c)).toHaveText(eur(1980n));

    // Ștergerea transferului elimină ambele rânduri: soldurile revin.
    const transfers = await api(page, baseURL!).get<
      { id: string; type: string; accountId: string }[]
    >("/api/v1/transactions?type=transfer&limit=100");
    const accounts = await api(page, baseURL!).get<Account[]>("/api/v1/accounts");
    const cId = accounts.data.find((x) => x.name === c)!.id;
    const leg = transfers.data.find((t) => t.accountId === cId)!;
    await page.goto(`/transactions/${leg.id}`);
    await expect(page.getByTestId("transfer-to-amount")).toHaveText(eur(1980n));
    await page.getByRole("button", { name: "Șterge transferul" }).click();
    await page.getByRole("button", { name: "Da, șterge" }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await page.goto("/accounts");
    await expect(balanceOf(page, a)).toHaveText(ron(50000n - 12025n));
    await expect(balanceOf(page, c)).toHaveText(eur(0n));
  });

  test("(c) o sumă ambiguă (1.234) e refuzată cu mesaj, fără cerere", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ledger");
    const name = unique("Ambiguu");
    await createAccount(page, name, "RON", "0");
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/v1/transactions")) posts.push(r.url());
    });
    await page.goto("/transactions/new?type=expense");
    await page.getByLabel("Contul").selectOption({ label: `${name} (RON)` });
    await page.getByLabel(/^Suma \(/).fill("1.234");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page.getByTestId("tx-amount-error")).toHaveText(
      "Suma este ambiguă. Scrie zecimalele cu virgulă, de exemplu 1234,50.",
    );
    await expect(page.getByLabel(/^Suma \(/)).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/transactions\/new/);
    expect(posts).toEqual([]);
  });

  test("(d) dublu-clic pe „Salvează” creează o singură tranzacție", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ledger");
    const name = unique("Dublu");
    await createAccount(page, name, "RON", "0");
    const description = unique("dublu-clic").replace(/\s/g, "-");
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/api/v1/transactions")) {
        posts.push(r.headers()["idempotency-key"] ?? "");
      }
    });
    await page.goto("/transactions/new?type=expense");
    await page.getByLabel("Contul").selectOption({ label: `${name} (RON)` });
    await page.getByLabel(/^Suma \(/).fill("10");
    await page.getByLabel("Descriere").fill(description);
    await page.getByRole("button", { name: "Salvează" }).dblclick();
    await expect(page).toHaveURL(/\/transactions$/);
    const found = await api(page, baseURL!).get<Tx[]>(
      `/api/v1/transactions?q=${encodeURIComponent(description)}`,
    );
    expect(found.data).toHaveLength(1);
    // Cel mult o cerere; cheia de idempotență are formatul cerut de server.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  test("(e) filtre și „Încarcă mai mult”: 55 de rânduri, fără duplicate", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const page = await pageAs(browser, baseURL!, "seed");
    const client = api(page, baseURL!);
    const account = await client.post<Account>("/api/v1/accounts", {
      name: unique("Seed"),
      type: "bank",
      currency: "RON",
    });
    const tag = `seed${RUN.replace(/[^a-z0-9]/gi, "")}`;
    for (let i = 1; i <= 55; i++) {
      await client.post("/api/v1/transactions", {
        accountId: account.id,
        type: "expense",
        amountMinor: 100 * i,
        occurredOn: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
        description: `${tag} ${i}`,
      });
    }
    await page.goto(`/transactions?q=${tag}`);
    const rows = page.getByTestId("transaction-row");
    await expect(rows).toHaveCount(50);
    await page.getByRole("button", { name: "Încarcă mai mult" }).click();
    await expect(rows).toHaveCount(55);
    await expect(page.getByRole("button", { name: "Încarcă mai mult" })).toHaveCount(0);
    const hrefs = await rows
      .locator("a")
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(new Set(hrefs).size).toBe(55);

    // Filtrul de sumă (10,00–20,00 lei) și tipul.
    await page.goto(`/transactions?q=${tag}&amountMin=10&amountMax=20,00&sort=amount_asc`);
    await expect(rows).toHaveCount(11);
    await expect(rows.first().getByTestId("transaction-amount")).toHaveText(`−${ron(1000n)}`);
    await page.goto(`/transactions?q=${tag}&type=income`);
    await expect(page.getByTestId("transactions-empty")).toHaveText(
      "Nicio tranzacție nu corespunde filtrelor.",
    );
    // O sumă ambiguă în filtru: mesaj la câmp, fără eroare de server.
    await page.goto(`/transactions?q=${tag}&amountMin=1.234`);
    await expect(page.getByTestId("filter-amount-min-error")).toBeVisible();
  });

  test("(f) categorii: ascunde una de sistem, creează una personalizată, șterge cu reasignare", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ledger");
    await page.goto("/categories");
    const system = page.locator('[data-testid="category-row"][data-category-name="Divertisment"]');
    await system.getByRole("button", { name: "Ascunde: Divertisment" }).click();
    await expect(system.getByTestId("hidden-badge")).toBeVisible();
    await system.getByRole("button", { name: "Afișează: Divertisment" }).click();
    await expect(system.getByTestId("hidden-badge")).toHaveCount(0);

    const first = unique("Hobby");
    const second = unique("Pasiuni");
    for (const name of [first, second]) {
      await page.getByLabel("Numele categoriei").fill(name);
      await page.getByLabel("Tipul").selectOption("expense");
      await page.getByRole("button", { name: "Adaugă categoria" }).click();
      await expect(page.locator(`[data-category-name="${name}"]`)).toBeVisible();
    }
    const client = api(page, baseURL!);
    const cats = await client.get<Category[]>("/api/v1/categories?kind=expense");
    const firstId = cats.data.find((x) => x.name === first)!.id;
    const secondId = cats.data.find((x) => x.name === second)!.id;
    const account = await client.post<Account>("/api/v1/accounts", {
      name: unique("Categorii"),
      type: "cash",
      currency: "RON",
    });
    const tx = await client.post<Tx>("/api/v1/transactions", {
      accountId: account.id,
      type: "expense",
      amountMinor: 999,
      occurredOn: "2026-10-01",
      categoryId: firstId,
    });

    const row = page.locator(`[data-category-name="${first}"]`);
    await row.getByRole("button", { name: "Șterge" }).click();
    await row.getByLabel("Mută tranzacțiile în").selectOption({ label: second });
    await row.getByRole("button", { name: "Da, șterge" }).click();
    await expect(
      page.getByText("Categoria a fost ștearsă; o tranzacție a fost mutată."),
    ).toBeVisible();
    await expect(page.locator(`[data-category-name="${first}"]`)).toHaveCount(0);
    const moved = await client.get<Tx>(`/api/v1/transactions/${tx.id}`);
    expect(moved.data.categoryId).toBe(secondId);
  });

  test("(g) izolare: al doilea utilizator nu vede conturile primului; URL străin → 404", async ({
    browser,
    baseURL,
  }) => {
    const owner = await pageAs(browser, baseURL!, "ledger");
    const secret = unique("Secret");
    const account = await api(owner, baseURL!).post<Account>("/api/v1/accounts", {
      name: secret,
      type: "bank",
      currency: "RON",
      openingBalanceMinor: 4242,
    });
    const tx = await api(owner, baseURL!).post<Tx>("/api/v1/transactions", {
      accountId: account.id,
      type: "expense",
      amountMinor: 100,
      occurredOn: "2026-10-01",
      description: secret,
    });

    const other = await pageAs(browser, baseURL!, "ledger2");
    await other.goto("/accounts");
    await expect(other.getByRole("heading", { level: 1, name: "Conturi" })).toBeVisible();
    await expect(other.getByText(secret)).toHaveCount(0);
    await other.goto(`/transactions?q=${encodeURIComponent(secret)}`);
    await expect(other.getByText(secret)).toHaveCount(0);
    for (const path of [`/accounts/${account.id}`, `/transactions/${tx.id}`]) {
      const response = await other.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(other.getByRole("heading", { name: "Pagina nu există" })).toBeVisible();
    }
    expect((await other.request.get(`/api/v1/accounts/${account.id}`)).status()).toBe(404);
  });

  test("(h) fără încălcări CSP și fără `style=` pe paginile noi", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL!, "ledger");
    await page.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    const consoleViolations: string[] = [];
    page.on("console", (m) => {
      if (/content security policy/i.test(m.text())) consoleViolations.push(m.text());
    });
    const client = api(page, baseURL!);
    const account = await client.post<Account>("/api/v1/accounts", {
      name: unique("CSP"),
      type: "bank",
      currency: "RON",
    });
    const tx = await client.post<Tx>("/api/v1/transactions", {
      accountId: account.id,
      type: "income",
      amountMinor: 500,
      occurredOn: "2026-10-02",
    });
    for (const path of [
      "/dashboard",
      "/accounts",
      "/accounts/new",
      `/accounts/${account.id}`,
      "/transactions",
      "/transactions/new?type=expense",
      `/transactions/${tx.id}`,
      "/transfers/new",
      "/categories",
      "/profile",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const csp = response!.headers()["content-security-policy"] ?? "";
      expect(csp, path).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      const html = await response!.text();
      expect(html, path).not.toMatch(/\sstyle\s*=/);
      await expect(page.locator("h1")).toBeVisible();
      const seen = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      expect(seen, path).toEqual([]);
    }
    expect(consoleViolations).toEqual([]);
  });

  test("(i) /profile: `usage_stats` pornește și oprește antetul X-FINET-Client", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "ledger");
    await page.goto("/profile");
    const toggle = page.getByRole("switch", { name: "Trimite statistici anonime de utilizare" });
    await expect(toggle).toBeEnabled();
    // Pornim mereu din starea „oprit” (testul se poate relua).
    // Bifa se schimbă abia după răspunsul serverului: `click()` + așteptarea stării (nu `check()`).
    if (await toggle.isChecked()) {
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByText("Statisticile de utilizare sunt dezactivate.")).toBeVisible();
    }

    async function profileSaveHeader(): Promise<string | undefined> {
      const request = page.waitForRequest(
        (r) => r.method() === "PATCH" && r.url().endsWith("/api/v1/me"),
      );
      await page.getByRole("button", { name: "Salvează" }).click();
      const header = (await request).headers()["x-finet-client"];
      await expect(page.getByText("Modificările au fost salvate.")).toBeVisible();
      return header;
    }

    expect(await profileSaveHeader()).toBeUndefined();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Statisticile de utilizare sunt activate.")).toBeVisible();
    expect(await profileSaveHeader()).toMatch(
      /^platform=web; installation=[0-9a-f-]{36}; locale=ro-RO$/,
    );
    // După reîncărcare, starea vine de la server.
    await page.reload();
    await expect(toggle).toBeChecked();
    expect(await profileSaveHeader()).toMatch(/^platform=web; /);

    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText("Statisticile de utilizare sunt dezactivate.")).toBeVisible();
    expect(await profileSaveHeader()).toBeUndefined();
  });
});
