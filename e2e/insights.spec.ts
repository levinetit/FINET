import { createHash, randomUUID } from "node:crypto";

import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
import postgres from "postgres";

import { MODE, type UserKind, loginOk, password, userEmail } from "./fixtures";

/**
 * Rapoartele inteligente în browser (F10-B, proiectul `insights`; ADR 0023). Bonurile CONFIRMATE
 * sunt SINTETICE și se inserează direct în baza de test (rolul `finet_app`, cu contextul RLS al
 * utilizatorului), ca testul să nu depindă de worker sau de serverul AI fals. Scenarii:
 * (a) raport predefinit pe puține bonuri → total corect, proiecția «date insuficiente»; după
 * bonuri pe >60 de zile → proiecția apare, marcată ca estimare; (b) generator: previzualizare →
 * salvare → raport propriu → export CSV → ștergere; (c) prețuri: sub prag «nu sunt suficiente
 * date», peste prag prețul; (d) izolare între gospodării; (e) CSP și fără `style=`.
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

async function ids(page: Page, baseURL: string) {
  const headers = { Origin: new URL(baseURL).origin };
  const me = await page.request.get("/api/v1/me");
  const userId = ((await me.json()) as { data: { user: { id: string } } }).data.user.id;
  const hh = await page.request.get("/api/v1/households");
  const households = ((await hh.json()) as { data: { id: string; current: boolean }[] }).data;
  const householdId = (households.find((h) => h.current) ?? households[0]!).id;
  const acc = await page.request.post("/api/v1/accounts", {
    headers,
    data: { name: unique("Card rapoarte"), type: "bank", currency: "RON" },
  });
  expect(acc.status(), await acc.text()).toBe(201);
  const accountId = ((await acc.json()) as { data: { id: string } }).data.id;
  return { userId, householdId, accountId };
}

/** Șterge bonurile sintetice ale gospodăriei (retry-urile CI pornesc de la zero). */
async function resetReceipts(seed: { userId: string; householdId: string }): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește (baza de test a E2E)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${seed.userId}, true),
                      set_config('app.household_id', ${seed.householdId}, true)`;
      await tx`delete from finet.receipts where household_id = ${seed.householdId}`;
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

type SeedLine = { name: string; qty?: string; total: number; kind?: string };
type Seed = { userId: string; householdId: string; accountId: string };

/** Un bon confirmat sintetic (document + tranzacție + bon + linii), ca `finet_app` cu RLS. */
async function seedReceipt(
  seed: Seed,
  daysAgo: number,
  merchant: { name: string; cui: string },
  lines: SeedLine[],
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește (baza de test a E2E)");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const on = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    const total = lines.reduce((s, l) => s + (l.kind === "discount" ? -l.total : l.total), 0);
    const docId = randomUUID();
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
        values (${seed.householdId}, ${docId}, 'saved', ${Math.max(total, 0)}, 'RON', ${on},
          ${merchant.name}, ${merchant.cui}, ${t!.id}) returning id`;
      let position = 0;
      for (const l of lines) {
        position += 1;
        await tx`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name,
            normalized_name, quantity, line_total_minor, kind)
          values (${r!.id}, ${seed.householdId}, ${position}, ${l.name}, ${normalize(l.name)},
            ${l.qty ?? "1"}, ${l.total}, ${l.kind ?? "product"})`;
      }
    });
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

const LIDL = { name: "LIDL DISCOUNT SRL", cui: "RO22891860" };
const KAUF = { name: "KAUFLAND ROMANIA SCS", cui: "RO15991149" };

test.describe(`rapoarte inteligente (${MODE})`, () => {
  test.skip(
    !process.env.DATABASE_URL,
    "DATABASE_URL lipsește: bonurile sintetice nu se pot insera",
  );
  test.setTimeout(240_000);

  test("(a) raport predefinit: total corect; proiecția «date insuficiente», apoi estimarea după destule bonuri", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const page = await pageAs(browser, baseURL!, "insights");
    const seed = await ids(page, baseURL!);
    await resetReceipts(seed);
    for (const days of [2, 5, 9]) {
      await seedReceipt(seed, days, LIDL, [
        { name: "PUNGA RAFIE", total: 50, kind: "bag" },
        { name: "PUNGI MENAJ 35L", total: 399, kind: "bag" },
        { name: "LAPTE ZUZU 1,5% 1L", total: 749 },
      ]);
    }
    await page.goto("/insights");
    await expect(page.locator("h1")).toHaveCount(1);
    await page.getByTestId("report-link").filter({ hasText: "Pungi și sacoșe" }).click();
    await expect(page.getByTestId("report-selected")).toContainText("Pungi și sacoșe");
    // 3 × 0,50 lei; pungile de menaj NU intră
    await expect(page.getByTestId("report-total")).toContainText(/1,50\s*lei/);
    await expect(page.getByTestId("report-pieces")).toContainText("3");
    await expect(page.getByTestId("report-projection")).toHaveAttribute(
      "data-status",
      "insufficient",
    );
    await expect(page.getByTestId("report-projection")).toContainText("Date insuficiente");
    await expect(page.getByTestId("report-lines")).toContainText("PUNGA RAFIE");
    await expect(page.getByTestId("report-lines")).not.toContainText("MENAJ");
    await expect(page.getByTestId("report-advice")).toBeVisible();

    // Încă 10 bonuri pe ~100 de zile → destule zile și bonuri pentru o estimare.
    for (let i = 0; i < 10; i++) {
      await seedReceipt(seed, 15 + i * 10, i % 2 === 0 ? LIDL : KAUF, [
        { name: "PUNGA RAFIE", total: 50, kind: "bag" },
        { name: "LAPTE ZUZU 1,5% 1L", total: i % 2 === 0 ? 749 : 699 },
      ]);
    }
    await page.reload();
    const projection = page.getByTestId("report-projection");
    await expect(projection).toHaveAttribute("data-status", "ok");
    await expect(projection).toContainText("Estimare");
    await expect(page.getByTestId("report-total")).toContainText(/6,50\s*lei/);
  });

  test("(b) generator: previzualizare → salvare → raport propriu → export CSV → ștergere", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const page = await pageAs(browser, baseURL!, "insights");
    const seed = await ids(page, baseURL!);
    await resetReceipts(seed);
    await seedReceipt(seed, 3, LIDL, [
      { name: "CIOCOLATA MILKA 100G", qty: "2", total: 1000 },
      { name: "-CIOCOLATA INJECTIE", total: 100 },
      { name: "LAPTE ZUZU 1,5% 1L", total: 749 },
    ]);
    const name = unique("Dulciuri");
    await page.goto("/insights#generator");
    await page.getByLabel("Numele raportului").fill(name);
    await page.locator("#include-value-" + (await firstRuleId(page, "include"))).fill("ciocolata");
    await page.getByTestId("gen-preview").click();
    await expect(page.getByTestId("preview-total")).toContainText(/11,00\s*lei/);
    // reguli invalide: text prea scurt → mesaj, nimic salvat
    await page.locator("#include-value-" + (await firstRuleId(page, "include"))).fill("c");
    await page.getByTestId("gen-save").click();
    await expect(page.getByText("Completează textul regulii")).toBeVisible();
    await page.locator("#include-value-" + (await firstRuleId(page, "include"))).fill("ciocolata");
    await page.getByTestId("gen-save").click();
    await expect(page).toHaveURL(/\/insights\?report=[0-9a-f-]{36}/);
    await expect(page.getByTestId("report-selected")).toContainText(name);
    await expect(page.getByTestId("report-total")).toContainText(/11,00\s*lei/);

    // Export CSV: antet, separator «;», BOM; textul liber neutralizat nu apare ca formulă.
    const download = page.waitForEvent("download");
    await page.getByTestId("report-export").click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("finet-raport.csv");
    const stream = await file.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    const bytes = Buffer.concat(chunks);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.subarray(3).toString("utf8");
    expect(text.split("\r\n")[0]).toBe(
      "line_id;receipt_id;occurred_on;merchant;name;kind;quantity;currency;line_total_minor;line_total",
    );
    expect(text).toContain("CIOCOLATA MILKA 100G");
    // text liber care începe cu «-» primește apostrof (protecția de formule din csv.ts)
    expect(text).toContain("'-CIOCOLATA INJECTIE");
    expect(text).not.toContain("LAPTE");

    // Ștergerea raportului propriu (cu confirmare).
    await page.getByRole("button", { name: "Șterge", exact: true }).click();
    await page.getByRole("button", { name: "Da, șterge" }).click();
    await expect(page).toHaveURL(/\/insights(\?|#|$)/);
    await expect(page.getByTestId("report-list")).not.toContainText(name);
  });

  test("(c) prețuri: «nu sunt suficiente date» sub prag; prețul și magazinul cel mai ieftin peste prag", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const page = await pageAs(browser, baseURL!, "insights");
    const seed = await ids(page, baseURL!);
    await resetReceipts(seed);
    await seedReceipt(seed, 4, LIDL, [{ name: "UNT PREMIUM 200G", total: 899 }]);
    for (const [days, store, price] of [
      [10, LIDL, 800],
      [40, LIDL, 820],
      [70, LIDL, 810],
      [20, KAUF, 700],
      [50, KAUF, 720],
    ] as const) {
      await seedReceipt(seed, days, store, [{ name: "IAURT GRECESC 400G", total: price }]);
    }
    await page.goto("/insights#preturi");
    const unt = page.getByTestId("price-row").filter({ hasText: "unt premium" });
    await expect(unt).toHaveAttribute("data-enough", "false");
    await expect(unt).toContainText("Nu sunt suficiente date");
    const yogurt = page.getByTestId("price-row").filter({ hasText: "iaurt grecesc" });
    await expect(yogurt).toHaveAttribute("data-enough", "true");
    // Lidl: (800 + 820 + 810) / 3 ≈ 8,10 lei pe 0,4 kg → 20,25 lei/kg (medie ponderată, 3 observații)
    await expect(yogurt).toContainText(/\/\s*kg/);
    await expect(yogurt).toContainText(/kaufland/i);
    // Evoluția în timp
    await yogurt.getByRole("link", { name: /Vezi evoluția/ }).click();
    await expect(page.getByTestId("price-series")).toBeVisible();
    await expect(page.getByTestId("series-chart")).toBeVisible();
    // Inflația: sub prag (puține articole comune) → mesaj, fără variație
    await expect(page.getByTestId("inflation")).toBeVisible();
    await expect(page.getByTestId("inflation-change")).toHaveCount(0);
  });

  test("(d) izolare: rapoartele și bonurile unui utilizator nu apar la altul; (e) fără încălcări CSP", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const owner = await pageAs(browser, baseURL!, "insights");
    const seed = await ids(owner, baseURL!);
    const name = unique("Privat");
    const created = await owner.request.post("/api/v1/report-definitions", {
      headers: { Origin: new URL(baseURL!).origin },
      data: {
        name,
        rules: {
          v: 1,
          combine: "any",
          include: [{ type: "token", value: "secret" }],
          exclude: [],
          kinds: ["product"],
          categoryIds: [],
          tagIds: [],
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    await resetReceipts(seed);
    await seedReceipt(seed, 2, LIDL, [{ name: "PRODUS SECRET 1KG", total: 1234 }]);

    const other = await pageAs(browser, baseURL!, "insights2");
    await other.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    const consoleViolations: string[] = [];
    other.on("console", (m) => {
      if (/content security policy/i.test(m.text())) consoleViolations.push(m.text());
    });
    const response = await other.goto("/insights");
    expect(response?.status()).toBe(200);
    const csp = response!.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(await response!.text()).not.toMatch(/\sstyle\s*=/);
    await expect(other.getByTestId("report-list")).not.toContainText(name);
    await expect(other.locator("body")).not.toContainText("secret");
    expect((await other.request.get(`/api/v1/report-definitions/${id}`)).status()).toBe(404);
    expect((await other.request.get(`/api/v1/report-definitions/${id}/run`)).status()).toBe(404);
    expect(await other.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual(
      [],
    );
    expect(consoleViolations).toEqual([]);
  });
});

/** Id-ul numeric (din `key`) al primului rând de reguli dintr-un editor. */
async function firstRuleId(page: Page, prefix: "include" | "exclude"): Promise<string> {
  const id = await page
    .locator(`[data-testid="${prefix}-rules"] input[id^="${prefix}-value-"]`)
    .first()
    .getAttribute("id");
  return id!.replace(`${prefix}-value-`, "");
}
