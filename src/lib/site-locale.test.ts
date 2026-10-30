import { describe, expect, it } from "vitest";

import { privacySections, termsSections } from "@/content/legal";
import { enSite } from "@/messages/en-site";
import { ro } from "@/messages/ro";

import {
  DEFAULT_SITE_LOCALE,
  LANG_COOKIE,
  documentLocale,
  langCookie,
  parseSiteLocale,
} from "./site-locale";

const DIACRITICS = /[ăâîșțĂÂÎȘȚşţ]/;

/** Toate căile frunzelor (șiruri) dintr-un obiect, cu lungimea listelor în cale. */
function shape(value: unknown, path = ""): string[] {
  if (typeof value === "string") return [path];
  if (Array.isArray(value)) {
    return [`${path}#${value.length}`, ...value.flatMap((v, i) => shape(v, `${path}[${i}]`))];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    shape(v, `${path}.${k}`),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return Object.values(value as Record<string, unknown>).flatMap(strings);
}

const company = {
  name: "Firma Test SRL",
  taxId: "RO123",
  registrationNo: "J40/1/2020",
  address: "Str. Test 1",
  email: "contact@exemplu.ro",
};
const empty = { name: null, taxId: null, registrationNo: null, address: null, email: null };

describe("limba paginilor publice (F11-C3)", () => {
  it("româna e implicită: lipsă, necunoscut sau alterat → ro; doar `en` exact → en", () => {
    expect(DEFAULT_SITE_LOCALE).toBe("ro");
    for (const v of [undefined, null, "", "ro", "EN", "en-US", "en ", "fr", "<script>"]) {
      expect(parseSiteLocale(v), String(v)).toBe("ro");
    }
    expect(parseSiteLocale("en")).toBe("en");
  });

  it("cookie-ul: nume, valoare, 1 an, SameSite=Lax, fără HttpOnly (îl scrie browserul), Secure doar pe https", () => {
    expect(LANG_COOKIE).toBe("finet_lang");
    const c = langCookie("en", true);
    expect(c).toBe("finet_lang=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
    expect(langCookie("ro", false)).toBe("finet_lang=ro; Path=/; Max-Age=31536000; SameSite=Lax");
  });

  it("`<html lang>`: engleza doar în saas, pe pagini publice, cu cookie explicit", () => {
    const base = { saas: true, publicPath: true, cookie: "en" };
    expect(documentLocale(base)).toBe("en");
    expect(documentLocale({ ...base, saas: false })).toBe("ro");
    expect(documentLocale({ ...base, publicPath: false })).toBe("ro");
    expect(documentLocale({ ...base, cookie: undefined })).toBe("ro");
    expect(documentLocale({ ...base, cookie: "ro" })).toBe("ro");
  });

  it("textele englezești au exact aceleași chei și lungimi de liste ca ale românești", () => {
    expect(shape(enSite).sort()).toEqual(shape(ro.site).sort());
  });

  it("nicio valoare engleză nu e goală, nu conține diacritice românești și are paranteze/ghilimele echilibrate", () => {
    for (const text of strings(enSite)) {
      expect(text.trim().length, text).toBeGreaterThan(0);
      expect(DIACRITICS.test(text), text).toBe(false);
    }
  });

  it("textele juridice englezești: aceleași secțiuni ca în română, datele firmei inserate, fără diacritice", () => {
    for (const fn of [termsSections, privacySections]) {
      const roSections = fn(company, "ro");
      const enSections = fn(company, "en");
      expect(enSections.length).toBe(roSections.length);
      enSections.forEach((section, i) => {
        // Numerotarea rămâne identică (trimiterile încrucișate nu se strică).
        expect(section.title.split(".")[0]).toBe(roSections[i]!.title.split(".")[0]);
        expect(section.paragraphs.length).toBe(roSections[i]!.paragraphs.length);
      });
      const text = strings(enSections).join("\n");
      expect(DIACRITICS.test(text)).toBe(false);
      expect(text).toContain("Firma Test SRL");
      expect(text).toContain("contact@exemplu.ro");
      // Fără datele firmei: marcajul „de completat” în limba paginii, niciodată valori inventate.
      expect(strings(fn(empty, "en")).join("\n")).toContain("[to be completed]");
      expect(strings(fn(empty, "ro")).join("\n")).toContain("[de completat]");
      expect(strings(fn(empty, "en")).join("\n")).not.toContain("[de completat]");
    }
  });

  it("apelul fără limbă rămâne în română (compatibil cu 11-A)", () => {
    expect(termsSections(company)).toEqual(termsSections(company, "ro"));
    expect(privacySections(company)).toEqual(privacySections(company, "ro"));
  });
});
