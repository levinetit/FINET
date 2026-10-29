import { describe, expect, it } from "vitest";

import { formatBasisPoints, joinLink, memberName, parsePercentInput } from "./family-ui";

describe("interfața familiei (funcții pure)", () => {
  const members = [
    { userId: "a", name: "Ana" },
    { userId: "b", name: "Bogdan" },
  ];

  it("numele: tu, membrul, fost membru", () => {
    expect(memberName("a", members, "a")).toBe("Ana (tu)");
    expect(memberName("b", members, "a")).toBe("Bogdan");
    expect(memberName("x", members, "a")).toBe("fost membru");
  });

  it("procentele → puncte de bază exacte, fără float", () => {
    expect(parsePercentInput("33,33")).toEqual({ ok: true, basisPoints: 3333 });
    expect(parsePercentInput("33.34")).toEqual({ ok: true, basisPoints: 3334 });
    expect(parsePercentInput("50")).toEqual({ ok: true, basisPoints: 5000 });
    expect(parsePercentInput("100")).toEqual({ ok: true, basisPoints: 10000 });
    expect(parsePercentInput("")).toEqual({ ok: true, basisPoints: 0 });
    expect(parsePercentInput("100,01").ok).toBe(false);
    expect(parsePercentInput("12,345").ok).toBe(false);
    expect(parsePercentInput("abc").ok).toBe(false);
  });

  it("punctele de bază → text", () => {
    expect(formatBasisPoints(3333)).toBe("33,33");
    expect(formatBasisPoints(5000)).toBe("50");
    expect(formatBasisPoints(5)).toBe("0,05");
    expect(formatBasisPoints(10000)).toBe("100");
  });

  it("linkul de invitație", () => {
    expect(joinLink("https://finet.example/", "/join/abc")).toBe("https://finet.example/join/abc");
  });
});
