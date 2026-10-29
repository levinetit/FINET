import { describe, expect, it } from "vitest";

import {
  INSTALL_DISMISSED_KEY,
  installMode,
  isIosDevice,
  readDismissed,
  writeDismissed,
} from "./pwa-ui";

/** Invitația de instalare (Faza 9, ADR 0020). */

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("invitația de instalare", () => {
  it("odată închisă nu mai reapare (preferința locală)", () => {
    const storage = memoryStorage();
    expect(readDismissed(storage)).toBe(false);
    expect(writeDismissed(storage)).toBe(true);
    expect(storage.map.get(INSTALL_DISMISSED_KEY)).toBe("1");
    expect(readDismissed(storage)).toBe(true);
  });

  it("stocarea indisponibilă sau care aruncă nu strică pagina", () => {
    expect(readDismissed(null)).toBe(false);
    expect(writeDismissed(null)).toBe(false);
    expect(readDismissed(throwing)).toBe(false);
    expect(writeDismissed(throwing)).toBe(false);
  });

  it("modul: prompt (Chromium), instrucțiuni iOS sau nimic", () => {
    const base = { dismissed: false, standalone: false, hasPrompt: false, ios: false };
    expect(installMode(base)).toBe("none");
    expect(installMode({ ...base, hasPrompt: true })).toBe("prompt");
    expect(installMode({ ...base, ios: true })).toBe("ios");
    expect(installMode({ ...base, hasPrompt: true, dismissed: true })).toBe("none");
    expect(installMode({ ...base, ios: true, standalone: true })).toBe("none");
  });

  it("detectarea iPhone/iPad (inclusiv iPadOS ca Mac cu ecran tactil)", () => {
    expect(isIosDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIosDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
    expect(isIosDevice("Mozilla/5.0 (Linux; Android 15; Pixel 8)", 5)).toBe(false);
  });
});
