import { describe, expect, it } from "vitest";

import { MAX_PERCENT, MoneyError, percentOf } from "./money";

describe("percentOf (procente întregi din bigint)", () => {
  it("floor: trunchiere spre zero", () => {
    expect(percentOf(79n, 100n)).toBe(79);
    expect(percentOf(7999n, 10000n)).toBe(79);
    expect(percentOf(10001n, 10000n)).toBe(100);
    expect(percentOf(10099n, 10000n)).toBe(100);
    expect(percentOf(1n, 3n)).toBe(33);
    expect(percentOf(0n, 5n)).toBe(0);
    expect(percentOf(-1n, 3n)).toBe(-33);
  });

  it("half_away: 0,5 departe de zero", () => {
    expect(percentOf(1n, 8n, "half_away")).toBe(13); // 12,5
    expect(percentOf(-1n, 8n, "half_away")).toBe(-13);
    expect(percentOf(1n, 3n, "half_away")).toBe(33);
    expect(percentOf(2n, 3n, "half_away")).toBe(67);
    expect(percentOf(-50n, -100n, "half_away")).toBe(50);
  });

  it("împărțire la zero → null; plafon ±MAX_PERCENT; doar bigint", () => {
    expect(percentOf(5n, 0n)).toBeNull();
    expect(percentOf(10n ** 15n, 1n)).toBe(MAX_PERCENT);
    expect(percentOf(-(10n ** 15n), 1n)).toBe(-MAX_PERCENT);
    expect(() => percentOf(1 as unknown as bigint, 2n)).toThrow(MoneyError);
  });
});
