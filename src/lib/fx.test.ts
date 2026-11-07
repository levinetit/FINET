import { describe, expect, it } from "vitest";

import {
  type RateTable,
  approxTotal,
  convert,
  crossRateText,
  divRoundHalfAway,
  rateOf,
} from "./fx";
import { money } from "./money";

/** Conversia valutară pentru afișare (ADR 0049): bigint, prin EUR, rotunjire la unitatea minoră. */

const table: RateTable = {
  date: "2026-10-28",
  rates: new Map([
    ["RON", 4_970_000n], // 1 EUR = 4,97 RON
    ["USD", 1_085_600n], // 1 EUR = 1,0856 USD
    ["HUF", 410_250_000n], // 1 EUR = 410,25 HUF
  ]),
};

describe("cursul", () => {
  it("EUR e 1.000.000; monedele fără curs dau null", () => {
    expect(rateOf(table, "EUR")).toBe(1_000_000n);
    expect(rateOf(table, "RON")).toBe(4_970_000n);
    expect(rateOf(table, "GBP")).toBeNull();
  });
  it("divRoundHalfAway", () => {
    expect(divRoundHalfAway(5n, 2n)).toBe(3n);
    expect(divRoundHalfAway(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfAway(4n, 3n)).toBe(1n);
  });
});

describe("conversia", () => {
  it("EUR → RON, RON → EUR, RON → USD (prin EUR), aceeași monedă neschimbată", () => {
    expect(convert(money(10000n, "EUR"), "RON", table)).toEqual(money(49700n, "RON"));
    // 497,00 RON → 100,00 EUR.
    expect(convert(money(49700n, "RON"), "EUR", table)).toEqual(money(10000n, "EUR"));
    // 497,00 RON → 108,56 USD.
    expect(convert(money(49700n, "RON"), "USD", table)).toEqual(money(10856n, "USD"));
    expect(convert(money(123n, "RON"), "RON", table)).toEqual(money(123n, "RON"));
    // 1,00 EUR → 410,25 HUF.
    expect(convert(money(100n, "EUR"), "HUF", table)).toEqual(money(41025n, "HUF"));
  });
  it("rotunjirea la unitatea minoră, semnul păstrat; fără curs → null", () => {
    // 1 ban RON → 0,002 EUR → 0 bani EUR; 3 bani → 0,006 → 1.
    expect(convert(money(1n, "RON"), "EUR", table)!.amountMinor).toBe(0n);
    expect(convert(money(3n, "RON"), "EUR", table)!.amountMinor).toBe(1n);
    expect(convert(money(-49700n, "RON"), "EUR", table)!.amountMinor).toBe(-10000n);
    expect(convert(money(100n, "GBP"), "RON", table)).toBeNull();
    expect(convert(money(100n, "RON"), "GBP", table)).toBeNull();
  });
});

describe("totalul aproximativ", () => {
  it("sumele în bază intră exact, restul prin curs; monedele fără curs se raportează", () => {
    const r = approxTotal(
      [money(100000n, "RON"), money(10000n, "EUR"), money(10856n, "USD"), money(100n, "GBP")],
      "RON",
      table,
    );
    expect(r).toEqual({
      currency: "RON",
      amountMinor: 100000n + 49700n + 49700n,
      rateDate: "2026-10-28",
      converted: ["EUR", "USD"],
      missing: ["GBP"],
    });
  });
  it("null fără sume străine sau fără niciun curs util", () => {
    expect(approxTotal([money(1n, "RON")], "RON", table)).toBeNull();
    expect(approxTotal([], "RON", table)).toBeNull();
    expect(approxTotal([money(1n, "RON"), money(1n, "GBP")], "RON", table)).toBeNull();
  });
  it("cursul direct ca text cu 4 zecimale", () => {
    expect(crossRateText("EUR", "RON", table)).toBe("4,9700");
    expect(crossRateText("USD", "RON", table)).toBe("4,5781");
    expect(crossRateText("RON", "EUR", table)).toBe("0,2012");
    expect(crossRateText("GBP", "RON", table)).toBeNull();
  });
});
