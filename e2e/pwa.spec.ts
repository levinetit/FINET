import { type Browser, type BrowserContext, type Page, expect } from "@playwright/test";
import sharp from "sharp";

import { MODE, type UserKind, loginOk, password, userEmail, test } from "./fixtures";

/**
 * PWA și scanarea offline (Faza 9, ADR 0020; proiectul `pwa`). Același server de dezvoltare și
 * aceeași bază ca `auth`; utilizatorii `pwa` și `pwa2`. Nu cere workerul: încărcarea răspunde 201
 * fără el (documentul rămâne `queued`/`awaiting_consent`).
 *
 * Scenarii: manifestul și iconițele; service worker-ul înregistrat, care NU pune în cache date
 * autentificate (API, navigări); navigarea fără rețea → `/offline`; o scanare făcută offline
 * apare „în așteptare”, se încarcă O SINGURĂ DATĂ la reconectare și dispare din coadă; o eroare
 * permanentă rămâne vizibilă și se poate șterge; la deconectare coada locală se golește.
 *
 * Notă: în dezvoltare service worker-ul NU pune în cache `/_next/static` (versiunea `dev`); regula
 * de producție e acoperită de `src/pwa/sw.test.ts`.
 */

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const states = new Map<UserKind, StorageState>();

async function contextAs(browser: Browser, baseURL: string, kind: UserKind) {
  let state = states.get(kind);
  if (!state) {
    const ctx = await browser.newContext({ baseURL });
    const p = await ctx.newPage();
    await loginOk(p, userEmail(kind), password());
    state = await ctx.storageState();
    states.set(kind, state);
    await ctx.close();
  }
  const context = await browser.newContext({ baseURL, storageState: state });
  return { context, page: await context.newPage() };
}

/** Așteaptă ca service worker-ul să controleze pagina (prima instalare: `clients.claim`). */
async function controlled(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      await navigator.serviceWorker.ready;
      return navigator.serviceWorker.controller !== null;
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function photo(): Promise<Buffer> {
  return sharp({
    create: {
      width: 640,
      height: 900,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
      noise: { type: "gaussian", mean: 200, sigma: 40 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function documentCount(page: Page): Promise<number> {
  const r = await page.request.get("/api/v1/documents?limit=100");
  expect(r.status()).toBe(200);
  return ((await r.json()) as { data: unknown[] }).data.length;
}

async function pick(page: Page, buffer: Buffer, mimeType = "image/jpeg"): Promise<void> {
  await page.getByTestId("file-input").setInputFiles([{ name: "bon.jpg", mimeType, buffer }]);
  await expect(page.getByTestId("picked-list").locator("li")).toHaveCount(1);
}

/**
 * Scanarea (offline) are nevoie de `/import` și de `POST /api/v1/documents`, care cer drepturile
 * gospodăriei (`entitlements`: limita zilnică AI, cota). În `saas` acestea sunt neimplementate
 * până în Faza 11 (`NotImplementedError`, master prompt 3.3), deci pagina `/import` nu se încarcă
 * și încărcarea nu e disponibilă: aceleași motive pentru care proiectul `receipts` rulează doar în
 * `personal`. Testele cozii offline se sar în `saas` (rulează integral în `personal`); manifestul,
 * service worker-ul și `/offline` rămân testate în ambele moduri.
 */
const SCAN_SKIP = MODE === "saas";
const SCAN_SKIP_REASON = "bonurile (entitlements) vin în saas în Faza 11";

test.describe(`PWA și offline (${MODE})`, () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  test("manifestul (cu credențiale), iconițele și metadatele iOS", async ({ browser, baseURL }) => {
    const { context, page } = await contextAs(browser, baseURL!, "pwa");
    await page.goto("/dashboard");
    const link = page.locator('link[rel="manifest"]');
    await expect(link).toHaveAttribute("href", "/manifest.webmanifest");
    await expect(link).toHaveAttribute("crossorigin", "use-credentials");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      "href",
      /\/icons\/apple-touch-icon\.png/,
    );
    const r = await page.request.get("/manifest.webmanifest");
    expect(r.status()).toBe(200);
    const manifest = (await r.json()) as {
      start_url: string;
      display: string;
      icons: { src: string; purpose: string }[];
    };
    expect(manifest.start_url).toBe("/dashboard");
    expect(manifest.display).toBe("standalone");
    for (const icon of manifest.icons) {
      const i = await page.request.get(icon.src);
      expect(i.status(), icon.src).toBe(200);
      expect(i.headers()["content-type"]).toContain("image/png");
    }
    await context.close();
  });

  test("service worker-ul controlează pagina și NU pune în cache date autentificate", async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await contextAs(browser, baseURL!, "pwa");
    await page.goto("/dashboard");
    await controlled(page);
    const sw = await page.request.get("/sw.js");
    expect(sw.headers()["service-worker-allowed"]).toBe("/");
    expect(sw.headers()["cache-control"]).toBe("no-cache");

    // Răspunsurile API și navigările nu trec prin cache-ul service worker-ului.
    const api = page.waitForResponse((res) => res.url().includes("/api/v1/me"));
    await page.evaluate(() => fetch("/api/v1/me", { credentials: "same-origin" }));
    expect((await api).fromServiceWorker()).toBe(false);
    await page.goto("/transactions");
    await page.goto("/import");

    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) out.push(new URL(req.url).pathname);
      }
      return out;
    });
    expect(cached).toContain("/offline");
    for (const path of cached) {
      expect(path.startsWith("/api/"), path).toBe(false);
      expect(["/dashboard", "/transactions", "/import", "/login"]).not.toContain(path);
    }
    await context.close();
  });

  test("navigare fără rețea → pagina /offline, în română", async ({ browser, baseURL }) => {
    const { context, page } = await contextAs(browser, baseURL!, "pwa");
    await page.goto("/dashboard");
    await controlled(page);
    await context.setOffline(true);
    await page.goto("/transactions");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Nu există conexiune la internet",
    );
    await expect(page.getByTestId("offline-scans")).toBeVisible();
    await context.setOffline(false);
    await context.close();
  });

  test("scanare offline → în așteptare → reconectare → încărcată O SINGURĂ DATĂ", async ({
    browser,
    baseURL,
  }) => {
    test.skip(SCAN_SKIP, SCAN_SKIP_REASON);
    const { context, page } = await contextAs(browser, baseURL!, "pwa");
    await page.goto("/import");
    await controlled(page);
    const before = await documentCount(page);
    let posts = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/v1/documents") posts++;
    });

    await context.setOffline(true);
    await expect(page.getByTestId("offline-banner")).toBeVisible();
    await pick(page, await photo());
    await page.getByTestId("upload").click();
    const entry = page.getByTestId("offline-scan");
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute("data-state", "pending");
    await expect(entry).toContainText("În așteptare (offline)");

    await context.setOffline(false);
    await expect(page.getByTestId("offline-queue")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("document-row").first()).toBeVisible();
    expect(await documentCount(page)).toBe(before + 1);

    // O nouă trecere (reîncărcare) nu mai trimite nimic: coada e goală.
    await page.reload();
    await page.waitForTimeout(2000);
    expect(posts).toBe(1);
    expect(await documentCount(page)).toBe(before + 1);
    await context.close();
  });

  test("eroare permanentă (fișier care nu e imagine) → rămâne vizibilă, cu motiv; „Șterge”", async ({
    browser,
    baseURL,
  }) => {
    test.skip(SCAN_SKIP, SCAN_SKIP_REASON);
    const { context, page } = await contextAs(browser, baseURL!, "pwa2");
    await page.goto("/import");
    await context.setOffline(true);
    await pick(page, Buffer.from("nu e o poză, doar text ".repeat(20)), "image/png");
    await page.getByTestId("upload").click();
    await expect(page.getByTestId("offline-scan")).toHaveCount(1);
    await context.setOffline(false);
    const entry = page.getByTestId("offline-scan");
    await expect(entry).toHaveAttribute("data-state", "failed", { timeout: 60_000 });
    await expect(entry).toContainText("Nu a putut fi încărcat");
    await entry.getByRole("button", { name: /Șterge de pe dispozitiv/ }).click();
    await expect(page.getByTestId("offline-scan")).toHaveCount(0);
    await context.close();
  });

  test("deconectarea golește coada locală (IndexedDB)", async ({ browser, baseURL }) => {
    test.skip(SCAN_SKIP, SCAN_SKIP_REASON);
    const { context, page } = await contextAs(browser, baseURL!, "pwa2");
    await page.goto("/import");
    // Încărcările eșuează ca la o rețea căzută: intrarea rămâne în așteptare.
    await page.route("**/api/v1/documents", (route) =>
      route.request().method() === "POST" ? route.abort("internetdisconnected") : route.fallback(),
    );
    await context.setOffline(true);
    await pick(page, await photo());
    await page.getByTestId("upload").click();
    await expect(page.getByTestId("offline-scan")).toHaveCount(1);
    await context.setOffline(false);
    const before = await page.evaluate(async () =>
      (await indexedDB.databases()).map((d) => d.name),
    );
    expect(before).toContain("finet-offline");

    const logout = page.getByRole("button", { name: "Deconectează-te" }).first();
    if (!(await logout.isVisible())) await page.getByRole("button", { name: "Mai mult" }).click();
    await page.getByRole("button", { name: "Deconectează-te" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    const after = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    expect(after).not.toContain("finet-offline");
    states.delete("pwa2"); // sesiunea s-a închis
    await context.close();
  });
});
