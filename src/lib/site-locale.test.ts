import { describe, expect, it } from "vitest";

import { privacySections, termsSections } from "@/content/legal";
import { deSite } from "@/messages/de-site";
import { enSite, type SiteMessages } from "@/messages/en-site";
import { esSite } from "@/messages/es-site";
import { frSite } from "@/messages/fr-site";
import { itSite } from "@/messages/it-site";
import { plSite } from "@/messages/pl-site";
import { ro } from "@/messages/ro";
import { trSite } from "@/messages/tr-site";

import {
  DEFAULT_SITE_LOCALE,
  LANG_COOKIE,
  SITE_LOCALES,
  SITE_LOCALE_NAMES,
  type SiteLocale,
  documentLocale,
  langCookie,
  legalLocale,
  parseSiteLocale,
} from "./site-locale";

/**
 * Literele specifice românei: `ă` și `ș`/`ț` cu virgulă dedesubt. `â`/`î` (valide în franceză) și
 * `ş` cu sedilă (valid în turcă) NU intră aici.
 */
const RO_ONLY = /[ăĂșțȘȚ]/;
const DIACRITICS = /[ăâîșțĂÂÎȘȚşţ]/;

/** Textele fiecărei limbi, în afară de română (referința). */
const TRANSLATIONS: Readonly<Record<Exclude<SiteLocale, "ro">, SiteMessages>> = {
  en: enSite,
  es: esSite,
  fr: frSite,
  de: deSite,
  it: itSite,
  pl: plSite,
  tr: trSite,
};

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
    for (const v of [
      undefined,
      null,
      "",
      "ro",
      "EN",
      "en-US",
      "en ",
      "FR",
      "fr-FR",
      " de",
      "xx",
      "ru",
      "<script>",
    ]) {
      expect(parseSiteLocale(v), String(v)).toBe("ro");
    }
    // Exact lista permisă (ADR 0033): fiecare limbă acceptată doar cu codul ei exact.
    expect([...SITE_LOCALES]).toEqual(["ro", "en", "es", "fr", "de", "it", "pl", "tr"]);
    for (const l of SITE_LOCALES) expect(parseSiteLocale(l), l).toBe(l);
    expect(Object.keys(SITE_LOCALE_NAMES).sort()).toEqual([...SITE_LOCALES].sort());
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
    // Limbile noi (Faza 13) respectă aceleași reguli; o valoare străină cade pe română.
    for (const l of ["es", "fr", "de", "it", "pl", "tr"] as const) {
      expect(documentLocale({ ...base, cookie: l }), l).toBe(l);
      expect(documentLocale({ ...base, cookie: l, saas: false }), l).toBe("ro");
      expect(documentLocale({ ...base, cookie: l, publicPath: false }), l).toBe("ro");
    }
    expect(documentLocale({ ...base, cookie: "ru" })).toBe("ro");
  });

  it("fiecare limbă are exact aceleași chei și lungimi de liste ca româna (fără texte lipsă)", () => {
    for (const [locale, messages] of Object.entries(TRANSLATIONS)) {
      expect(shape(messages).sort(), locale).toEqual(shape(ro.site).sort());
    }
  });

  it("nicio valoare tradusă nu e goală; fără litere românești (ă ș ț) în afară de română; engleza fără niciun diacritic românesc", () => {
    for (const [locale, messages] of Object.entries(TRANSLATIONS)) {
      for (const text of strings(messages)) {
        expect(text.trim().length, `${locale}: ${text}`).toBeGreaterThan(0);
        expect(RO_ONLY.test(text), `${locale}: ${text}`).toBe(false);
        if (locale === "en") expect(DIACRITICS.test(text), text).toBe(false);
      }
    }
  });

  it("identificatorii secțiunilor de suport sunt aceiași în toate limbile (ancore stabile) și titlurile sunt traduse", () => {
    const ids = ro.site.support.sections.map((s) => s.id);
    for (const [locale, messages] of Object.entries(TRANSLATIONS)) {
      expect(
        messages.support.sections.map((s) => s.id),
        locale,
      ).toEqual(ids);
      // Titlul paginii nu rămâne cel românesc (un text netradus s-ar vedea imediat).
      expect(messages.support.title, locale).not.toBe(ro.site.support.title);
      expect(messages.landing.cta, locale).not.toBe(ro.site.landing.cta);
    }
  });

  it("textele juridice: româna rămâne referința, orice altă limbă primește textul englez; marcajul lipsă e în limba textului", () => {
    expect(legalLocale("ro")).toBe("ro");
    for (const l of ["en", "es", "fr", "de", "it", "pl", "tr"] as const) {
      expect(legalLocale(l), l).toBe("en");
      expect(termsSections(company, l), l).toEqual(termsSections(company, "en"));
      expect(privacySections(company, l), l).toEqual(privacySections(company, "en"));
      expect(strings(termsSections(empty, l)).join("\n"), l).toContain("[to be completed]");
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
