import { describe, expect, it } from "vitest";

import { APP_LOCALES, DEFAULT_APP_LOCALE, isAppLocale, messagesFor, ro } from "./index";

/** Stratul de indirecție pentru texte (ADR 0052): româna e implicită și singura, fără excepții. */

describe("messagesFor", () => {
  it("întoarce româna pentru ro, pentru limbi necunoscute și pentru valori invalide", () => {
    expect(messagesFor("ro")).toBe(ro);
    expect(messagesFor("en")).toBe(ro);
    expect(messagesFor(undefined)).toBe(ro);
    expect(messagesFor(42)).toBe(ro);
  });
  it("lista limbilor aplicației și implicita", () => {
    expect(APP_LOCALES).toEqual(["ro"]);
    expect(DEFAULT_APP_LOCALE).toBe("ro");
    expect(isAppLocale("ro")).toBe(true);
    expect(isAppLocale("en")).toBe(false);
  });
  it("textele nu sunt modificate: cheile de navigare ale modernizării există", () => {
    expect(ro.nav.health).toBe("Sănătate");
    expect(ro.nav.notifications).toBe("Notificări");
    expect(ro.netWorth.title).toBe("Averea netă");
  });
});
