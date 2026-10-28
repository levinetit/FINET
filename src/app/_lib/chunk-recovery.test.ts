import { describe, expect, it } from "vitest";

import {
  RELOAD_INTERVAL_MS,
  RELOAD_STORAGE_KEY,
  type StorageLike,
  decideRecovery,
  isChunkLoadError,
  isStaticAssetUrl,
  markReload,
  readLastReload,
} from "./chunk-recovery";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const throwing: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("detectarea fișierelor statice lipsă", () => {
  it("recunoaște erorile de chunk ale bundlerelor și browserelor", () => {
    const named = Object.assign(new Error("x"), { name: "ChunkLoadError" });
    for (const err of [
      named,
      new Error("Loading chunk 123 failed. (error: https://finet.test/_next/static/chunks/1.js)"),
      new Error("Loading CSS chunk app-layout failed"),
      new Error("Failed to load chunk /_next/static/chunks/abc.js from module 42"),
      new TypeError("Failed to fetch dynamically imported module: https://x/_next/static/a.js"),
      new TypeError("error loading dynamically imported module"),
      new TypeError("Importing a module script failed."),
      "Loading chunk 7 failed.",
    ]) {
      expect(isChunkLoadError(err), String(err)).toBe(true);
    }
  });

  it("nu confundă alte erori cu un chunk lipsă", () => {
    for (const err of [
      new Error("Cannot read properties of undefined"),
      new TypeError("Failed to fetch"),
      null,
      undefined,
      42,
      { message: 5 },
    ]) {
      expect(isChunkLoadError(err), String(err)).toBe(false);
    }
  });

  it("doar `/_next/static/` de pe propriul domeniu", () => {
    const o = "https://finet.test";
    expect(isStaticAssetUrl("https://finet.test/_next/static/chunks/a.js", o)).toBe(true);
    expect(isStaticAssetUrl("/_next/static/css/b.css", o)).toBe(true);
    expect(isStaticAssetUrl("https://cdn.test/_next/static/chunks/a.js", o)).toBe(false);
    expect(isStaticAssetUrl("https://finet.test/api/v1/me", o)).toBe(false);
    expect(isStaticAssetUrl("https://finet.test/_next/image?url=x", o)).toBe(false);
    expect(isStaticAssetUrl("http://[::1", o)).toBe(false);
  });
});

describe("marcajul din sessionStorage", () => {
  it("scrie și citește momentul ultimei reîncărcări", () => {
    const s = memoryStorage();
    expect(readLastReload(s)).toBeNull();
    expect(markReload(s, 1_000)).toBe(true);
    expect(s.data.get(RELOAD_STORAGE_KEY)).toBe("1000");
    expect(readLastReload(s)).toBe(1_000);
  });

  it("valoare coruptă = niciun marcaj", () => {
    const s = memoryStorage();
    s.setItem(RELOAD_STORAGE_KEY, "abc");
    expect(readLastReload(s)).toBeNull();
  });

  it("stocarea indisponibilă sau care aruncă", () => {
    expect(readLastReload(null)).toBe("unavailable");
    expect(readLastReload(throwing)).toBe("unavailable");
    expect(markReload(null, 1)).toBe(false);
    expect(markReload(throwing, 1)).toBe(false);
  });
});

describe("decizia: reîncărcare sau banner", () => {
  const now = 1_800_000_000_000;

  it("fără formular murdar și fără reîncărcare recentă: reîncarcă", () => {
    expect(decideRecovery({ now, lastReloadAt: null, dirty: false })).toBe("reload");
    expect(decideRecovery({ now, lastReloadAt: now - RELOAD_INTERVAL_MS, dirty: false })).toBe(
      "reload",
    );
  });

  it("cel mult o dată la 8 secunde (altfel banner, fără buclă)", () => {
    expect(decideRecovery({ now, lastReloadAt: now - 1, dirty: false })).toBe("banner");
    expect(decideRecovery({ now, lastReloadAt: now - RELOAD_INTERVAL_MS + 1, dirty: false })).toBe(
      "banner",
    );
    // Ceasul dat înapoi: tot „prea curând”.
    expect(decideRecovery({ now, lastReloadAt: now + 60_000, dirty: false })).toBe("banner");
  });

  it("un formular necomis nu se pierde: banner", () => {
    expect(decideRecovery({ now, lastReloadAt: null, dirty: true })).toBe("banner");
  });

  it("fără sessionStorage: banner (nu se poate garanta limita de 8 secunde)", () => {
    expect(decideRecovery({ now, lastReloadAt: "unavailable", dirty: false })).toBe("banner");
  });

  it("scenariul complet: prima eroare reîncarcă, a doua (după reîncărcare) dă banner", () => {
    const s = memoryStorage();
    const first = decideRecovery({ now, lastReloadAt: readLastReload(s), dirty: false });
    expect(first).toBe("reload");
    expect(markReload(s, now)).toBe(true);
    const second = decideRecovery({
      now: now + 2_000,
      lastReloadAt: readLastReload(s),
      dirty: false,
    });
    expect(second).toBe("banner");
    const later = decideRecovery({
      now: now + 9_000,
      lastReloadAt: readLastReload(s),
      dirty: false,
    });
    expect(later).toBe("reload");
  });
});
