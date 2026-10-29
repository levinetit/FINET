import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "@playwright/test";

import { MODE, type UserKind, loginOk, password, userEmail } from "./fixtures";

/**
 * Familia în browser (F8-B, proiectul `family`, modul `personal`): invitație → acceptare cu al doilea
 * utilizator → cheltuială împărțită → soldurile la amândoi → decontare parțială → actualizarea
 * apare la celălalt FĂRĂ reîncărcare (SSE); token folosit / revocat / greșit → același mesaj;
 * permisiunile pe rol; izolarea față de un al treilea utilizator; ultimul owner nu pleacă; plecarea.
 *
 * Utilizatori: `family` (owner, gospodăria lui), `family2` (intră prin invitație), `family3` (din
 * afară). Testele se pot relua pe aceeași bază (CI reîncearcă o dată): la început, `family` scoate
 * orice alt membru rămas după decontarea soldurilor, iar numele au un sufix unic.
 *
 * Expirarea unei invitații nu se poate produce aici (expirarea vine din ceasul bazei, maximum 168 h):
 * e acoperită de testele de integrare F8-A (`src/modules/family/family.test.ts`); răspunsul uniform
 * pentru o invitație inutilizabilă e același pe orice cauză (verificat aici pe folosit/revocat/greșit).
 */

const RUN = `${MODE}-${Date.now().toString(36)}`;
let seq = 0;
const unique = (prefix: string) => `${prefix} ${RUN}-${++seq}`;
const UNAVAILABLE = /Invitația nu mai este valabilă/;

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

type Balances = {
  currencies: {
    currency: string;
    pairs: { debtorUserId: string; creditorUserId: string; amountMinor: number }[];
  }[];
  me: { currency: string; owesMinor: number; owedMinor: number }[];
};
type Member = { userId: string; name: string; role: string };

function api(page: Page, baseURL: string) {
  const request: APIRequestContext = page.request;
  const headers = { Origin: new URL(baseURL).origin };
  return {
    async send<T>(
      method: string,
      path: string,
      data?: unknown,
    ): Promise<{ status: number; data: T }> {
      const r = await request.fetch(path, {
        method,
        headers: data === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        data: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await r.text();
      const body = text ? (JSON.parse(text) as { data?: T }) : {};
      return { status: r.status(), data: body.data as T };
    },
    async ok<T>(method: string, path: string, data?: unknown): Promise<T> {
      const r = await this.send<T>(method, path, data);
      expect([200, 201, 204], `${method} ${path}`).toContain(r.status);
      return r.data;
    },
  };
}

async function meId(page: Page, baseURL: string): Promise<string> {
  return (await api(page, baseURL).ok<{ user: { id: string } }>("GET", "/api/v1/me")).user.id;
}

/** Ca owner: stinge toate soldurile dintre membrii actuali (decontări exacte, debitor → creditor). */
async function settleAll(owner: Page, baseURL: string, today: string): Promise<void> {
  const a = api(owner, baseURL);
  const members = new Set(
    (await a.ok<Member[]>("GET", "/api/v1/family/members")).map((m) => m.userId),
  );
  const b = await a.ok<Balances>("GET", "/api/v1/family/balances");
  for (const c of b.currencies) {
    for (const p of c.pairs) {
      if (!members.has(p.debtorUserId) || !members.has(p.creditorUserId)) continue;
      await a.ok("POST", "/api/v1/family/settlements", {
        fromUserId: p.debtorUserId,
        toUserId: p.creditorUserId,
        amountMinor: p.amountMinor,
        currency: c.currency,
        settledOn: today,
        note: "E2E curățare",
      });
    }
  }
}

/** Starea de plecare: `family` singur în gospodăria lui (soldurile stinse, ceilalți scoși). */
async function resetFamily(owner: Page, baseURL: string, today: string): Promise<void> {
  const a = api(owner, baseURL);
  const me = await meId(owner, baseURL);
  await settleAll(owner, baseURL, today);
  for (const m of await a.ok<Member[]>("GET", "/api/v1/family/members")) {
    if (m.userId !== me) await a.ok("DELETE", `/api/v1/family/members/${m.userId}`);
  }
}

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

test.describe(`familia (${MODE})`, () => {
  test.skip(MODE !== "personal", "Familia se testează E2E în modul personal.");
  test.describe.configure({ mode: "serial" });

  let usedToken = "";
  let splitTxId = "";

  test("(a) invitație → acceptare → cheltuială împărțită → solduri → decontare parțială live", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const today = todayBucharest();
    const owner = await pageAs(browser, baseURL!, "family");
    const member = await pageAs(browser, baseURL!, "family2");
    await resetFamily(owner, baseURL!, today);

    // Invitația din UI: linkul apare o singură dată.
    await owner.goto("/family");
    await expect(owner.getByRole("heading", { level: 1, name: "Familie" })).toBeVisible();
    await owner.getByTestId("invite-create").click();
    const link = await owner.getByTestId("invite-link").inputValue();
    expect(link).toMatch(/\/join\/[A-Za-z0-9_-]{43}$/);
    usedToken = link.slice(link.lastIndexOf("/") + 1);
    await owner.reload();
    await expect(owner.getByTestId("invite-link")).toHaveCount(0);
    expect(await owner.content()).not.toContain(usedToken);

    // Acceptarea: deschiderea paginii nu consumă nimic; butonul trimite POST.
    await member.goto(`/join/${usedToken}`);
    await expect(
      member.getByRole("heading", { level: 1, name: "Invitație în gospodărie" }),
    ).toBeVisible();
    await member.getByTestId("join-accept").click();
    await expect(member.getByTestId("join-result")).toContainText(/Ai intrat|Faci deja parte/);
    // Datele vechi (o rulare anterioară întreruptă) nu încurcă: soldurile încep de la zero.
    await settleAll(owner, baseURL!, today);

    // Comutatorul apare (două gospodării), cu gospodăria familiei activă.
    await member.goto("/family");
    await expect(member.getByTestId("household-switcher")).toBeVisible();
    await expect(member.getByTestId("family-member")).toHaveCount(2);

    // Cheltuiala din contul PERSONAL al membrului, împărțită egal din pagina tranzacției.
    const m = api(member, baseURL!);
    const memberId = await meId(member, baseURL!);
    const account = await m.ok<{ id: string }>("POST", "/api/v1/accounts", {
      name: unique("Card personal"),
      type: "bank",
      currency: "RON",
      ownerUserId: memberId,
    });
    const tx = await m.ok<{ id: string }>("POST", "/api/v1/transactions", {
      type: "expense",
      accountId: account.id,
      amountMinor: 10000,
      occurredOn: today,
      description: unique("Cumpărături"),
    });
    splitTxId = tx.id;
    await member.goto(`/transactions/${tx.id}`);
    await member.getByTestId("split-save").click();
    await expect(member.getByTestId("split-result")).toContainText("Împărțirea a fost salvată.");
    await expect(member.getByTestId("split-current")).toContainText("50,00");

    // Suma nu se mai schimbă: mesajul explică de ce.
    await member.getByLabel(/^Suma/).fill("80,00");
    await member.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(member.getByText(/Cheltuiala e împărțită între membri/)).toBeVisible();

    // Soldurile la amândoi.
    await owner.goto("/family");
    await expect(owner.getByTestId("family-owes-RON")).toContainText("50,00");
    await member.goto("/family");
    await expect(member.getByTestId("family-owed-RON")).toContainText("50,00");
    await member.goto("/dashboard");
    await expect(member.getByTestId("widget-owed-RON")).toContainText("50,00");
    await member.goto("/family");

    // Decontare parțială (20 lei) din UI-ul owner-ului → la membru se vede fără reîncărcare.
    await owner.getByLabel("Suma", { exact: true }).fill("20");
    await owner.getByTestId("settlement-submit").click();
    await expect(owner.getByTestId("settlement-result")).toContainText("înregistrată");
    await expect(owner.getByTestId("family-owes-RON")).toContainText("30,00");
    await expect(member.getByTestId("family-owed-RON")).toContainText("30,00", { timeout: 20_000 });
  });

  test("(b) token folosit, revocat sau greșit → același mesaj, fără detalii", async ({
    browser,
    baseURL,
  }) => {
    const owner = await pageAs(browser, baseURL!, "family");
    const outsider = await pageAs(browser, baseURL!, "family3");
    const revoked = await api(owner, baseURL!).ok<{ invite: { id: string }; token: string }>(
      "POST",
      "/api/v1/family/invites",
      {},
    );
    await api(owner, baseURL!).ok("POST", `/api/v1/family/invites/${revoked.invite.id}/revoke`);
    const messages: string[] = [];
    for (const token of [usedToken, revoked.token, "A".repeat(43)]) {
      await outsider.goto(`/join/${token}`);
      // Înainte de acceptare nu apare nimic despre gospodărie.
      await expect(outsider.getByText(/E2E family/)).toHaveCount(0);
      await outsider.getByTestId("join-accept").click();
      await expect(outsider.getByTestId("join-error")).toContainText(UNAVAILABLE);
      messages.push((await outsider.getByTestId("join-error").textContent()) ?? "");
    }
    expect(new Set(messages).size).toBe(1);
  });

  test("(c) permisiuni pe rol și izolarea între gospodării", async ({ browser, baseURL }) => {
    const member = await pageAs(browser, baseURL!, "family2");
    const outsider = await pageAs(browser, baseURL!, "family3");
    await member.goto("/family");
    await expect(member.getByTestId("family-members")).toBeVisible();
    await expect(member.getByTestId("family-invites")).toHaveCount(0);
    await expect(member.getByRole("button", { name: "Scoate din gospodărie" })).toHaveCount(0);
    expect((await api(member, baseURL!).send("POST", "/api/v1/family/invites", {})).status).toBe(
      403,
    );

    await outsider.goto("/family");
    await expect(
      outsider.getByTestId("family-member").filter({ hasText: "E2E family2" }),
    ).toHaveCount(0);
    expect(
      (await api(outsider, baseURL!).send("GET", `/api/v1/transactions/${splitTxId}/split`)).status,
    ).toBe(404);
  });

  test("(d) ultimul owner nu pleacă; membrul pleacă; fără încălcări CSP", async ({
    browser,
    baseURL,
  }) => {
    const owner = await pageAs(browser, baseURL!, "family");
    const member = await pageAs(browser, baseURL!, "family2");
    await owner.addInitScript(() => {
      const w = window as unknown as { __csp: string[] };
      w.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    await owner.goto("/family");
    const self = owner.getByTestId("family-member").filter({ hasText: "(tu)" });
    await self.getByRole("button", { name: "Părăsește gospodăria" }).click();
    await owner.getByRole("button", { name: "Da, pleacă" }).click();
    await expect(owner.getByText(/Gospodăria trebuie să aibă un proprietar/)).toBeVisible();

    // Membrul pleacă (soldul de 30 lei rămâne: avertisment, nu eroare).
    await member.goto("/family");
    const mine = member.getByTestId("family-member").filter({ hasText: "(tu)" });
    await mine.getByRole("button", { name: "Părăsește gospodăria" }).click();
    await member.getByRole("button", { name: "Da, pleacă" }).click();
    await expect(member).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

    await owner.goto("/family");
    await expect(owner.getByTestId("family-member")).toHaveCount(1);
    // Fostul membru apare în solduri fără nume.
    await expect(owner.getByTestId("family-pairs")).toContainText("fost membru");
    const seen = await owner.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    expect(seen).toEqual([]);
  });
});
