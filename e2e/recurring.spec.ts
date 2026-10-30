import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
} from "@playwright/test";

import { MODE, type UserKind, loginOk, password, userEmail, test } from "./fixtures";

/**
 * Plățile recurente în browser (F5-B, proiectul `recurring`): o regulă lunară cu start în trecut
 * creată din formular → „Generează scadentele” → tranzacțiile apar (cu insigna „recurentă” și
 * filtrul pe sursă), iar o a doua generare nu dublează; pauză → reluare fără generarea lunilor
 * sărite; izolarea (alt utilizator nu vede regula); zero încălcări CSP pe paginile noi.
 *
 * Testele se pot relua pe aceeași bază (CI reîncearcă o dată): un cont nou per scenariu, nume cu
 * sufix unic și verificări pe tranzacțiile contului nou. „Azi” = data din București, calculată cu
 * `Intl` (aceeași regulă ca serverul).
 */

const RUN = `${MODE}-${Date.now().toString(36)}`;
let seq = 0;
const unique = (prefix: string) => `${prefix} ${RUN}-${++seq}`;

/** Data de azi în București, `YYYY-MM-DD`. */
function todayBucharest(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bucharest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Ziua `day` din luna aflată cu `back` luni înaintea lunii lui `date` (`YYYY-MM-DD`). */
function dayMonthsBack(date: string, back: number, day: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 - back;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type Account = { id: string; name: string };
type Rule = { id: string; status: string; nextRunOn: string; description: string };
type Tx = { id: string; source: string; recurringRuleId: string | null; occurredOn: string };

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const states = new Map<UserKind, StorageState>();

/** O pagină autentificată; login-ul o singură dată per utilizator (rate limit pe email). */
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
    async status(path: string): Promise<number> {
      return (await request.get(path)).status();
    },
  };
}

async function newAccount(page: Page, baseURL: string): Promise<Account> {
  return api(page, baseURL).post<Account>("/api/v1/accounts", {
    name: unique("Recurent"),
    type: "bank",
    currency: "RON",
  });
}

async function recurringTxs(page: Page, baseURL: string, accountId: string): Promise<Tx[]> {
  return api(page, baseURL).get<Tx[]>(
    `/api/v1/transactions?source=recurring&accountId=${accountId}&limit=100`,
  );
}

const genKey = () => `e2e-recurring-${RUN}-${++seq}`.replace(/[^A-Za-z0-9_-]/g, "-");

test.describe(`plățile recurente (${MODE})`, () => {
  test("(a) regulă lunară cu start în trecut → Generează → tranzacțiile apar; a doua oară nu dublează", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const page = await pageAs(browser, baseURL!, "recurring");
    const account = await newAccount(page, baseURL!);
    const today = todayBucharest();
    // 1 al lunii de acum două luni: scadențele 1 (luna−2), 1 (luna−1), 1 (luna curentă) ≤ azi.
    const startOn = dayMonthsBack(today, 2, 1);
    const description = unique("Chirie");

    await page.goto("/recurring/new");
    await expect(
      page.getByRole("heading", { level: 1, name: "Regulă recurentă nouă" }),
    ).toBeVisible();
    await page.getByLabel("Descrierea", { exact: true }).fill(description);
    await page
      .getByLabel("Contul", { exact: true })
      .selectOption({ label: `${account.name} (RON)` });
    await page.getByLabel(/^Suma/).fill("1.250,50");
    await page.getByLabel("Data de început", { exact: true }).fill(startOn);
    await page.getByRole("button", { name: "Salvează" }).click();
    await expect(page).toHaveURL(/\/recurring$/);
    const row = page.getByTestId("recurring-row").filter({ hasText: description });
    await expect(row).toBeVisible();
    await expect(row.getByText("scadentă")).toBeVisible();
    // Singular sau plural, după numărul regulilor scadente din baza comună a testelor E2E.
    await expect(page.getByTestId("recurring-counts")).toContainText(/regul(ă|i) scadent(ă|e)/);

    await page.getByTestId("recurring-generate").click();
    await expect(page.getByTestId("recurring-generate-result")).toContainText(
      /Au fost create \d+ tranzacții|A fost creată/,
    );
    const txs = await recurringTxs(page, baseURL!, account.id);
    expect(txs).toHaveLength(3);
    expect(new Set(txs.map((t) => t.recurringRuleId)).size).toBe(1);

    // A doua generare: nimic nou.
    await page.getByTestId("recurring-generate").click();
    await expect(page.getByTestId("recurring-generate-result")).toContainText(
      "Nicio tranzacție nouă",
    );
    expect(await recurringTxs(page, baseURL!, account.id)).toHaveLength(3);

    // În `/transactions`: filtrul pe sursă și insigna „recurentă”.
    await page.goto(`/transactions?source=recurring&accountId=${account.id}`);
    await expect(page.getByLabel("Sursa", { exact: true })).toHaveValue("recurring");
    const rows = page.getByTestId("transaction-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first().getByTestId("recurring-badge")).toHaveText("recurentă");
    await expect(rows.first()).toContainText(/\d{2}\.\d{2}\.\d{4}/);
  });

  test("(b) pauză → reluare: lunile sărite NU se generează retroactiv", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "recurring");
    const client = api(page, baseURL!);
    const account = await newAccount(page, baseURL!);
    const today = todayBucharest();
    // O zi diferită de azi: după reluare, următoarea scadență e în viitor, nu azi.
    const day = Number(today.slice(8, 10)) === 1 ? 2 : 1;
    const rule = await client.post<Rule>("/api/v1/recurring", {
      accountId: account.id,
      type: "expense",
      frequency: "monthly",
      amountMinor: 4999,
      description: unique("Abonament"),
      startOn: dayMonthsBack(today, 2, day),
      dayOfMonth: day,
    });

    await page.goto(`/recurring/${rule.id}`);
    await page.getByRole("button", { name: "Pune pe pauză" }).click();
    await expect(page.getByTestId("recurring-detail-status")).toHaveText("Pusă pe pauză");
    await page.getByRole("button", { name: "Reia regula" }).click();
    await expect(page.getByTestId("recurring-detail-status")).toHaveText("Activă");

    const resumed = await client.get<Rule>(`/api/v1/recurring/${rule.id}`);
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunOn > today).toBe(true);
    await client.post("/api/v1/recurring/generate", {}, { "Idempotency-Key": genKey() });
    expect(await recurringTxs(page, baseURL!, account.id)).toHaveLength(0);
  });

  test("(c) izolare: alt utilizator nu vede regula (404) și nu o are în listă", async ({
    browser,
    baseURL,
  }) => {
    const owner = await pageAs(browser, baseURL!, "recurring");
    const account = await newAccount(owner, baseURL!);
    const description = unique("Privat");
    const rule = await api(owner, baseURL!).post<Rule>("/api/v1/recurring", {
      accountId: account.id,
      type: "income",
      frequency: "weekly",
      amountMinor: 100,
      description,
      startOn: todayBucharest(),
    });
    const other = await pageAs(browser, baseURL!, "recurring2");
    const otherApi = api(other, baseURL!);
    expect(await otherApi.status(`/api/v1/recurring/${rule.id}`)).toBe(404);
    const response = await other.goto(`/recurring/${rule.id}`);
    expect(response?.status()).toBe(404);
    await other.goto("/recurring");
    await expect(other.getByText(description)).toHaveCount(0);
    const list = await otherApi.get<Rule[]>("/api/v1/recurring");
    expect(list.some((r) => r.id === rule.id)).toBe(false);
  });

  test("(d) fără încălcări CSP și fără `style=` pe paginile noi", async ({ browser, baseURL }) => {
    test.slow();
    const page = await pageAs(browser, baseURL!, "recurring");
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
    const account = await newAccount(page, baseURL!);
    const rule = await api(page, baseURL!).post<Rule>("/api/v1/recurring", {
      accountId: account.id,
      type: "expense",
      frequency: "yearly",
      amountMinor: 12000,
      description: unique("CSP"),
      startOn: todayBucharest(),
    });
    for (const path of [
      "/recurring",
      "/recurring?status=paused",
      "/recurring/new",
      `/recurring/${rule.id}`,
      "/transactions?source=recurring",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const csp = response!.headers()["content-security-policy"] ?? "";
      expect(csp, path).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      const html = await response!.text();
      expect(html, path).not.toMatch(/\sstyle\s*=/);
      await expect(page.locator("h1")).toHaveCount(1);
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
      const seen = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      expect(seen, path).toEqual([]);
    }
    expect(consoleViolations).toEqual([]);
  });
});
