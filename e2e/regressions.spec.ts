import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { type Browser, type Page, expect } from "@playwright/test";

import { MODE, loginOk, password, userEmail, test } from "./fixtures";

/**
 * Regresii din analiza finpulse.day (Faza 4, proiectul `regressions`, server `next dev` pe
 * Postgres-ul de test, ca `ledger`):
 * (a) paginile publice cer resurse DOAR de pe propriul domeniu (fără Google Fonts, analytics,
 *     CDN-uri);
 * (b) cererile RSC (`?_rsc=…`, `RSC: 1`, cu și fără `Next-Router-Prefetch`) ale oricărei rute private, FĂRĂ sesiune, nu întorc
 *     date: un marcaj unic creat de utilizatorul `regresii` lipsește din răspuns, iar răspunsul e
 *     o redirecționare spre `/login` (antet sau, la 200, redirecționarea codată în fluxul RSC);
 *     cu sesiune, același marcaj apare (dovada că verificarea poate eșua);
 * (c) titluri unice și `lang="ro"` pe rutele principale.
 *
 * Rutele private se citesc din `src/app/(app)/**\/page.tsx` (o rută nouă e acoperită automat);
 * segmentele `[id]` primesc un uuid aleator.
 */

const APP_DIR = join(import.meta.dirname, "..", "src", "app", "(app)");
const MARKER = `regresii-${MODE}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

function pageFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pageFiles(path, out);
    else if (name === "page.tsx") out.push(path);
  }
  return out;
}

/** `src/app/(app)/accounts/[id]/page.tsx` → `/accounts/<uuid>`. */
function privateRoutes(): { route: string; dynamic: boolean }[] {
  return pageFiles(APP_DIR)
    .map((file) => relative(APP_DIR, file).split(sep).slice(0, -1))
    .map((parts) => ({
      route: `/${parts.map((p) => (/^\[.+\]$/.test(p) ? randomUUID() : p)).join("/")}`,
      dynamic: parts.some((p) => /^\[.+\]$/.test(p)),
    }))
    .sort((a, b) => a.route.localeCompare(b.route));
}

const ROUTES = privateRoutes();
const STATIC_ROUTES = ROUTES.filter((r) => !r.dynamic).map((r) => r.route);

async function loggedIn(browser: Browser, baseURL: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await loginOk(page, userEmail("regresii"), password());
  return page;
}

const RSC_HEADERS = { RSC: "1", "Next-Router-Prefetch": "1" };

test.describe.configure({ mode: "serial" });

test("rutele private au fost găsite", () => {
  expect(STATIC_ROUTES).toContain("/dashboard");
  expect(STATIC_ROUTES).toContain("/accounts");
  expect(ROUTES.length).toBeGreaterThan(15);
});

test("(a) paginile publice cer resurse doar de pe propriul domeniu", async ({
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL!);
  // `/` redirecționează la `/login`; `/register` e 404 în `personal` (tot o pagină publică).
  for (const path of ["/", "/login", "/register", "/nu-exista"]) {
    const ctx = await browser.newContext({ baseURL });
    const page = await ctx.newPage();
    const foreign: string[] = [];
    page.on("request", (req) => {
      const url = new URL(req.url());
      if (url.protocol === "data:" || url.protocol === "blob:") return;
      // `ws:` = HMR-ul serverului de dezvoltare, pe același host.
      if (url.host !== origin.host) foreign.push(req.url());
    });
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(foreign, path).toEqual([]);
    await ctx.close();
  }
});

test("(b) prefetch RSC fără sesiune nu întoarce date, pe toate rutele private", async ({
  browser,
  baseURL,
  playwright,
}) => {
  test.slow();
  // Marcajul: un cont cu nume unic, al utilizatorului `regresii`.
  const page = await loggedIn(browser, baseURL!);
  const created = await page.request.post("/api/v1/accounts", {
    data: { name: MARKER, type: "cash", currency: "RON" },
    headers: { Origin: new URL(baseURL!).origin },
  });
  expect(created.status(), await created.text()).toBe(201);

  // Cu sesiune, marcajul apare în cererea RSC completă (navigare, fără `Next-Router-Prefetch`:
  // prefetch-ul unei rute dinamice se oprește la granița de încărcare) a listei de conturi.
  // Redirecționările se urmăresc (maxim 3): serverul poate normaliza adresa (307 către aceeași
  // rută); proprietatea verificată e că, ȘI cu sesiune, conținutul ajunge în răspunsul RSC. Fără
  // sesiune (mai jos) redirecționările NU se urmăresc.
  const withSession = await page.request.get(`/accounts?_rsc=${randomUUID().slice(0, 5)}`, {
    headers: { RSC: "1" },
    maxRedirects: 3,
  });
  expect(
    withSession.status(),
    `${withSession.url()} (location: ${withSession.headers()["location"] ?? "-"})`,
  ).toBe(200);
  expect(await withSession.text()).toContain(MARKER);
  await page.context().close();

  // Fără sesiune: un context HTTP nou, fără cookie-uri.
  const anon = await playwright.request.newContext({ baseURL });
  for (const { route } of ROUTES) {
    for (const prefetch of [true, false]) {
      const response = await anon.get(`${route}?_rsc=${randomUUID().slice(0, 5)}`, {
        headers: prefetch ? RSC_HEADERS : { RSC: "1" },
        maxRedirects: 0,
      });
      const status = response.status();
      const body = await response.text();
      const label = `${route} (prefetch=${prefetch}) → ${status}`;
      // Proprietatea de securitate, strictă în ambele cazuri: nicio dată a utilizatorului.
      expect(body, label).not.toContain(MARKER);
      if (prefetch) {
        // Prefetch: poate fi doar scheletul până la granița de încărcare (200, fără pagină).
        expect([200, 301, 302, 303, 307, 308, 401, 403, 404], label).toContain(status);
        continue;
      }
      if (status >= 300 && status < 400) {
        // 307 către aceeași rută cu `_rsc` canonic (Next normalizează parametrul) sau direct către
        // /login. Urmărim lanțul (maxim 3 salturi): destinația finală trebuie să fie /login, fără
        // conținutul paginii private.
        const location = response.headers()["location"] ?? "";
        if (!location.includes("/login")) {
          const followed = await anon.get(`${route}?_rsc=${randomUUID().slice(0, 5)}`, {
            headers: { RSC: "1" },
            maxRedirects: 3,
          });
          const followedBody = await followed.text();
          expect(followedBody, label).not.toContain(MARKER);
          expect(`${followed.url()} ${followedBody}`, label).toContain("/login");
        }
      } else if (status === 200) {
        // Redirecționarea `redirect()` codată în fluxul RSC, fără conținutul paginii.
        expect(body, label).toContain("/login");
      } else {
        expect([401, 403, 404], label).toContain(status);
      }
    }
  }
  await anon.dispose();
});

test("(c) titluri unice și lang=ro pe rutele principale", async ({ browser, baseURL }) => {
  test.slow();
  const page = await loggedIn(browser, baseURL!);
  const titles = new Map<string, string>();
  for (const route of STATIC_ROUTES) {
    await page.goto(route);
    await expect(page.locator("html")).toHaveAttribute("lang", "ro");
    await expect(page.locator("main#continut")).toHaveCount(1);
    const title = await page.title();
    expect(title, route).toMatch(/ · FINET$/);
    titles.set(route, title);
  }
  const values = [...titles.values()];
  expect(new Set(values).size, JSON.stringify(Object.fromEntries(titles))).toBe(values.length);

  // „Sari la conținut”: primul Tab îl afișează, Enter mută focusul pe conținut.
  await page.goto("/dashboard");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Sari la conținut" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#continut")).toBeFocused();
  await page.context().close();

  // Pagina de login (publică).
  const ctx = await browser.newContext({ baseURL });
  const login = await ctx.newPage();
  await login.goto("/login");
  await expect(login.locator("html")).toHaveAttribute("lang", "ro");
  expect(await login.title()).not.toBe(values[0]);
  await ctx.close();
});
