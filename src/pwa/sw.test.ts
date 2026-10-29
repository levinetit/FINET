import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { SW_SOURCE, buildServiceWorker } from "./sw-source";

/**
 * Service worker-ul (ADR 0020), rulat EXACT cum e servit de `/sw.js` (`buildServiceWorker`),
 * într-un `node:vm` cu `self`, `caches` și `fetch` simulate. Verifică regulile de rutare a
 * cache-ului: ce primește `respondWith`, ce ajunge în cache și ce nu ajunge niciodată.
 */

const ORIGIN = "https://finet.exemplu.invalid";
const abs = (input: string | { url: string }) =>
  new URL(typeof input === "string" ? input : input.url, ORIGIN).href;

class FakeCache {
  readonly map = new Map<string, Response>();
  async match(req: string | { url: string }) {
    return this.map.get(abs(req))?.clone();
  }
  async put(req: string | { url: string }, res: Response) {
    this.map.set(abs(req), res);
  }
  async keys() {
    return [...this.map.keys()].map((url) => ({ url }));
  }
  async delete(req: string | { url: string }) {
    return this.map.delete(abs(req));
  }
}

type Reply = Readonly<{
  status?: number;
  type?: string;
  redirected?: boolean;
  headers?: Record<string, string>;
  body?: string;
}>;

function reply(r: Reply = {}): Response {
  const res = new Response(r.body ?? "x", {
    status: r.status ?? 200,
    headers: r.headers ?? { "content-type": "text/javascript" },
  });
  Object.defineProperty(res, "type", { value: r.type ?? "basic" });
  Object.defineProperty(res, "redirected", { value: r.redirected ?? false });
  return res;
}

type Listener = (event: Record<string, unknown>) => void;

function load(opts: { cacheNextStatic?: boolean; version?: string } = {}) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, FakeCache>();
  const routes = new Map<string, () => Response | Promise<Response>>();
  const fetchMock = vi.fn(async (input: string | { url: string }) => {
    const handler = routes.get(new URL(abs(input)).pathname);
    if (!handler) throw new TypeError("Failed to fetch");
    return handler();
  });
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new FakeCache());
      return stores.get(name)!;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async match(req: string, options: { cacheName?: string } = {}) {
      const list = options.cacheName ? [stores.get(options.cacheName)] : [...stores.values()];
      for (const c of list) {
        const hit = await c?.match(req);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const clientsList = [{ postMessage: vi.fn() }];
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined), matchAll: vi.fn(async () => clientsList) },
    registration: { navigationPreload: { enable: vi.fn(async () => undefined) } },
  };
  class SwRequest extends Request {
    constructor(input: string, init?: RequestInit) {
      super(new URL(input, ORIGIN), init);
    }
  }
  const code = buildServiceWorker({
    version: opts.version ?? "build123",
    cacheNextStatic: opts.cacheNextStatic ?? true,
  });
  runInNewContext(code, { self, caches, fetch: fetchMock, Request: SwRequest, Response, URL });

  async function dispatchFetch(request: {
    url: string;
    method?: string;
    mode?: string;
  }): Promise<Response | null> {
    let responded: Promise<Response> | null = null;
    listeners.get("fetch")!({
      request: { method: "GET", mode: "cors", ...request, url: abs(request.url) },
      preloadResponse: Promise.resolve(undefined),
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    return responded ? await responded : null;
  }
  async function lifecycle(type: "install" | "activate") {
    let waited: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (p: Promise<unknown>) => (waited = p) });
    return waited;
  }
  return { listeners, stores, routes, fetchMock, self, clientsList, dispatchFetch, lifecycle };
}

const STATIC = "finet-static-build123";
const PWA_FILES = [
  "/offline",
  "/pwa/offline.css",
  "/pwa/offline.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

function servePwaFiles(env: ReturnType<typeof load>) {
  for (const path of PWA_FILES) {
    env.routes.set(path, () =>
      reply({
        headers: {
          "content-type": path === "/offline" ? "text/html; charset=utf-8" : "image/png",
          "cache-control": "no-cache",
        },
        body: path === "/offline" ? "<h1>offline</h1>" : "static",
      }),
    );
  }
}

describe("service worker: instalare și activare", () => {
  it("precache: pagina /offline și fișierele PWA, într-un cache versionat; fără skipWaiting", async () => {
    const env = load();
    servePwaFiles(env);
    await env.lifecycle("install");
    const cache = env.stores.get(STATIC)!;
    expect([...cache.map.keys()].sort()).toEqual(PWA_FILES.map((p) => `${ORIGIN}${p}`).sort());
    expect(env.self.skipWaiting).not.toHaveBeenCalled();
  });

  it("un răspuns nepotrivit la precache (login Access, redirect, no-store, 404) → instalarea eșuează, nimic în cache", async () => {
    const bad: Reply[] = [
      { headers: { "content-type": "text/html" }, body: "login" }, // HTML în locul scriptului
      { redirected: true },
      { headers: { "content-type": "text/javascript", "cache-control": "no-store" } },
      { headers: { "content-type": "text/javascript", "cache-control": "private, max-age=0" } },
      { status: 404 },
      { type: "opaque" },
    ];
    for (const r of bad) {
      const env = load();
      servePwaFiles(env);
      env.routes.set("/pwa/offline.js", () => reply(r));
      await expect(env.lifecycle("install")).rejects.toThrow();
      expect(env.stores.get(STATIC)?.map.size ?? 0).toBe(0);
    }
  });

  it("activare: șterge DOAR cache-urile finet-* vechi, activează preîncărcarea, preia clienții", async () => {
    const env = load();
    for (const name of ["finet-static-vechi", "finet-static-build123", "alt-cache"]) {
      const cache = new FakeCache();
      await cache.put("/x", reply());
      env.stores.set(name, cache);
    }
    await env.lifecycle("activate");
    expect([...env.stores.keys()].sort()).toEqual(["alt-cache", "finet-static-build123"]);
    expect(env.self.registration.navigationPreload.enable).toHaveBeenCalled();
    expect(env.self.clients.claim).toHaveBeenCalled();
    expect(env.self.skipWaiting).not.toHaveBeenCalled();
  });

  it("SKIP_WAITING doar la mesajul explicit al paginii", () => {
    const env = load();
    const message = env.listeners.get("message")!;
    message({ data: { type: "ALTCEVA" } });
    message({ data: null });
    expect(env.self.skipWaiting).not.toHaveBeenCalled();
    message({ data: { type: "SKIP_WAITING" } });
    expect(env.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("Background Sync: doar anunță paginile deschise (nu încarcă nimic singur)", async () => {
    const env = load();
    let waited: Promise<unknown> = Promise.resolve();
    env.listeners.get("sync")!({
      tag: "finet-offline-scans",
      waitUntil: (p: Promise<unknown>) => (waited = p),
    });
    await waited;
    expect(env.clientsList[0]!.postMessage).toHaveBeenCalledWith({ type: "FINET_SYNC_SCANS" });
    expect(env.fetchMock).not.toHaveBeenCalled();
    env.listeners.get("sync")!({ tag: "alta", waitUntil: () => undefined });
    expect(env.clientsList[0]!.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("service worker: rutarea cererilor", () => {
  it("NU intervine (fără respondWith) pe API, non-GET, alte origini, RSC și căi necunoscute", async () => {
    const env = load();
    const cases = [
      { url: "/api/v1/accounts" },
      { url: "/api/v1/documents", method: "POST" },
      { url: "/api/v1/events" },
      { url: "/api/auth/get-session" },
      { url: "/api", mode: "navigate" },
      { url: "/api/v1/documents/abc/file", mode: "navigate" },
      { url: "/dashboard?_rsc=abc" },
      { url: "/transactions" },
      { url: "/_next/static/chunks/a.js", method: "POST" },
      { url: "https://alt.exemplu.invalid/_next/static/chunks/a.js" },
      { url: "https://alt.exemplu.invalid/", mode: "navigate" },
      { url: "/icons/icon-192.png?v=2" },
      { url: "/icons/altceva.png" },
      { url: "/offline" }, // ca subresursă (nu navigare)
      { url: "/_next/image?url=x" },
    ];
    for (const c of cases) {
      expect(await env.dispatchFetch(c), JSON.stringify(c)).toBeNull();
    }
    expect(env.fetchMock).not.toHaveBeenCalled();
  });

  it("asset static: cache-first; a doua cerere vine din cache, fără rețea", async () => {
    const env = load();
    env.routes.set("/_next/static/chunks/app-abc.js", () =>
      reply({
        headers: {
          "content-type": "text/javascript",
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
    );
    expect((await env.dispatchFetch({ url: "/_next/static/chunks/app-abc.js" }))!.status).toBe(200);
    expect((await env.dispatchFetch({ url: "/_next/static/chunks/app-abc.js" }))!.status).toBe(200);
    expect(env.fetchMock).toHaveBeenCalledTimes(1);
    expect([...env.stores.get(STATIC)!.map.keys()]).toEqual([
      `${ORIGIN}/_next/static/chunks/app-abc.js`,
    ]);
  });

  it("în dezvoltare (`cacheNextStatic: false`) /_next/static NU e interceptat", async () => {
    const env = load({ cacheNextStatic: false, version: "dev" });
    expect(await env.dispatchFetch({ url: "/_next/static/chunks/app.js" })).toBeNull();
    // Iconițele rămân statice.
    env.routes.set("/icons/icon-192.png", () =>
      reply({ headers: { "content-type": "image/png" } }),
    );
    expect((await env.dispatchFetch({ url: "/icons/icon-192.png" }))!.status).toBe(200);
  });

  it("asset static cu răspuns nepotrivit: trece la pagină, dar NU intră în cache", async () => {
    const bad: Reply[] = [
      { headers: { "content-type": "text/html" } },
      {
        headers: {
          "content-type": "text/javascript",
          "cache-control": "private, no-cache, no-store",
        },
      },
      { redirected: true },
      { status: 206 },
      { status: 500 },
      { type: "opaqueredirect" },
    ];
    for (const r of bad) {
      const env = load();
      env.routes.set("/_next/static/chunks/x.js", () => reply(r));
      const res = await env.dispatchFetch({ url: "/_next/static/chunks/x.js" });
      expect(res).not.toBeNull();
      expect(env.stores.get(STATIC)?.map.size ?? 0, JSON.stringify(r)).toBe(0);
    }
  });

  it("navigare: doar rețea, nimic în cache (HTML autentificat)", async () => {
    const env = load();
    env.routes.set("/dashboard", () =>
      reply({
        headers: { "content-type": "text/html", "cache-control": "private, no-cache, no-store" },
        body: "<p>sold</p>",
      }),
    );
    const res = await env.dispatchFetch({ url: "/dashboard", mode: "navigate" });
    expect(await res!.text()).toBe("<p>sold</p>");
    expect(env.stores.get(STATIC)?.map.size ?? 0).toBe(0);
  });

  it("navigare fără rețea → /offline din cache; 4xx/5xx de la server NU înseamnă offline", async () => {
    const env = load();
    servePwaFiles(env);
    await env.lifecycle("install");
    // Rețea căzută: fetch respinge.
    const offline = await env.dispatchFetch({ url: "/transactions", mode: "navigate" });
    expect(await offline!.text()).toBe("<h1>offline</h1>");
    // Serverul răspunde cu eroare: pagina vede eroarea reală.
    env.routes.set("/budgets", () =>
      reply({ status: 502, headers: { "content-type": "text/html" } }),
    );
    const error = await env.dispatchFetch({ url: "/budgets", mode: "navigate" });
    expect(error!.status).toBe(502);
  });

  it("navigare fără rețea și fără /offline în cache → 503 text, fără date", async () => {
    const env = load();
    const res = await env.dispatchFetch({ url: "/import", mode: "navigate" });
    expect(res!.status).toBe(503);
    expect(res!.headers.get("cache-control")).toBe("no-store");
  });

  it("cache-ul static are un plafon de intrări (cele mai vechi pleacă)", async () => {
    const env = load();
    for (let i = 0; i < 405; i++) {
      env.routes.set(`/_next/static/chunks/c${i}.js`, () => reply());
      await env.dispatchFetch({ url: `/_next/static/chunks/c${i}.js` });
    }
    const keys = [...env.stores.get(STATIC)!.map.keys()];
    expect(keys.length).toBe(400);
    expect(keys[0]).toBe(`${ORIGIN}/_next/static/chunks/c5.js`);
  });
});

describe("buildServiceWorker", () => {
  it("versiunea e validată (fără injecție în codul servit)", () => {
    for (const bad of ["", "a b", 'x";alert(1)//', "x".repeat(65), "../x"]) {
      expect(() => buildServiceWorker({ version: bad, cacheNextStatic: true })).toThrow();
    }
    const code = buildServiceWorker({ version: "abc_DEF-123", cacheNextStatic: false });
    expect(code).toContain('const CONFIG = {"version":"abc_DEF-123","cacheNextStatic":false};');
    expect(code).not.toContain("__FINET_SW_CONFIG__");
    expect(SW_SOURCE.match(/__FINET_SW_CONFIG__/g)?.length).toBe(1);
  });

  it("codul nu apelează skipWaiting decât în ascultătorul de mesaje", () => {
    expect(SW_SOURCE.match(/skipWaiting\(/g)?.length).toBe(1);
    expect(SW_SOURCE).not.toMatch(/importScripts|eval\(|new Function/);
  });
});
