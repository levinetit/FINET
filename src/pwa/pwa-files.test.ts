import { readFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { OFFLINE_HTML } from "./offline-page";
import { SW_SOURCE } from "./sw-source";

/**
 * Fișierele PWA (Faza 9, ADR 0020): pagina `/offline`, rutele `/offline` și `/sw.js`, manifestul
 * și iconițele.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("pagina /offline", () => {
  it("fără script/stil inline și fără `style=` (CSP cu nonce; răspuns servit din cache)", () => {
    expect(OFFLINE_HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(OFFLINE_HTML).not.toMatch(/<style/i);
    expect(OFFLINE_HTML).not.toMatch(/\sstyle\s*=/i);
    expect(OFFLINE_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(OFFLINE_HTML).not.toMatch(/https?:\/\//);
    // Doar resurse de pe aceeași origine, toate în precache-ul service worker-ului.
    const refs = [...OFFLINE_HTML.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    for (const ref of refs.filter((r) => r !== "/dashboard")) {
      expect(SW_SOURCE, ref).toContain(`"${ref}"`);
    }
  });

  it("în română, accesibilă: lang, titlu, h1, regiune de stare", () => {
    expect(OFFLINE_HTML).toContain('<html lang="ro">');
    expect(OFFLINE_HTML).toMatch(/<title>[^<]+<\/title>/);
    expect(OFFLINE_HTML).toMatch(/<h1>[^<]+<\/h1>/);
    expect(OFFLINE_HTML).toContain('role="status"');
    expect(OFFLINE_HTML).toContain('<meta name="viewport"');
  });

  it("ruta /offline: HTML fix, `no-cache`, fără cookie și fără sesiune", async () => {
    const route = await import("@/app/offline/route");
    const res = route.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe(OFFLINE_HTML);
    // Ruta nu importă nimic din sesiune/autentificare/bază.
    const source = read("src/app/offline/route.ts");
    expect(source).not.toMatch(/session|auth|db|cookies|headers\(/i);
  });

  it("scriptul paginii: doar IndexedDB local, fără rețea, fără crearea bazei", () => {
    const js = read("public/pwa/offline.js");
    expect(js).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|eval\(|innerHTML/);
    expect(js).toContain('"finet-offline"');
    expect(js).toContain("transaction.abort()");
  });
});

describe("ruta /sw.js", () => {
  it("antetele: JavaScript, `no-cache`, `Service-Worker-Allowed: /`; versiunea în cod", async () => {
    const route = await import("@/app/sw.js/route");
    const res = route.GET();
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    const body = await res.text();
    expect(body).toMatch(
      /const CONFIG = \{"version":"[A-Za-z0-9_-]+","cacheNextStatic":(true|false)\};/,
    );
  });
});

describe("manifestul și iconițele", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    lang: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  it("câmpurile cerute de instalare (Chromium/Android) și pornirea la dashboard", () => {
    expect(manifest.start_url).toBe("/dashboard");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("ro");
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
    const sizes = (purpose: string) =>
      manifest.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
    expect(sizes("any")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(sizes("maskable")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  });

  it("fiecare iconiță există, e PNG și are dimensiunea declarată; toate sunt în precache", async () => {
    const files = [
      ...manifest.icons.map((i) => ({ src: i.src, size: Number(i.sizes.split("x")[0]) })),
      { src: "/icons/apple-touch-icon.png", size: 180 },
    ];
    for (const { src, size } of files) {
      const meta = await sharp(join(ROOT, "public", src)).metadata();
      expect(meta.format, src).toBe("png");
      expect([meta.width, meta.height], src).toEqual([size, size]);
      expect(SW_SOURCE, src).toContain(`"${src}"`);
    }
    // apple-touch-icon fără transparență (iOS pune negru în locul ei).
    const apple = await sharp(join(ROOT, "public/icons/apple-touch-icon.png")).stats();
    expect(apple.isOpaque).toBe(true);
  });

  it("layout-ul cere manifestul CU credențiale (altfel Access îl blochează) și iconița Apple", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(
      /rel="manifest"[\s\S]{0,80}href="\/manifest\.webmanifest"[\s\S]{0,80}crossOrigin="use-credentials"/,
    );
    expect(layout).toContain("/icons/apple-touch-icon.png");
  });
});
