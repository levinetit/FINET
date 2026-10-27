import { describe, expect, it } from "vitest";

import { DEFAULT_AFTER_LOGIN, loginUrlFor, safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("acceptă căile relative interne, cu interogare și fragment", () => {
    expect(safeNextPath("/profile")).toBe("/profile");
    expect(safeNextPath("/dashboard?luna=2026-10#sus")).toBe("/dashboard?luna=2026-10#sus");
    expect(safeNextPath(["/profile", "/altceva"])).toBe("/profile");
    expect(safeNextPath("/a/../profile")).toBe("/profile");
  });

  it.each([
    ["lipsă", undefined],
    ["null", null],
    ["șir gol", ""],
    ["număr", 42],
    ["obiect", { next: "/profile" }],
    ["URL absolut", "https://evil.com/"],
    ["schemă javascript", "javascript:alert(1)"],
    ["schemă fără slash", "https:evil.com"],
    ["protocol-relativ", "//evil.com"],
    ["protocol-relativ cu cale", "//evil.com/dashboard"],
    ["trei slash-uri", "///evil.com"],
    ["backslash", "/\\evil.com"],
    ["backslash dublu", "\\\\evil.com"],
    ["slash codificat", "/%2F%2Fevil.com"],
    ["slash codificat (litere mici)", "/%2f/evil.com"],
    ["backslash codificat", "/%5Cevil.com"],
    ["dublu codificat", "/%252F%252Fevil.com"],
    ["tab (eliminat de browser)", "/\t/evil.com"],
    ["LF", "/\n/evil.com"],
    ["CR", "/profile\r\nSet-Cookie: x=1"],
    ["NUL", "/profile\u0000"],
    ["spațiu", "/ /evil.com"],
    ["separator Unicode", "/\u2028/evil.com"],
    ["procent invalid", "/%E0%A4%A"],
    ["relativ fără slash", "profile"],
    ["bucla spre login", "/login?next=/profile"],
    ["login cu majuscule", "/LOGIN"],
    ["API", "/api/v1/me"],
    ["prea lung", `/${"a".repeat(600)}`],
    // H1: dot-segmente care devin `//evil.com` după normalizarea URL-ului.
    ["dot-segment /.//", "/.//evil.com"],
    ["dot-segment /a/..//", "/a/..//evil.com"],
    ["dot-segment codificat /%2e//", "/%2e//evil.com"],
    ["dot-segment /x/..//", "/x/..//evil.com"],
    ["dot-segment cu backslash", "/./\\/evil.com"],
    ["dot-segment dublu codificat", "/%252e//evil.com"],
    ["dot-segment cu cale", "/./..//evil.com/dashboard"],
  ])("respinge %s → pagina implicită", (_label, raw) => {
    expect(safeNextPath(raw)).toBe(DEFAULT_AFTER_LOGIN);
  });
});

describe("safeNextPath: proprietatea rezultatului (H1)", () => {
  const pieces = [
    "/",
    ".",
    "..",
    "%2e",
    "%2E",
    "%2f",
    "%5c",
    "\\",
    "evil.com",
    "a",
    "?",
    "#",
    "//",
    "%252e",
  ];

  it("orice rezultat începe cu un singur `/` și rămâne pe origine", () => {
    // Combinații deterministe de fragmente (fără aleator, ca testul să fie reproductibil).
    let checked = 0;
    for (const a of pieces) {
      for (const b of pieces) {
        for (const c of pieces) {
          const out = safeNextPath(`/${a}${b}${c}`);
          expect(out, `/${a}${b}${c}`).toMatch(/^\/(?!\/)/);
          expect(out).not.toContain("\\");
          expect(new URL(out, "https://finet.invalid").origin).toBe("https://finet.invalid");
          checked++;
        }
      }
    }
    expect(checked).toBe(pieces.length ** 3);
  });
});

describe("loginUrlFor", () => {
  it("codifică ținta validată", () => {
    expect(loginUrlFor("/profile")).toBe("/login?next=%2Fprofile");
    expect(loginUrlFor("//evil.com")).toBe("/login?next=%2Fdashboard");
  });
});
