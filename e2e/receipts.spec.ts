import { type Browser, type BrowserContext, type Page, expect, test } from "@playwright/test";
import sharp from "sharp";

import { MODE, type UserKind, loginOk, password, userEmail } from "./fixtures";

/**
 * Bonurile în browser (F6-C, proiectul `receipts`). Cer, pe lângă serverul de dezvoltare,
 * WORKERUL (`node dist/tools/worker.mjs`, același `STORAGE_DIR`) și SERVERUL AI FALS
 * (`node e2e/ai-mock-server.mjs`, `E2E_AI_MOCK_URL`); CI-ul le pornește în fundal (ci.yml).
 * Fără `E2E_AI_MOCK_URL` proiectul se sare. Nicio cerere nu pleacă la un furnizor real.
 *
 * Scenarii: încărcare → „De verificat” → corectarea unei linii → „Confirmă și salvează” →
 * tranzacția „din bon” în listă; același fișier → duplicat; bon lung în 2 părți; fișier invalid
 * refuzat; fără consimțământ → `awaiting_consent` și ZERO cereri la serverul AI; izolarea între
 * utilizatori (404); zero încălcări CSP pe paginile noi.
 *
 * Workerul preia documentele la cel mult un minut (cron-ul `receipt.sweep`), deci așteptările
 * au plafoane de câteva minute. Pozele sunt generate aici (zgomot → SHA-256 unic per rulare), cu
 * lățimi fixe care aleg răspunsul serverului fals (vezi `e2e/ai-mock-server.mjs`).
 */

const MOCK = process.env.E2E_AI_MOCK_URL;
const WAIT = 200_000;

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

/** O poză de bon sintetică: zgomot (SHA unic), lățimea aleasă = scenariul serverului fals. */
async function receiptImage(width: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height: 1100,
      channels: 3,
      noise: { type: "gaussian", mean: 200, sigma: 40 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function mockCount(page: Page): Promise<number> {
  const r = await page.request.get(`${MOCK}/__requests`);
  return ((await r.json()) as { count: number }).count;
}

async function setExternalAi(page: Page, on: boolean): Promise<void> {
  await page.goto("/profile");
  const toggle = page.getByTestId("external-ai-toggle");
  if ((await toggle.isChecked()) !== on) {
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: on });
  }
}

async function ensureAccount(page: Page, baseURL: string): Promise<void> {
  const r = await page.request.post("/api/v1/accounts", {
    headers: { Origin: new URL(baseURL).origin },
    data: { name: `Card bonuri ${Date.now().toString(36)}`, type: "bank", currency: "RON" },
  });
  expect(r.status(), await r.text()).toBe(201);
}

async function upload(page: Page, files: Buffer[], longReceipt = false): Promise<void> {
  await page.goto("/import");
  if (longReceipt) await page.getByTestId("long-mode").check();
  await page
    .getByTestId("file-input")
    .setInputFiles(
      files.map((buffer, i) => ({ name: `bon-${i + 1}.jpg`, mimeType: "image/jpeg", buffer })),
    );
  await expect(page.getByTestId("picked-list").locator("li")).toHaveCount(files.length);
  await page.getByTestId("upload").click();
}

test.describe(`bonurile (${MODE})`, () => {
  test.skip(!MOCK, "E2E_AI_MOCK_URL lipsește: workerul și serverul AI fals nu rulează");
  test.setTimeout(420_000);

  test("(a) încărcare → De verificat → corectare → confirmare → tranzacția „din bon”; duplicat", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "receipts");
    await setExternalAi(page, true);
    await ensureAccount(page, baseURL!);
    const jpg = await receiptImage(801);
    await upload(page, [jpg]);
    const row = page.getByTestId("document-row").first();
    await expect(row).toHaveAttribute("data-status", /queued|processing|needs_review/);
    await expect(row).toHaveAttribute("data-status", "needs_review", { timeout: WAIT });
    await row.getByTestId("view-receipt").click();
    await expect(page).toHaveURL(/\/receipts\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("provider")).toContainText("extern");

    // Corectarea: categoria primei linii + denumirea celei de-a doua.
    const lines = page.getByTestId("receipt-line");
    await expect(lines).toHaveCount(2);
    await lines.nth(0).getByLabel("Categorie").selectOption({ index: 1 });
    await lines
      .nth(1)
      .getByLabel(/Denumire/)
      .fill("PAINE TOAST FELII");
    await page.getByTestId("save-corrections").click();
    await expect(page.getByText("Corecturile au fost salvate")).toBeVisible();
    await expect(page.getByTestId("lines-diff")).toContainText("se potrivește");

    await page.getByTestId("confirm-receipt").click();
    await expect(page.getByTestId("saved-note")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("open-transaction").click();
    await expect(page.getByTestId("transaction-receipt-link")).toBeVisible();
    await page.goto("/transactions?source=receipt");
    await expect(page.getByTestId("receipt-badge").first()).toBeVisible();
    await expect(page.getByText("20,48").first()).toBeVisible();

    // Același fișier încă o dată → documentul existent (duplicat), fără document nou.
    await upload(page, [jpg]);
    await expect(page.getByText(/deja încărcat: 1/)).toBeVisible();
  });

  test("(b) bon lung în 2 părți → un singur bon, liniile unite, suprapunerea eliminată", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "receipts");
    await setExternalAi(page, true);
    await upload(page, [await receiptImage(802), await receiptImage(803)], true);
    const rows = page.getByTestId("document-row");
    await expect(rows.first()).toHaveAttribute("data-status", "needs_review", { timeout: WAIT });
    await expect(rows.nth(1)).toHaveAttribute("data-status", "needs_review", { timeout: WAIT });
    await rows.first().getByTestId("view-receipt").click();
    await expect(page.getByTestId("receipt-line")).toHaveCount(4);
    await expect(page.getByTestId("removed-lines").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("lines-diff")).toContainText("se potrivește");
  });

  test("(c) fișier invalid (SVG cu extensie .jpg) → refuzat cu mesaj clar", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "receipts");
    await page.goto("/import");
    await page.getByTestId("file-input").setInputFiles([
      {
        name: "bon.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
      },
    ]);
    await page.getByTestId("upload").click();
    await expect(page.getByRole("alert").filter({ hasText: /neacceptat|marcaje/ })).toBeVisible();
  });

  test("(d) fără consimțământ: awaiting_consent și nicio cerere la serverul AI", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "receipts2");
    await setExternalAi(page, false);
    await page.goto("/import");
    await expect(page.getByTestId("consent-missing")).toBeVisible();
    const before = await mockCount(page);
    await upload(page, [await receiptImage(950)]);
    const row = page.getByTestId("document-row").first();
    await expect(row).toHaveAttribute("data-status", "awaiting_consent");
    // Peste un ciclu al workerului (cron la un minut): tot nimic.
    await page.waitForTimeout(75_000);
    await page.reload();
    await expect(page.getByTestId("document-row").first()).toHaveAttribute(
      "data-status",
      "awaiting_consent",
    );
    expect(await mockCount(page)).toBe(before);
  });

  test("(e) izolarea: alt utilizator nu vede bonul, fișierul sau pagina (404)", async ({
    browser,
    baseURL,
  }) => {
    const owner = await pageAs(browser, baseURL!, "receipts");
    const list = await owner.request.get("/api/v1/receipts?limit=1");
    expect(list.status()).toBe(200);
    const receipt = ((await list.json()) as { data: { id: string; documentIds: string[] }[] })
      .data[0];
    test.skip(!receipt, "niciun bon (scenariul (a) n-a rulat)");
    const other = await pageAs(browser, baseURL!, "receipts2");
    expect((await other.request.get(`/api/v1/receipts/${receipt!.id}`)).status()).toBe(404);
    expect(
      (await other.request.get(`/api/v1/documents/${receipt!.documentIds[0]}/file`)).status(),
    ).toBe(404);
    const res = await other.goto(`/receipts/${receipt!.id}`);
    expect(res?.status()).toBe(404);
  });

  test("(f) fără încălcări CSP, fără `style=`, câmpuri etichetate pe paginile noi", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "receipts");
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
    const list = await page.request.get("/api/v1/receipts?limit=1");
    const first = ((await list.json()) as { data: { id: string }[] }).data[0];
    const paths = ["/import", "/receipts", "/receipts?q=45%2C90", "/profile"];
    if (first) paths.push(`/receipts/${first.id}`);
    for (const path of paths) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      const csp = response!.headers()["content-security-policy"] ?? "";
      expect(csp, path).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp, path).not.toMatch(/img-src[^;]*blob:/);
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
      await page.waitForLoadState("networkidle");
      const seen = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      expect(seen, path).toEqual([]);
    }
    expect(consoleViolations).toEqual([]);
  });
});

// Fără worker și fără AI: limita corpului. Ruta e exclusă din proxy-ul Next (care ar trunchia corpul
// la 10 MB FĂRĂ eroare); un fișier de 11 MB trebuie să ajungă întreg la handler și să fie refuzat
// de limita aplicației (`file_too_large`), NU ca multipart trunchiat (`invalid_multipart`).
test.describe(`încărcarea mare (${MODE})`, () => {
  test("un fișier de 11 MB → 413 file_too_large (nu trunchiat)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL!, "receipts2");
    const head = await receiptImage(640);
    const big = Buffer.concat([head, Buffer.alloc(11 * 1024 * 1024, 0x20)]);
    const r = await page.request.post("/api/v1/documents", {
      headers: { Origin: new URL(baseURL!).origin },
      multipart: { files: { name: "bon.jpg", mimeType: "image/jpeg", buffer: big } },
    });
    expect(r.status()).toBe(413);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("file_too_large");
  });
});
