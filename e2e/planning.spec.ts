import { readFile } from "node:fs/promises";

import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "@playwright/test";

import { formatMoney, money } from "../src/lib/money";

import { MODE, type UserKind, loginOk, password, userEmail } from "./fixtures";

/**
 * Planificarea în browser (F3-C, proiectul `planning`): dashboard-ul cu date, selectorul de lună,
 * bugetele cu semafor, obiectivele cu contribuții, etichetele și filtrele, exportul CSV, izolarea,
 * CSP-ul paginilor noi și accesibilitatea de bază. Serverul e `next dev` pe Postgres-ul de test
 * migrat (ca `ledger`), în modul `E2E_APP_MODE`, cu utilizatorii `planning` și `planning2`.
 *
 * Testele se pot relua pe aceeași bază (CI reîncearcă o dată): nume cu sufix unic (inclusiv o
 * categorie nouă per rulare pentru buget: un buget general per monedă ar da 409 la reluare) și
 * verificări pe diferențe sau pe valorile citite din API. Luna vine din răspunsul API-ului (fusul
 * gospodăriei), nu din ceasul mașinii de test. Exporturile: puține per rulare (10/min).
 */

const RUN = `${MODE}-${Date.now().toString(36)}`;
let seq = 0;
const unique = (prefix: string) => `${prefix} ${RUN}-${++seq}`;
const ron = (minor: number) => formatMoney(money(BigInt(minor), "RON"));

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
  const ctx = await browser.newContext({ baseURL, storageState: state, acceptDownloads: true });
  return ctx.newPage();
}

function api(page: Page, baseURL: string) {
  const request: APIRequestContext = page.request;
  const headers = { Origin: new URL(baseURL).origin };
  return {
    async post<T>(path: string, data: unknown, extra: Record<string, string> = {}): Promise<T> {
      const r = await request.post(path, { data, headers: { ...headers, ...extra } });
      expect([200, 201], `${path}: ${await r.text()}`).toContain(r.status());
      return ((await r.json()) as { data: T }).data;
    },
    async get<T>(path: string): Promise<T> {
      const r = await request.get(path);
      expect(r.status(), path).toBe(200);
      return ((await r.json()) as { data: T }).data;
    },
  };
}

type Account = { id: string; name: string };
type Category = { id: string; name: string };
type Tag = { id: string; name: string };
type Totals = { incomeMinor: number; expenseMinor: number; netMinor: number };
type Dashboard = {
  month: string;
  previousMonth: string;
  currencies: { currency: string; totals: Totals }[];
};

async function currentMonth(page: Page, baseURL: string): Promise<string> {
  return (await api(page, baseURL).get<Dashboard>("/api/v1/dashboard")).month;
}

async function ronTotals(page: Page, baseURL: string, month: string): Promise<Totals> {
  const d = await api(page, baseURL).get<Dashboard>(`/api/v1/dashboard?month=${month}`);
  return (
    d.currencies.find((c) => c.currency === "RON")?.totals ?? {
      incomeMinor: 0,
      expenseMinor: 0,
      netMinor: 0,
    }
  );
}

async function newAccount(page: Page, baseURL: string): Promise<Account> {
  return api(page, baseURL).post<Account>("/api/v1/accounts", {
    name: unique("Plan"),
    type: "bank",
    currency: "RON",
  });
}

test.describe(`planificarea (${MODE})`, () => {
  test("(a) dashboard: totalurile lunii, comparația și selectorul de lună", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "planning");
    const client = api(page, baseURL!);
    const month = await currentMonth(page, baseURL!);
    const before = await ronTotals(page, baseURL!, month);
    const account = await newAccount(page, baseURL!);
    for (const [type, amountMinor] of [
      ["income", 100000],
      ["expense", 25050],
    ] as const) {
      await client.post("/api/v1/transactions", {
        accountId: account.id,
        type,
        amountMinor,
        occurredOn: `${month}-01`,
        description: unique("dash"),
      });
    }
    const after = await ronTotals(page, baseURL!, month);
    expect(after.incomeMinor - before.incomeMinor).toBe(100000);
    expect(after.expenseMinor - before.expenseMinor).toBe(25050);

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Acasă" })).toBeVisible();
    const summary = page.getByTestId("summary-RON");
    await expect(summary.getByTestId("stat-income").getByTestId("stat-value")).toHaveText(
      ron(after.incomeMinor),
    );
    await expect(summary.getByTestId("stat-expense").getByTestId("stat-value")).toHaveText(
      ron(after.expenseMinor),
    );
    await expect(summary.getByTestId("stat-net").getByTestId("stat-value")).toHaveText(
      ron(after.netMinor),
    );
    // Comparația: procent cu semn sau „—” (luna anterioară fără date).
    await expect(summary.getByTestId("stat-income").getByTestId("stat-delta")).toHaveText(
      /^(↑ \+|↓ −|→ )?\d+%$|—/,
    );
    await expect(page.getByTestId("category-chart")).toBeVisible();
    await expect(page.getByTestId("monthly-chart")).toHaveAttribute("role", "img");

    // Selectorul de lună: luna anterioară, în URL.
    const d = await client.get<Dashboard>("/api/v1/dashboard");
    await page.getByLabel("Luna").selectOption(d.previousMonth);
    await page.getByRole("button", { name: "Arată luna" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard\\?month=${d.previousMonth}$`));
    await expect(page.getByLabel("Luna")).toHaveValue(d.previousMonth);
    // O lună viitoare sau prea veche: luna curentă și un mesaj, nu o eroare.
    const response = await page.goto("/dashboard?month=2999-01");
    expect(response?.status()).toBe(200);
    await expect(page.getByText("Luna cerută nu e disponibilă")).toBeVisible();
    await expect(page.getByLabel("Luna")).toHaveValue(month);
  });

  test("(b) buget pe categorie: semaforul trece din verde în galben și roșu", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "planning");
    const client = api(page, baseURL!);
    const month = await currentMonth(page, baseURL!);
    const categoryName = unique("Buget");
    const category = await client.post<Category>("/api/v1/categories", {
      name: categoryName,
      kind: "expense",
    });
    const account = await newAccount(page, baseURL!);

    await page.goto("/budgets/new");
    await page.getByLabel("Categoria").selectOption({ label: categoryName });
    await page.getByLabel(/^Limita lunară/).fill("100");
    await page.getByLabel("Prag de avertizare (%)").fill("80");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page).toHaveURL(/\/budgets$/);

    const line = page.locator('[data-testid="budget-line"]', { hasText: categoryName });
    await expect(line).toHaveAttribute("data-status", "green");
    await expect(line.getByTestId("budget-status")).toHaveText("În limită");

    const spend = (amountMinor: number) =>
      client.post("/api/v1/transactions", {
        accountId: account.id,
        type: "expense",
        amountMinor,
        occurredOn: `${month}-01`,
        categoryId: category.id,
      });
    await spend(8500);
    await page.reload();
    await expect(line).toHaveAttribute("data-status", "yellow");
    await expect(line.getByTestId("budget-percent")).toHaveText("85%");
    await expect(page.getByTestId("budget-alert")).toBeVisible();

    await spend(2000);
    await page.reload();
    await expect(line).toHaveAttribute("data-status", "red");
    await expect(line.getByTestId("budget-status")).toHaveText("Depășit");
    await page.goto("/dashboard");
    await expect(page.getByTestId("budget-alert")).toBeVisible();
  });

  test("(c) obiectiv: contribuții cu Idempotency-Key până la „Atins”", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "planning");
    const name = unique("Vacanță");
    await page.goto("/goals/new");
    await page.getByLabel("Numele obiectivului").fill(name);
    await page.getByLabel(/^Ținta/).fill("500");
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page).toHaveURL(/\/goals$/);
    await page.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

    const keys: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/contributions")) {
        keys.push(r.headers()["idempotency-key"] ?? "");
      }
    });
    const amount = page.getByLabel(/^Suma \(RON\)/);
    await amount.fill("200");
    await page.getByRole("button", { name: "Adaugă", exact: true }).click();
    await expect(page.getByText("Contribuția a fost înregistrată.")).toBeVisible();
    await expect(page.getByTestId("goal-progress").first()).toHaveText("40%");
    await amount.fill("300");
    await page.getByRole("button", { name: "Adaugă", exact: true }).click();
    await expect(page.getByTestId("goal-status").first()).toHaveText("Atins");
    await expect(page.getByTestId("goal-progress").first()).toHaveText("100%");
    // Scăderea sub zero: mesaj clar, nicio modificare.
    await amount.fill("9999");
    await page.getByRole("button", { name: "Scade", exact: true }).click();
    await expect(page.getByText("Nu poți scoate mai mult decât ai economisit.")).toBeVisible();

    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(new Set(keys).size).toBe(3);
  });

  test("(d) etichete și filtre: eticheta din formular, filtrul pe etichetă și pe comerciant", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "planning");
    const client = api(page, baseURL!);
    const tagName = unique("Eticheta");
    await page.goto("/tags");
    await page.getByLabel("Numele etichetei").fill(tagName);
    await page.getByRole("button", { name: "Adaugă eticheta" }).click();
    await expect(page.locator(`[data-tag-name="${tagName}"]`)).toBeVisible();
    const tag = (await client.get<Tag[]>("/api/v1/tags")).find((t) => t.name === tagName)!;

    const account = await newAccount(page, baseURL!);
    const merchant = unique("Magazin").replace(/\s/g, "-");
    await client.post("/api/v1/transactions", {
      accountId: account.id,
      type: "expense",
      amountMinor: 1234,
      occurredOn: "2026-10-02",
      merchant,
    });
    // Cu eticheta, din formular.
    const tagged = unique("cu-eticheta").replace(/\s/g, "-");
    await page.goto("/transactions/new?type=expense");
    await page.getByLabel("Contul").selectOption({ label: `${account.name} (RON)` });
    await page.getByLabel(/^Suma \(/).fill("7");
    await page.getByLabel("Descriere").fill(tagged);
    await page.getByTestId("tx-tags").getByLabel(tagName).check();
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page).toHaveURL(/\/transactions$/);

    await page.goto(`/transactions?tagIds=${tag.id}`);
    const rows = page.getByTestId("transaction-row");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(tagged);
    await expect(rows.first().getByTestId("tag-chip")).toHaveText(tagName);

    // Filtrul pe comerciant, din formular (GET): rezultatul exact.
    await page.goto("/transactions");
    await page.getByLabel("Comerciantul").fill(merchant);
    await page.getByRole("button", { name: "Aplică filtrele" }).click();
    await expect(page).toHaveURL(/merchant=/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId("transaction-amount")).toHaveText(`−${ron(1234)}`);
    // Bifa etichetei în filtru + comerciantul: nicio tranzacție nu are ambele.
    await page.getByTestId("filter-tags").getByLabel(tagName).check();
    await page.getByRole("button", { name: "Aplică filtrele" }).click();
    await expect(page.getByTestId("transactions-empty")).toBeVisible();
  });

  test("(e) export CSV: respectă filtrele, antetul, BOM-ul și un rând", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "planning");
    const client = api(page, baseURL!);
    const account = await newAccount(page, baseURL!);
    const merchant = unique("Export").replace(/\s/g, "-");
    await client.post("/api/v1/transactions", {
      accountId: account.id,
      type: "expense",
      amountMinor: 123456,
      occurredOn: "2026-10-03",
      merchant,
    });
    await page.goto(`/transactions?merchant=${encodeURIComponent(merchant)}`);
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/v1/exports/")) requests.push(r.url());
    });
    const download = page.waitForEvent("download");
    await page.getByTestId("export-transactions").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("finet-tranzactii.csv");
    const bytes = await readFile((await file.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString("utf8").split("\r\n").filter(Boolean);
    expect(lines[0]).toMatch(/^id;occurred_on;type;transfer_direction;account_id;account_name;/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(merchant);
    expect(lines[1]).toContain(";1234,56;");
    // Doar cookie-ul: fără token în URL; dialectul românesc și filtrele paginii.
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!);
    expect(url.searchParams.get("dialect")).toBe("ro");
    expect(url.searchParams.get("merchant")).toBe(merchant);
    expect([...url.searchParams.keys()].sort()).toEqual(["dialect", "merchant"]);
  });

  test("(f) izolare: alt utilizator nu vede bugetele, obiectivele, etichetele și exportul", async ({
    browser,
    baseURL,
  }) => {
    const owner = await pageAs(browser, baseURL!, "planning");
    const client = api(owner, baseURL!);
    const secret = unique("Secret").replace(/\s/g, "-");
    const goal = await client.post<{ id: string }>("/api/v1/goals", {
      name: secret,
      targetMinor: 1000,
      currency: "RON",
    });
    const budget = await client.post<{ id: string }>("/api/v1/budgets", {
      categoryId: (
        await client.post<Category>("/api/v1/categories", { name: secret, kind: "expense" })
      ).id,
      amountMinor: 1000,
      currency: "RON",
    });
    await client.post("/api/v1/tags", { name: secret });
    const account = await newAccount(owner, baseURL!);
    await client.post("/api/v1/transactions", {
      accountId: account.id,
      type: "expense",
      amountMinor: 100,
      occurredOn: "2026-10-04",
      merchant: secret,
    });

    const other = await pageAs(browser, baseURL!, "planning2");
    for (const path of [`/goals/${goal.id}`, `/budgets/${budget.id}`]) {
      const response = await other.goto(path);
      expect(response?.status(), path).toBe(404);
    }
    for (const path of ["/goals", "/budgets", "/tags", "/reports"]) {
      await other.goto(path);
      await expect(other.locator("h1")).toBeVisible();
      await expect(other.getByText(secret)).toHaveCount(0);
    }
    const csv = await other.request.get(
      `/api/v1/exports/transactions.csv?merchant=${encodeURIComponent(secret)}&dialect=ro`,
    );
    expect(csv.status()).toBe(200);
    const text = (await csv.body()).subarray(3).toString("utf8");
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(1);
    expect(text).not.toContain(secret);
  });

  test("(g) fără încălcări CSP și fără `style=` pe paginile Fazei 3", async ({
    browser,
    baseURL,
  }) => {
    // `next dev` compilează la prima cerere fiecare pagină nouă.
    test.slow();
    const page = await pageAs(browser, baseURL!, "planning");
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
    const goal = await client.post<{ id: string }>("/api/v1/goals", {
      name: unique("CSP"),
      targetMinor: 1000,
      currency: "RON",
    });
    const budget = await client.post<{ id: string }>("/api/v1/budgets", {
      categoryId: (
        await client.post<Category>("/api/v1/categories", {
          name: unique("CSP"),
          kind: "expense",
        })
      ).id,
      amountMinor: 1000,
      currency: "RON",
    });
    const month = await currentMonth(page, baseURL!);
    for (const path of [
      "/dashboard",
      `/dashboard?month=${month}`,
      "/transactions",
      "/tags",
      "/budgets",
      "/budgets/new",
      `/budgets/${budget.id}`,
      "/goals",
      "/goals/new",
      `/goals/${goal.id}`,
      "/reports",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const csp = response!.headers()["content-security-policy"] ?? "";
      expect(csp, path).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      const html = await response!.text();
      expect(html, path).not.toMatch(/\sstyle\s*=/);
      await expect(page.locator("h1")).toHaveCount(1);
      const seen = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      expect(seen, path).toEqual([]);
    }
    expect(consoleViolations).toEqual([]);
  });

  test("(h) accesibilitate de bază: etichete pe câmpuri, focus vizibil, meniul pe telefon", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "planning");
    for (const path of ["/budgets/new", "/goals/new", "/tags", "/transactions"]) {
      await page.goto(path);
      // Fiecare control vizibil are un nume accesibil (eticheta legată sau aria-label).
      const unlabeled = await page.evaluate(() =>
        [...document.querySelectorAll("main input, main select, main textarea")]
          .filter((el) => (el as HTMLInputElement).type !== "hidden")
          .filter((el) => {
            const e = el as HTMLInputElement;
            return !(e.labels && e.labels.length > 0) && !e.getAttribute("aria-label");
          })
          .map((el) => el.outerHTML.slice(0, 80)),
      );
      expect(unlabeled, path).toEqual([]);
    }
    // Focus vizibil cu tastatura.
    await page.goto("/budgets/new");
    await page.getByLabel("Categoria").focus();
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? getComputedStyle(el).outlineStyle : "none";
    });
    expect(outline).not.toBe("none");

    // Telefon: bara de jos și „Mai mult”.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    const nav = page.getByRole("navigation", { name: "Navigare principală" });
    const more = nav.getByRole("button", { name: "Mai mult" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(nav.getByRole("link", { name: "Etichete" })).toHaveCount(0);
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await nav.getByRole("link", { name: "Etichete" }).click();
    await expect(page).toHaveURL(/\/tags$/);
    await expect(page.getByRole("heading", { level: 1, name: "Etichete" })).toBeVisible();
  });
});
