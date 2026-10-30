import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
} from "@playwright/test";
import sharp from "sharp";

import { buildStatementFixtures } from "../scripts/make-statement-fixtures.mjs";
import { buildZip, itemsToPdf } from "../src/modules/statements/testing";

import { MODE, type UserKind, loginOk, password, userEmail, test } from "./fixtures";

/**
 * Extrasele bancare în browser (F7-B, proiectul `statements`), DOAR cu date SINTETICE (nicio
 * bucată din extrasele reale): CSV-uri generate aici și PDF-ul sintetic BT din
 * `scripts/make-statement-fixtures.mjs`.
 *
 * Scenarii: (a) CSV → alegerea coloanelor → previzualizare → confirmare → reîncărcare = „deja
 * importat” → anulare → acoperire; (b) fișier invalid și ZIP periculos refuzate; (c) izolarea
 * între gospodării și între membri (cont personal); (d) propunerea unei plăți recurente din
 * istoric → regula; (e) cu WORKERUL și serverul AI fals (CI): PDF-ul sintetic citit de worker →
 * previzualizare, apoi potrivirea unui bon cu tranzacția din extras.
 */

const MOCK = process.env.E2E_AI_MOCK_URL;
const WAIT = 200_000;
const RUN = Date.now().toString(36);

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

function api(page: Page, baseURL: string) {
  const request: APIRequestContext = page.request;
  const headers = { Origin: new URL(baseURL).origin };
  return {
    async send<T>(method: string, path: string, data?: unknown) {
      const r = await request.fetch(path, {
        method,
        headers: data === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        data: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await r.text();
      return {
        status: r.status(),
        data: (text ? (JSON.parse(text) as { data?: T }).data : undefined) as T,
      };
    },
    async ok<T>(method: string, path: string, data?: unknown): Promise<T> {
      const r = await this.send<T>(method, path, data);
      expect([200, 201, 204], `${method} ${path}`).toContain(r.status);
      return r.data;
    },
  };
}

async function account(page: Page, baseURL: string, name: string, owner?: string) {
  return (
    await api(page, baseURL).ok<{ id: string }>("POST", "/api/v1/accounts", {
      name: `${name} ${RUN}`,
      type: "bank",
      currency: "RON",
      ...(owner ? { ownerUserId: owner } : {}),
    })
  ).id;
}

const dmy = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;

/** Un CSV sintetic „Data;Descriere;Suma” (descrieri unice pe rulare: fără duplicate între rulări). */
function csv(rows: readonly [string, string, string][]): Buffer {
  return Buffer.from(["Data;Descriere;Suma", ...rows.map((r) => r.join(";"))].join("\r\n"), "utf8");
}

/** Rezultatele acțiunilor (prima cerere compilează ruta în `next dev`): plafon generos. */
const ACT = { timeout: 60_000 };

async function uploadStatement(page: Page, accountId: string, file: Buffer, name: string) {
  await page.goto("/import?tip=extras");
  // Controalele sunt inerte până la hidratare: abia apoi alegerea contului ajunge în stare.
  await expect(page.getByTestId("statement-account")).toBeEnabled(ACT);
  await page.getByTestId("statement-account").selectOption(accountId);
  await expect(page.getByTestId("statement-account")).toHaveValue(accountId);
  await page
    .getByTestId("statement-file")
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer: file });
  await page.getByTestId("statement-upload").click();
}

/** CSV → maparea propusă (Data/Descriere/Suma) → previzualizare. */
async function importCsv(page: Page, accountId: string, file: Buffer): Promise<string> {
  await uploadStatement(page, accountId, file, "extras.csv");
  await expect(page.getByTestId("mapping-editor")).toBeVisible(ACT);
  await page.getByTestId("mapping-amount").selectOption("2");
  await page.getByTestId("mapping-apply").click();
  await expect(page).toHaveURL(/\/statements\/[0-9a-f-]{36}$/, ACT);
  return page.url().split("/").pop()!;
}

/** Confirmarea: rezultatul vine din pagina reîncărcată de pe server (nu din starea clientului). */
async function confirmImport(page: Page, fresh: number): Promise<void> {
  await page.getByTestId("statement-confirm").click();
  await expect(page.getByTestId("statement-confirm-error")).toHaveText("");
  await expect(page.getByTestId("statement-confirmed")).toContainText(
    `${fresh} tranzacții noi`,
    ACT,
  );
}

async function meId(page: Page, baseURL: string): Promise<string> {
  return (await api(page, baseURL).ok<{ user: { id: string } }>("GET", "/api/v1/me")).user.id;
}

test.describe(`extrasele bancare (${MODE})`, () => {
  test.afterEach(async ({ browser }) => {
    for (const ctx of browser.contexts()) await ctx.close();
  });
  test.setTimeout(300_000);

  test("(a) CSV: mapare → previzualizare → confirmare → duplicat → anulare → acoperire", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "statements");
    const acc = await account(page, baseURL!, "Banca extrase");
    const today = new Date();
    const file = csv([
      [dmy(today), `Cafenea Exemplu ${RUN}`, "-15,00"],
      [dmy(today), `Salariu ${RUN}`, "4500,00"],
    ]);
    await importCsv(page, acc, file);
    const lines = page.getByTestId("statement-lines").locator("tbody tr");
    await expect(lines).toHaveCount(2);
    await expect(page.getByTestId("statement-lines")).toContainText("15,00 lei");
    await expect(page.getByTestId("statement-balance")).toHaveAttribute("data-balance", "unknown");
    await confirmImport(page, 2);

    // Același fișier din nou: „deja importat”, nimic nou.
    await uploadStatement(page, acc, file, "extras.csv");
    await page.getByTestId("mapping-amount").selectOption("2");
    await page.getByTestId("mapping-apply").click();
    await expect(page.getByTestId("statement-info")).toContainText("deja importat", ACT);

    // Anularea din listă (confirmare în doi pași).
    await page.goto("/statements");
    const row = page
      .getByTestId("statement-row")
      .filter({ hasText: `Banca extrase ${RUN}` })
      .first();
    await row.getByRole("button", { name: "Anulează importul" }).click();
    await row.getByRole("button", { name: "Anulează importul" }).last().click();
    await expect(row).toHaveAttribute("data-status", "cancelled", ACT);

    // Acoperirea: contul apare în tabel.
    await page.goto("/statements/coverage");
    await expect(page.getByTestId("coverage-table")).toContainText(`Banca extrase ${RUN}`);
  });

  test("(b) fișier invalid și ZIP periculos: refuzate cu mesaj clar", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "statements");
    const acc = await account(page, baseURL!, "Banca refuz");
    await uploadStatement(page, acc, Buffer.from([0, 1, 2, 3, 0]), "x.csv");
    await expect(page.getByTestId("statement-error")).toContainText("nu e un CSV", ACT);
    const nested = buildZip([
      { name: "inner.zip", data: buildZip([{ name: "a.csv", data: "x" }]) },
    ]);
    await uploadStatement(page, acc, nested, "extrase.zip");
    await expect(page.getByTestId("statement-error")).toContainText("Arhiva ZIP e refuzată", ACT);
  });

  test("(c) izolarea: altă gospodărie și contul PERSONAL al altui membru sunt invizibile", async ({
    browser,
    baseURL,
  }) => {
    test.skip(MODE !== "personal", "Familia se testează E2E în modul personal.");
    const owner = await pageAs(browser, baseURL!, "statements");
    const member = await pageAs(browser, baseURL!, "statements3");
    const outsider = await pageAs(browser, baseURL!, "statements2");
    const o = api(owner, baseURL!);
    // Membrul intră în gospodăria proprietarului (o singură dată pe bază).
    const ownerHh = (await o.ok<{ id: string }[]>("GET", "/api/v1/households"))[0]!.id;
    const memberId = await meId(member, baseURL!);
    const members = await o.ok<{ userId: string }[]>("GET", "/api/v1/family/members");
    if (!members.some((m) => m.userId === memberId)) {
      const inv = await o.ok<{ token: string }>("POST", "/api/v1/family/invites", {});
      await api(member, baseURL!).ok("POST", "/api/v1/invites/accept", { token: inv.token });
    }
    await api(member, baseURL!).ok("PUT", "/api/v1/households/active", { householdId: ownerHh });

    const personal = await account(owner, baseURL!, "Personal", await meId(owner, baseURL!));
    const id = await importCsv(
      owner,
      personal,
      csv([[dmy(new Date()), `Personal ${RUN}`, "-7,00"]]),
    );
    expect(
      (await api(member, baseURL!).send("GET", `/api/v1/statements/imports/${id}`)).status,
    ).toBe(404);
    expect(
      (await api(outsider, baseURL!).send("GET", `/api/v1/statements/imports/${id}`)).status,
    ).toBe(404);
    const r = await member.goto(`/statements/${id}`);
    expect(r?.status()).toBe(404);
    await member.goto("/statements");
    await expect(member.getByText(`Personal ${RUN}`)).toHaveCount(0);
    // Nici încărcarea pe contul personal al proprietarului.
    await member.goto("/import?tip=extras");
    await expect(
      member.getByTestId("statement-account").locator("option", { hasText: `Personal ${RUN}` }),
    ).toHaveCount(0);
    await api(owner, baseURL!).ok("DELETE", `/api/v1/statements/imports/${id}`);
  });

  test("(d) propunere de plată recurentă din istoric → acceptată ca regulă", async ({
    browser,
    baseURL,
  }) => {
    const page = await pageAs(browser, baseURL!, "statements2");
    const acc = await account(page, baseURL!, "Banca abonamente");
    const rows: [string, string, string][] = [];
    const now = new Date();
    for (let k = 3; k >= 0; k--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 5));
      if (d <= now) rows.push([dmy(d), `STREAMING${RUN.toUpperCase()} Abonament`, "-49,99"]);
    }
    await importCsv(page, acc, csv(rows));
    await confirmImport(page, rows.length);
    await page.goto("/recurring");
    const suggestion = page
      .getByTestId("suggestion-row")
      .filter({ hasText: `STREAMING${RUN.toUpperCase()}` });
    await expect(suggestion).toHaveCount(1, ACT);
    await expect(suggestion).toContainText("49,99 lei");
    await suggestion.getByTestId("suggestion-accept").click();
    // Acceptarea deschide regula creată; propunerea nu mai apare, regula e în listă.
    await expect(page).toHaveURL(/\/recurring\/[0-9a-f-]{36}$/, ACT);
    await page.goto("/recurring");
    await expect(page.getByTestId("recurring-list")).toContainText(`STREAMING${RUN.toUpperCase()}`);
    await expect(
      page.getByTestId("suggestion-row").filter({ hasText: `STREAMING${RUN.toUpperCase()}` }),
    ).toHaveCount(0);
  });

  test("(e) cu workerul: PDF sintetic → previzualizare; potrivirea bonului cu tranzacția din extras", async ({
    browser,
    baseURL,
  }) => {
    test.skip(!MOCK, "E2E_AI_MOCK_URL lipsește: workerul și serverul AI fals nu rulează");
    test.setTimeout(480_000);
    const page = await pageAs(browser, baseURL!, "statements");
    const acc = await account(page, baseURL!, "Banca PDF");
    await uploadStatement(page, acc, itemsToPdf(buildStatementFixtures().bt.items), "extras.pdf");
    await expect(page.getByTestId("statement-error")).toHaveText("");
    await expect(page.getByTestId("statement-info")).toContainText("coadă", ACT);
    await expect(page).toHaveURL(/\/statements\/[0-9a-f-]{36}$/, { timeout: WAIT });
    await expect(page.getByTestId("statement-balance")).toHaveAttribute("data-balance", "ok");
    await expect(page.getByTestId("statement-pending")).toBeVisible();

    // Un bon (serverul AI fals: KAUFLAND, 20,48 lei, 2026-10-20) și extrasul cu aceeași plată.
    await api(page, baseURL!).ok("PUT", "/api/v1/me/consents", { externalAi: true });
    const jpg = await sharp({
      create: {
        width: 801,
        height: 1100,
        channels: 3,
        background: { r: 230, g: 230, b: 230 },
        noise: { type: "gaussian", mean: 200, sigma: 40 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
    await page.goto("/import");
    await page
      .getByTestId("file-input")
      .setInputFiles({ name: "bon.jpg", mimeType: "image/jpeg", buffer: jpg });
    await page.getByTestId("upload").click();
    const doc = page.getByTestId("document-row").first();
    await expect(doc).toHaveAttribute("data-status", "needs_review", { timeout: WAIT });
    await doc.getByTestId("view-receipt").click();
    // Adresa se citește DUPĂ navigare (altfel ar rămâne `/import`).
    await expect(page).toHaveURL(/\/receipts\/[0-9a-f-]{36}$/, ACT);
    const receiptUrl = page.url();
    const card = await account(page, baseURL!, "Card potrivire");
    await importCsv(page, card, csv([["20.10.2026", `EPOS KAUFLAND RO ${RUN}`, "-20,48"]]));
    await confirmImport(page, 1);
    await page.goto(receiptUrl);
    const candidate = page.getByTestId("match-candidate").filter({ hasText: RUN });
    await expect(candidate).toHaveCount(1, ACT);
    await expect(candidate).toContainText("aceeași zi");
    await candidate.getByTestId("match-confirm").click();
    await expect(page.getByTestId("match-done")).toContainText("legat", ACT);
  });
});
