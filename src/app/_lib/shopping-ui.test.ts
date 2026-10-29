import { describe, expect, it } from "vitest";

import { displayQuantity, moveId, parseQuantityInput, quantityLabel } from "./shopping-ui";

describe("parseQuantityInput", () => {
  it("forma canonică, virgula zecimală, golul = implicit", () => {
    expect(parseQuantityInput("2")).toBe("2");
    expect(parseQuantityInput(" 0,5 ")).toBe("0.5");
    expect(parseQuantityInput("1.250")).toBe("1.25");
    expect(parseQuantityInput("007")).toBe("7");
    expect(parseQuantityInput("")).toBe("");
    expect(parseQuantityInput("   ")).toBe("");
  });
  it("respinge zero, negativ, prea multe zecimale, litere", () => {
    for (const bad of ["0", "0,000", "-1", "1,2345", "1e3", "abc", "1.2.3", "1000000"]) {
      expect(parseQuantityInput(bad), bad).toBeNull();
    }
  });
});

describe("afișare", () => {
  it("cantitate cu virgulă și etichetă", () => {
    expect(displayQuantity("0.5")).toBe("0,5");
    expect(quantityLabel("1", null)).toBe("");
    expect(quantityLabel("2", null)).toBe("2 ×");
    expect(quantityLabel("0.5", "kg")).toBe("0,5 kg");
    expect(quantityLabel("1", "kg")).toBe("1 kg");
  });
});

describe("moveId", () => {
  it("mută cu o poziție și nu iese din listă", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    expect(moveId(["a", "b"], "zzz", 1)).toEqual(["a", "b"]);
  });
});
