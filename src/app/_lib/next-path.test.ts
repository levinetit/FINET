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
  ])("respinge %s → pagina implicită", (_label, raw) => {
    expect(safeNextPath(raw)).toBe(DEFAULT_AFTER_LOGIN);
  });
});

describe("loginUrlFor", () => {
  it("codifică ținta validată", () => {
    expect(loginUrlFor("/profile")).toBe("/login?next=%2Fprofile");
    expect(loginUrlFor("//evil.com")).toBe("/login?next=%2Fdashboard");
  });
});
