import { describe, expect, it } from "vitest";

import { normalizeProductName } from "@/modules/receipts/normalize";

import {
  comparisonQuantity,
  divRound,
  divRoundHalfAway,
  parseSize,
  productKeyOf,
  quantityMilli,
  toMilli,
  unitPriceMinor,
} from "./units";

const size = (raw: string, qty = "1") => parseSize(normalizeProductName(raw)!, quantityMilli(qty));

describe("conversii de unități (bigint, fără float)", () => {
  it("miimi exacte din text zecimal", () => {
    expect(toMilli("0.5")).toBe(500n);
    expect(toMilli("1.234")).toBe(1234n);
    expect(toMilli("12")).toBe(12000n);
    expect(quantityMilli(null)).toBe(1000n);
    expect(quantityMilli("0.754")).toBe(754n);
  });

  it("rotunjirea jumătate în sus și jumătate dinspre zero", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRoundHalfAway(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfAway(5n, 2n)).toBe(3n);
    expect(divRoundHalfAway(-4n, 3n)).toBe(-1n);
  });

  it("masă: g ↔ kg în aceeași unitate standard (kg)", () => {
    const g = size("PAINE FELIATA 500G");
    const kg = size("ZAHAR 1KG");
    expect(g).toMatchObject({
      kind: "sized",
      unit: "kg",
      packMilli: 500n,
      baseName: "paine feliata",
    });
    expect(kg).toMatchObject({ kind: "sized", unit: "kg", packMilli: 1000n, baseName: "zahar" });
    expect(size("MERE 1.5KG")).toMatchObject({ unit: "kg", packMilli: 1500n });
  });

  it("volum: ml ↔ cl ↔ l în aceeași unitate standard (l)", () => {
    expect(size("SAMPON HAIR 400ML")).toMatchObject({ unit: "l", packMilli: 400n });
    expect(size("BERE 33CL")).toMatchObject({ unit: "l", packMilli: 330n });
    expect(size("APA PLATA 2L")).toMatchObject({
      unit: "l",
      packMilli: 2000n,
      baseName: "apa plata",
    });
    expect(size("SUC 0,5 L")).toMatchObject({ unit: "l", packMilli: 500n });
  });

  it("bucăți și ambalaje multiple", () => {
    expect(size("OUA M 10 BUC")).toMatchObject({
      unit: "buc",
      packMilli: 10000n,
      baseName: "oua m",
    });
    expect(size("BERE 6X0.5L")).toMatchObject({ unit: "l", packMilli: 3000n, baseName: "bere" });
    expect(size("BERE 6 X 0,5 L")).toMatchObject({ unit: "l", packMilli: 3000n });
  });

  it("fără mărime: preț pe unitate de vânzare; procentele și codurile nu sunt mărimi", () => {
    expect(size("BANANE", "1.254")).toEqual({ kind: "unsized", baseName: "banane" });
    expect(size("BEC LED E27 9W", "3")).toMatchObject({ kind: "unsized" });
    expect(size("LAPTE 1,5% 1L")).toMatchObject({ unit: "l", baseName: "lapte 1.5%" });
    expect(size("SURUBELNITA SET 6 BUC")).toMatchObject({
      unit: "buc",
      baseName: "surubelnita set",
    });
  });

  it("ambiguu → exclus (nu ghicim)", () => {
    expect(size("APA 2L 6 BUC")).toEqual({ kind: "ambiguous" });
    expect(size("CEVA 0.5G")).toEqual({ kind: "ambiguous" });
    // Produs cântărit: numele repetă greutatea vândută (cantitate zecimală = mărime).
    expect(size("BANANE 1,234 KG", "1.234")).toEqual({ kind: "ambiguous" });
    // Cantitate întreagă = un singur ambalaj de 1 kg, nu produs cântărit.
    expect(size("ZAHAR 1KG", "1")).toMatchObject({ kind: "sized" });
    expect(size("500G")).toEqual({ kind: "ambiguous" });
    expect(productKeyOf(size("APA 2L 6 BUC"))).toBeNull();
  });

  it("cheia de produs: același produs în ambalaje diferite se potrivește; unități incompatibile nu", () => {
    expect(productKeyOf(size("CAFEA MACINATA 250G"))).toBe(
      productKeyOf(size("CAFEA MACINATA 500G")),
    );
    expect(productKeyOf(size("CAFEA MACINATA 250G"))).toBe("kg|cafea macinata");
    // Aceeași denumire, dimensiuni diferite (masă vs volum vs fără mărime): chei diferite.
    const keys = new Set([
      productKeyOf(size("CREMA 100G")),
      productKeyOf(size("CREMA 100ML")),
      productKeyOf(size("CREMA 2 BUC")),
      productKeyOf(size("CREMA")),
    ]);
    expect(keys.size).toBe(4);
  });

  it("preț pe unitate standard: exemple numerice", () => {
    // 2 × lapte 1 L la 7,49 → 14,98 lei / 2 l = 7,49 lei/l
    const s = size("LAPTE ZUZU 1,5% 1L", "2");
    expect(s.kind).toBe("sized");
    expect(unitPriceMinor(1498n, comparisonQuantity(s, quantityMilli("2")))).toBe(749n);
    // 6 × apă 2 L la 2,29 → 13,74 lei / 12 l = 1,145 → 1,15 lei/l (jumătate în sus)
    const a = size("APA PLATA 2L", "6");
    expect(unitPriceMinor(1374n, comparisonQuantity(a, quantityMilli("6")))).toBe(115n);
    // Cafea 500 g la 32,99 lei → 65,98 lei/kg
    const c = size("CAFEA MACINATA 500G");
    expect(unitPriceMinor(3299n, comparisonQuantity(c, quantityMilli("1")))).toBe(6598n);
    // Fără mărime: banane 1,254 × 6,99 → 8,77 lei / 1,254 = 6,99 lei pe unitatea de vânzare
    const b = size("BANANE", "1.254");
    expect(unitPriceMinor(877n, comparisonQuantity(b, quantityMilli("1.254")))).toBe(699n);
    expect(unitPriceMinor(100n, 0n)).toBeNull();
  });
});
