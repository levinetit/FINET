import { describe, expect, it } from "vitest";

import {
  CURRENCIES,
  CurrencyMismatchError,
  InvalidAmountError,
  MAX_JSON_SAFE_MINOR,
  MoneyError,
  MoneyOverflowError,
  UnsupportedCurrencyError,
  add,
  allocate,
  compare,
  equals,
  formatMoney,
  fromJson,
  isCurrency,
  isNegative,
  isZero,
  money,
  negate,
  parseAmount,
  signedAmount,
  splitEqual,
  sub,
  sum,
  toDecimalString,
  toJson,
  zero,
  type Currency,
  type InvalidAmountReason,
  type Money,
} from "./money";

const NBSP = " ";
const ron = (n: bigint): Money => money(n, "RON");
const eur = (n: bigint): Money => money(n, "EUR");
const amounts = (list: readonly Money[]): bigint[] => list.map((m) => m.amountMinor);
const total = (list: readonly Money[]): bigint => list.reduce((acc, m) => acc + m.amountMinor, 0n);

/**
 * Generator pseudo-aleator determinist (xorshift64), doar pe bigint, ca testele de proprietăți să
 * fie reproductibile și să nu folosească aritmetică float.
 */
function rng(seed: bigint) {
  let state = BigInt.asUintN(64, seed === 0n ? 0x9e3779b97f4a7c15n : seed);
  const next = (): bigint => {
    state = BigInt.asUintN(64, state ^ (state << 13n));
    state = BigInt.asUintN(64, state ^ (state >> 7n));
    state = BigInt.asUintN(64, state ^ (state << 17n));
    return state;
  };
  /** Întreg în [0, bound). */
  return (bound: bigint): bigint => next() % bound;
}

describe("money()", () => {
  it("construiește o sumă înghețată", () => {
    const m = money(1234n, "RON");
    expect(m).toEqual({ amountMinor: 1234n, currency: "RON" });
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("respinge sumele care nu sunt bigint", () => {
    expect(() => money(12 as unknown as bigint, "RON")).toThrow(MoneyError);
    expect(() => money("12" as unknown as bigint, "RON")).toThrow(MoneyError);
    expect(() => money(1.5 as unknown as bigint, "RON")).toThrow(MoneyError);
  });

  it("respinge monedele nepermise", () => {
    expect(() => money(1n, "GBP" as Currency)).toThrow(UnsupportedCurrencyError);
    expect(() => money(1n, "ron" as Currency)).toThrow(UnsupportedCurrencyError);
    expect(() => money(1n, undefined as unknown as Currency)).toThrow(UnsupportedCurrencyError);
  });

  it("acceptă sume peste 2^53 (limita se verifică la JSON)", () => {
    expect(money(9007199254740993n, "RON").amountMinor).toBe(9007199254740993n);
  });

  it("listează monedele permise", () => {
    expect(CURRENCIES).toEqual(["RON", "EUR", "USD"]);
    expect(isCurrency("EUR")).toBe(true);
    expect(isCurrency("CHF")).toBe(false);
    expect(isCurrency(1)).toBe(false);
    expect(zero("USD")).toEqual({ amountMinor: 0n, currency: "USD" });
  });
});

describe("aritmetică", () => {
  it("add, sub, negate", () => {
    expect(add(ron(150n), ron(250n))).toEqual(ron(400n));
    expect(sub(ron(150n), ron(250n))).toEqual(ron(-100n));
    expect(negate(ron(150n))).toEqual(ron(-150n));
    expect(negate(ron(0n)).amountMinor).toBe(0n);
  });

  it("rămâne exactă peste 2^53", () => {
    const big = ron(MAX_JSON_SAFE_MINOR);
    expect(add(big, ron(2n)).amountMinor).toBe(9007199254740993n);
  });

  it("aruncă CurrencyMismatchError la monede diferite", () => {
    expect(() => add(ron(1n), eur(1n))).toThrow(CurrencyMismatchError);
    expect(() => sub(ron(1n), eur(1n))).toThrow(CurrencyMismatchError);
    expect(() => compare(ron(1n), eur(1n))).toThrow(CurrencyMismatchError);
    try {
      add(ron(1n), eur(1n));
    } catch (error) {
      expect(error).toBeInstanceOf(MoneyError);
      expect(error).toMatchObject({ left: "RON", right: "EUR", name: "CurrencyMismatchError" });
    }
  });

  it("compare, equals, isZero, isNegative", () => {
    expect(compare(ron(1n), ron(2n))).toBe(-1);
    expect(compare(ron(2n), ron(1n))).toBe(1);
    expect(compare(ron(2n), ron(2n))).toBe(0);
    expect(equals(ron(2n), ron(2n))).toBe(true);
    expect(equals(ron(2n), eur(2n))).toBe(false);
    expect(equals(ron(2n), ron(3n))).toBe(false);
    expect(isZero(ron(0n))).toBe(true);
    expect(isZero(ron(1n))).toBe(false);
    expect(isNegative(ron(-1n))).toBe(true);
    expect(isNegative(ron(0n))).toBe(false);
  });

  it("sum: listă goală, listă normală, monede amestecate", () => {
    expect(sum([], "EUR")).toEqual(eur(0n));
    expect(sum([ron(1n), ron(2n), ron(-5n)], "RON")).toEqual(ron(-2n));
    expect(() => sum([ron(1n), eur(2n)], "RON")).toThrow(CurrencyMismatchError);
    expect(() => sum([eur(1n)], "RON")).toThrow(CurrencyMismatchError);
  });
});

describe("signedAmount()", () => {
  it("venit +, cheltuială −, transfer neutru", () => {
    expect(signedAmount("income", 500n)).toBe(500n);
    expect(signedAmount("expense", 500n)).toBe(-500n);
    expect(signedAmount("transfer", 500n)).toBe(0n);
  });

  it("transferurile nu modifică totalul unui raport", () => {
    const rows = [
      { type: "income", amountMinor: 10_000n },
      { type: "expense", amountMinor: 2_550n },
      { type: "transfer", amountMinor: 5_000n },
      { type: "transfer", amountMinor: 5_000n },
    ] as const;
    const net = rows.reduce((acc, r) => acc + signedAmount(r.type, r.amountMinor), 0n);
    expect(net).toBe(7_450n);
  });

  it("respinge sume negative, ne-bigint și tipuri necunoscute", () => {
    expect(() => signedAmount("income", -1n)).toThrow(MoneyError);
    expect(() => signedAmount("income", 1 as unknown as bigint)).toThrow(MoneyError);
    expect(() => signedAmount("refund" as "income", 1n)).toThrow(MoneyError);
  });
});

describe("allocate() / splitEqual()", () => {
  it("100 bani / 3 = 34 + 33 + 33", () => {
    expect(amounts(splitEqual(ron(100n), 3))).toEqual([34n, 33n, 33n]);
  });

  it("cazuri fixe", () => {
    expect(amounts(splitEqual(ron(1n), 3))).toEqual([1n, 0n, 0n]);
    expect(amounts(splitEqual(ron(0n), 4))).toEqual([0n, 0n, 0n, 0n]);
    expect(amounts(splitEqual(ron(7n), 1))).toEqual([7n]);
    expect(amounts(splitEqual(ron(10n), 4))).toEqual([3n, 3n, 2n, 2n]);
    expect(amounts(allocate(ron(100n), [1, 1, 1]))).toEqual([34n, 33n, 33n]);
    expect(amounts(allocate(ron(1000n), [50n, 30n, 20n]))).toEqual([500n, 300n, 200n]);
    // 5 × 0.3 = 1.5, 5 × 0.7 = 3.5: resturi egale, câștigă indexul mai mic.
    expect(amounts(allocate(ron(5n), [3, 7]))).toEqual([2n, 3n]);
    expect(amounts(allocate(ron(5n), [7, 3]))).toEqual([4n, 1n]);
    // Restul cel mai mare câștigă, nu primul index.
    expect(amounts(allocate(ron(10n), [1, 2, 6]))).toEqual([1n, 2n, 7n]);
    // Pondere zero primește zero.
    expect(amounts(allocate(ron(99n), [0, 1, 0, 2]))).toEqual([0n, 33n, 0n, 66n]);
  });

  it("păstrează moneda", () => {
    expect(splitEqual(eur(10n), 3).every((m) => m.currency === "EUR")).toBe(true);
  });

  it("e exactă pe totaluri peste 2^53", () => {
    const parts = splitEqual(ron(9007199254740993n), 7);
    expect(total(parts)).toBe(9007199254740993n);
  });

  it("n mare: 1 ban la 10 000 de persoane", () => {
    const parts = splitEqual(ron(1n), 10_000);
    expect(parts).toHaveLength(10_000);
    expect(total(parts)).toBe(1n);
    expect(parts[0]!.amountMinor).toBe(1n);
  });

  it("proprietate: suma părților = total, părți nenegative, diferență ≤ 1 la splitEqual", () => {
    const rand = rng(20261027n);
    for (let run = 0; run < 500; run += 1) {
      const t = rand(run % 5 === 0 ? 10n : 10_000_000n);
      // Numărul de părți parcurge ciclic 1..12 (fără conversii bigint → number în teste).
      const n = (run % 12) + 1;
      const parts = amounts(splitEqual(ron(t), n));
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(t);
      const max = parts.reduce((a, b) => (b > a ? b : a), parts[0]!);
      const min = parts.reduce((a, b) => (b < a ? b : a), parts[0]!);
      expect(max - min <= 1n).toBe(true);
      // Determinism: același input, același output.
      expect(amounts(splitEqual(ron(t), n))).toEqual(parts);
    }
  });

  it("proprietate: ponderi inegale, suma = total și fiecare parte în [floor, floor + 1]", () => {
    const rand = rng(42n);
    for (let run = 0; run < 500; run += 1) {
      const t = rand(run % 4 === 0 ? 5n : 1_000_000_000n);
      const count = (run % 8) + 1;
      const weights = Array.from({ length: count }, () => rand(1000n));
      if (!weights.some((w) => w > 0n)) weights[0] = 1n;
      const ws = weights.reduce((a, b) => a + b, 0n);
      const parts = amounts(allocate(ron(t), weights));
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(t);
      parts.forEach((p, i) => {
        const exactFloor = (t * weights[i]!) / ws;
        expect(p === exactFloor || p === exactFloor + 1n).toBe(true);
      });
      expect(amounts(allocate(ron(t), weights))).toEqual(parts);
    }
  });

  it("respinge intrări invalide", () => {
    expect(() => splitEqual(ron(100n), 0)).toThrow(MoneyError);
    expect(() => splitEqual(ron(100n), -2)).toThrow(MoneyError);
    expect(() => splitEqual(ron(100n), 1.5)).toThrow(MoneyError);
    expect(() => splitEqual(ron(-100n), 2)).toThrow(MoneyError);
    expect(() => allocate(ron(100n), [])).toThrow(MoneyError);
    expect(() => allocate(ron(100n), [0, 0])).toThrow(MoneyError);
    expect(() => allocate(ron(100n), [1, -1])).toThrow(MoneyError);
    expect(() => allocate(ron(100n), [1n, -1n])).toThrow(MoneyError);
    expect(() => allocate(ron(100n), [0.5, 0.5])).toThrow(MoneyError);
    expect(() => allocate(ron(100n), [Number.NaN])).toThrow(MoneyError);
    expect(() => allocate(ron(-1n), [1])).toThrow(MoneyError);
  });
});

describe("parseAmount()", () => {
  const valid: ReadonlyArray<[string, bigint]> = [
    ["1234,56", 123456n],
    ["1.234,56", 123456n],
    ["1234.56", 123456n],
    ["1 234,56", 123456n],
    [`1${NBSP}234,56`, 123456n],
    ["1 234,56", 123456n],
    ["1.234.567,89", 123456789n],
    ["1 234 567,89", 123456789n],
    ["1.234.567", 123456700n],
    ["1,234,567", 123456700n],
    ["1,234.56", 123456n],
    ["1234", 123400n],
    ["0", 0n],
    ["0,5", 50n],
    ["0,05", 5n],
    ["12,5", 1250n],
    ["12.5", 1250n],
    ["12,50", 1250n],
    ["1 234", 123400n],
    ["  42,10  ", 4210n],
    ["+7", 700n],
    ["007,50", 750n],
    ["999", 99900n],
    ["90071992547409,91", 9007199254740991n],
  ];

  it.each(valid)("acceptă %j", (input, expected) => {
    expect(parseAmount(input, "RON")).toEqual(ron(expected));
  });

  it("păstrează moneda cerută", () => {
    expect(parseAmount("5,00", "EUR")).toEqual(eur(500n));
  });

  const invalid: ReadonlyArray<[string, InvalidAmountReason]> = [
    ["", "empty"],
    ["   ", "empty"],
    ["1.234", "ambiguous"],
    ["1,234", "ambiguous"],
    ["12.345", "ambiguous"],
    ["1.2.3", "invalid_format"],
    ["1,2,3", "invalid_format"],
    ["1.234.56", "invalid_format"],
    ["1,234,56", "invalid_format"],
    ["1234,567", "too_many_decimals"],
    ["1,2345", "too_many_decimals"],
    ["1.234,567", "too_many_decimals"],
    ["1.234 567", "invalid_format"],
    ["1.234 567,89", "invalid_format"],
    ["12 34", "invalid_format"],
    ["1  234", "invalid_format"],
    ["12,", "invalid_format"],
    ["12.", "invalid_format"],
    [",50", "invalid_format"],
    [".5", "invalid_format"],
    ["1.23.456", "invalid_format"],
    ["--1", "invalid_sign"],
    ["+-1", "invalid_sign"],
    ["1-", "invalid_sign"],
    ["1-2", "invalid_sign"],
    ["−5", "invalid_sign"],
    ["5−", "invalid_sign"],
    ["-", "invalid_format"],
    ["-12", "negative_not_allowed"],
    ["- 12", "invalid_format"],
    ["abc", "invalid_characters"],
    ["12,50 lei", "invalid_characters"],
    ["1e5", "invalid_characters"],
    ["Infinity", "invalid_characters"],
    ["NaN", "invalid_characters"],
    ["0x10", "invalid_characters"],
    ["12_000", "invalid_characters"],
    ["90071992547409,92", "out_of_range"],
    ["9".repeat(41), "too_long"],
  ];

  it.each(invalid)("respinge %j (%s)", (input, reason) => {
    try {
      parseAmount(input, "RON");
      expect.unreachable(`trebuia respins: ${input}`);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAmountError);
      expect((error as InvalidAmountError).reason).toBe(reason);
      expect((error as InvalidAmountError).message.length).toBeGreaterThan(0);
    }
  });

  it("acceptă sume negative doar cu allowNegative", () => {
    expect(parseAmount("-12,50", "RON", { allowNegative: true })).toEqual(ron(-1250n));
    expect(parseAmount("-1.234,56", "RON", { allowNegative: true })).toEqual(ron(-123456n));
  });

  it("respinge input ne-string și monede nepermise", () => {
    expect(() => parseAmount(12 as unknown as string, "RON")).toThrow(InvalidAmountError);
    expect(() => parseAmount("12", "GBP" as Currency)).toThrow(UnsupportedCurrencyError);
  });

  it("proprietate: parseAmount(toDecimalString) și formatare românească fac drumul complet", () => {
    const rand = rng(7n);
    for (let run = 0; run < 300; run += 1) {
      const value = rand(10_000_000_000n);
      const m = ron(value);
      expect(parseAmount(toDecimalString(m), "RON")).toEqual(m);
      // Formatul afișat, fără simbol, se parsează înapoi la aceeași sumă.
      const shown = formatMoney(m).replace(`${NBSP}lei`, "");
      expect(parseAmount(shown, "RON")).toEqual(m);
    }
  });
});

describe("toDecimalString()", () => {
  it("compune exact din bigint", () => {
    expect(toDecimalString(ron(0n))).toBe("0.00");
    expect(toDecimalString(ron(5n))).toBe("0.05");
    expect(toDecimalString(ron(50n))).toBe("0.50");
    expect(toDecimalString(ron(123456n))).toBe("1234.56");
    expect(toDecimalString(ron(-123456n))).toBe("-1234.56");
    expect(toDecimalString(ron(-5n))).toBe("-0.05");
    expect(toDecimalString(ron(9007199254740993n))).toBe("90071992547409.93");
  });
});

describe("formatMoney()", () => {
  // Node 24 (ICU 78, CLDR 48) pune NBSP (U+00A0) între număr și simbol, iar grupul de mii e „.”.
  it("RON: 1.234,56 lei cu NBSP", () => {
    expect(formatMoney(ron(123456n))).toBe(`1.234,56${NBSP}lei`);
    expect(formatMoney(ron(0n))).toBe(`0,00${NBSP}lei`);
    expect(formatMoney(ron(5n))).toBe(`0,05${NBSP}lei`);
    expect(formatMoney(ron(99999n))).toBe(`999,99${NBSP}lei`);
    expect(formatMoney(ron(100n))).toBe(`1,00${NBSP}lei`);
  });

  it("EUR și USD cu simbolul lor", () => {
    expect(formatMoney(eur(123456n))).toBe(`1.234,56${NBSP}€`);
    expect(formatMoney(money(123456n, "USD"))).toBe(`1.234,56${NBSP}$`);
  });

  it("sume negative pentru rapoarte, fără „-0,00”", () => {
    expect(formatMoney(ron(-123456n))).toBe(`-1.234,56${NBSP}lei`);
    expect(formatMoney(ron(-5n))).toBe(`-0,05${NBSP}lei`);
    expect(formatMoney(negate(ron(0n)))).toBe(`0,00${NBSP}lei`);
  });

  it("e exactă peste 2^53 (9007199254740993 bani)", () => {
    expect(formatMoney(ron(9007199254740993n))).toBe(`90.071.992.547.409,93${NBSP}lei`);
    expect(formatMoney(ron(-9007199254740993n))).toBe(`-90.071.992.547.409,93${NBSP}lei`);
  });

  it("acceptă alt locale", () => {
    expect(formatMoney(money(123456n, "USD"), "en-US")).toBe("$1,234.56");
  });
});

describe("toJson() / fromJson()", () => {
  it("serializează ca întreg JSON", () => {
    expect(toJson(ron(123456n))).toEqual({ amountMinor: 123456, currency: "RON" });
    expect(JSON.stringify(toJson(eur(-5n)))).toBe('{"amountMinor":-5,"currency":"EUR"}');
    expect(toJson(ron(MAX_JSON_SAFE_MINOR)).amountMinor).toBe(Number.MAX_SAFE_INTEGER);
    expect(toJson(ron(-MAX_JSON_SAFE_MINOR)).amountMinor).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it("refuză sumele peste 2^53 − 1", () => {
    expect(() => toJson(ron(MAX_JSON_SAFE_MINOR + 1n))).toThrow(MoneyOverflowError);
    expect(() => toJson(ron(-MAX_JSON_SAFE_MINOR - 1n))).toThrow(MoneyOverflowError);
    expect(() => toJson(ron(9007199254740993n))).toThrow(MoneyOverflowError);
  });

  it("drum dus-întors", () => {
    for (const m of [ron(0n), ron(123456n), eur(-1n), money(MAX_JSON_SAFE_MINOR, "USD")]) {
      expect(fromJson(JSON.parse(JSON.stringify(toJson(m))))).toEqual(m);
    }
  });

  it("respinge valori invalide", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "100",
      { amountMinor: 12.5, currency: "RON" },
      { amountMinor: Number.NaN, currency: "RON" },
      { amountMinor: Number.POSITIVE_INFINITY, currency: "RON" },
      { amountMinor: "1250", currency: "RON" },
      { amountMinor: 9007199254740992, currency: "RON" },
      { amountMinor: 100 },
      { currency: "RON" },
    ];
    for (const value of bad) {
      expect(() => fromJson(value)).toThrow(MoneyError);
    }
    expect(() => fromJson({ amountMinor: 100, currency: "GBP" })).toThrow(UnsupportedCurrencyError);
  });
});
