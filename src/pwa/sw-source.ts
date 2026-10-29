/**
 * Codul service worker-ului FINET (Faza 9, ADR 0020), ca text: ruta `/sw.js`
 * (`src/app/sw.js/route.ts`) îl servește după ce înlocuiește `__FINET_SW_CONFIG__` cu
 * configurația (`buildServiceWorker`), iar testele (`sw.test.ts`) rulează EXACT același text
 * într-un `node:vm`. JavaScript simplu (ES2020), fără importuri și fără biblioteci.
 *
 * Reguli (master prompt, Faza 9; SECURITY_CHECKLIST §SW):
 * - cache DOAR pentru asset-urile statice (`/_next/static/**` în producție, iconițele,
 *   manifestul, fișierele paginii `/offline`) și pagina `/offline`;
 * - NICIODATĂ pentru API (`/api/**`), metode non-GET, alte origini, navigări (HTML autentificat),
 *   răspunsuri redirecționate, non-200, `no-store`/`private` sau HTML (în afară de `/offline`);
 *   `Set-Cookie` nu e vizibil în service worker (antet interzis), de aceea paginile cu sesiune
 *   sunt excluse după cale și după `Cache-Control`, iar `/offline` nu citește sesiunea;
 * - cererile care nu sunt ale noastre nu primesc `respondWith` (trec direct la rețea: încărcările
 *   multipart și fluxul SSE nu sunt atinse);
 * - navigări: doar rețea; la eșec de REȚEA (nu la 4xx/5xx) → `/offline` din cache;
 * - actualizare controlată: versiunea nouă așteaptă (`waiting`) până când pagina trimite
 *   `SKIP_WAITING` (butonul „Actualizează” din banner); fără `skipWaiting()` automat;
 * - la activare se șterg cache-urile `finet-*` ale versiunilor vechi; cache-ul static are un
 *   plafon de intrări (cele mai vechi pleacă primele).
 */
export const SW_SOURCE = String.raw`"use strict";
const CONFIG = __FINET_SW_CONFIG__;
const PREFIX = "finet-";
const STATIC_CACHE = PREFIX + "static-" + CONFIG.version;
const OFFLINE_URL = "/offline";
const MAX_STATIC_ENTRIES = 400;
const SYNC_TAG = "finet-offline-scans";
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
const PWA_STATIC = new Set(PWA_FILES.slice(1));

function classify(request) {
  if (request.method !== "GET") return "bypass";
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== self.location.origin) return "bypass";
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/")) return "bypass";
  if (request.mode === "navigate") return "navigate";
  if (url.search === "" && PWA_STATIC.has(path)) return "static";
  if (CONFIG.cacheNextStatic && path.startsWith("/_next/static/")) return "static";
  return "bypass";
}

function isCacheable(path, response) {
  if (!response || response.status !== 200 || response.type !== "basic" || response.redirected) {
    return false;
  }
  const cacheControl = (response.headers.get("cache-control") || "").toLowerCase();
  if (cacheControl.includes("no-store") || cacheControl.includes("private")) return false;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (type.startsWith("text/html") && path !== OFFLINE_URL) return false;
  return true;
}

async function precache() {
  const responses = [];
  for (const path of PWA_FILES) {
    const response = await fetch(new Request(path, { credentials: "same-origin", cache: "no-cache" }));
    // Un răspuns greșit (de exemplu pagina de login Access) oprește instalarea ÎNAINTE de orice
    // scriere; browserul reîncearcă la următoarea vizită. Nimic nepotrivit nu ajunge în cache.
    if (!isCacheable(path, response)) throw new Error("precache");
    responses.push([path, response]);
  }
  const cache = await caches.open(STATIC_CACHE);
  for (const [path, response] of responses) await cache.put(path, response);
}

async function trim(cache) {
  const keys = await cache.keys();
  const extra = keys.length - MAX_STATIC_ENTRIES;
  for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  const path = new URL(request.url).pathname;
  if (isCacheable(path, response)) {
    await cache.put(request, response.clone());
    await trim(cache);
  }
  return response;
}

async function offlineFallback() {
  const cached = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  return new Response("FINET: nu există conexiune la internet.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function networkOrOffline(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    return offlineFallback();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(PREFIX) && name !== STATIC_CACHE)
          .map((name) => caches.delete(name)),
      );
      if (self.registration && self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const kind = classify(event.request);
  if (kind === "static") event.respondWith(cacheFirst(event.request));
  else if (kind === "navigate") event.respondWith(networkOrOffline(event));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Background Sync (unde există): doar trezește paginile deschise, care încarcă scanările din
// IndexedDB (service worker-ul nu atinge pozele). Fără pagini deschise nu se întâmplă nimic;
// încărcarea are loc la următoarea deschidere a aplicației.
self.addEventListener("sync", (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window" })
      .then((list) => list.forEach((client) => client.postMessage({ type: "FINET_SYNC_SCANS" }))),
  );
});
`;

export type ServiceWorkerConfig = Readonly<{
  /** Versiunea cache-ului (BUILD_ID-ul Next sau `dev`); doar `[A-Za-z0-9_-]`. */
  version: string;
  /** Cache pentru `/_next/static/**` (doar producție: în dezvoltare fișierele nu sunt imuabile). */
  cacheNextStatic: boolean;
}>;

const VERSION = /^[A-Za-z0-9_-]{1,64}$/;

/** Textul final al service worker-ului, cu configurația validată (aruncă pe o versiune invalidă). */
export function buildServiceWorker(config: ServiceWorkerConfig): string {
  if (!VERSION.test(config.version)) throw new Error("versiune SW invalidă");
  const json = JSON.stringify({
    version: config.version,
    cacheNextStatic: config.cacheNextStatic === true,
  });
  return SW_SOURCE.replace("__FINET_SW_CONFIG__", json);
}
