import { describe, expect, it } from "vitest";

import { coverageForMonth, mergePeriods, monthsBetween } from "./coverage";
import { computeKeys, fxKey } from "./dedup";
import type { ParsedLine } from "./types";

const A = "00000000-0000-4000-8000-0000000000a1";
const line = (over: Partial<ParsedLine> = {}): ParsedLine => ({
  rowNo: 1,
  occurredOn: "2026-11-03",
  direction: "debit",
  amountMinor: 1500n,
  description: "Cafea",
  bankReference: null,
  kind: "movement",
  fxAmountMinor: null,
  fxCurrency: null,
  balanceAfterMinor: null,
  ...over,
});

describe("acoperirea pe luni", () => {
  const today = "2026-11-20";
  it("complet, parțial până la o dată, cu goluri, lipsă; luna curentă până azi", () => {
    expect(
      coverageForMonth([{ start: "2026-10-01", end: "2026-10-31" }], "2026-10", today),
    ).toMatchObject({
      status: "complete",
    });
    // Două extrase lipite (zile consecutive) = acoperire continuă.
    expect(
      coverageForMonth(
        [
          { start: "2026-10-16", end: "2026-10-31" },
          { start: "2026-09-20", end: "2026-10-15" },
        ],
        "2026-10",
        today,
      ).status,
    ).toBe("complete");
    expect(
      coverageForMonth([{ start: "2026-10-01", end: "2026-10-12" }], "2026-10", today),
    ).toEqual({
      month: "2026-10",
      status: "partial",
      coveredUntil: "2026-10-12",
      fromStart: true,
    });
    expect(
      coverageForMonth(
        [
          { start: "2026-10-01", end: "2026-10-05" },
          { start: "2026-10-10", end: "2026-10-31" },
        ],
        "2026-10",
        today,
      ),
    ).toMatchObject({ status: "partial", coveredUntil: "2026-10-31", fromStart: false });
    expect(coverageForMonth([], "2026-10", today).status).toBe("missing");
    expect(
      coverageForMonth([{ start: "2026-11-01", end: "2026-11-20" }], "2026-11", today).status,
    ).toBe("complete");
    expect(
      coverageForMonth([{ start: "2026-11-01", end: "2026-11-30" }], "2026-12", today).status,
    ).toBe("missing");
    // Februarie bisect.
    expect(
      coverageForMonth([{ start: "2028-02-01", end: "2028-02-29" }], "2028-02", "2028-03-10")
        .status,
    ).toBe("complete");
  });
  it("utilitare", () => {
    expect(monthsBetween("2026-11", "2027-02")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(mergePeriods([{ start: "2026-01-05", end: "2026-01-01" }])).toEqual([]);
  });
});

describe("cheile de deduplicare", () => {
  it("deterministe; rândurile identice primesc indici de apariție diferiți", () => {
    const k1 = computeKeys(A, "bt", [line(), line({ rowNo: 2 })]);
    const k2 = computeKeys(A, "bt", [line(), line({ rowNo: 2 })]);
    expect(k1).toEqual(k2);
    expect(k1[0]!.key).not.toBe(k1[1]!.key);
    expect(k1[0]!.key).toMatch(/^[0-9a-f]{64}$/);
  });
  it("descrierea normalizată (diacritice, spații, punctuație) nu schimbă cheia; contul o schimbă", () => {
    const [a] = computeKeys(A, "bt", [line({ description: "Plată  Kaufland." })]);
    const [b] = computeKeys(A, "bt", [line({ description: "plata kaufland" })]);
    const [c] = computeKeys("00000000-0000-4000-8000-0000000000a2", "bt", [line()]);
    const [d] = computeKeys(A, "bt", [line()]);
    expect(a!.key).toBe(b!.key);
    expect(c!.key).not.toBe(d!.key);
  });
  it("Revolut: ID-ul băncii e cheia; schimbul valutar folosește cheia fx (fără descriere)", () => {
    const [r1] = computeKeys(A, "revolut", [line({ bankReference: "id-1", description: "x" })]);
    const [r2] = computeKeys(A, "revolut", [
      line({ bankReference: "id-1", description: "y", amountMinor: 99n }),
    ]);
    expect(r1!.key).toBe(r2!.key);
    const [fx] = computeKeys(A, "revolut", [
      line({ kind: "fx", fxCurrency: "EUR", description: "Schimbat în EUR" }),
    ]);
    expect(fx!.key).toBe(fxKey(A, "2026-11-03", "debit", 1500n, 0));
  });

  it("cheia fx DOAR pentru schimburi: un rând obișnuit de aceeași sumă/dată nu o primește și nu-i schimbă indicele", () => {
    const keys = computeKeys(A, "bt", [
      line({ description: "Rambursare" }),
      line({ kind: "fx", fxCurrency: "EUR", description: "Schimb" }),
    ]);
    expect(keys[0]!.fx).toBeNull();
    // Indicele de apariție al schimbului numără doar schimburile (0), nu și rândul obișnuit.
    expect(keys[1]!.key).toBe(fxKey(A, "2026-11-03", "debit", 1500n, 0));
    expect(keys[0]!.key).not.toBe(keys[1]!.key);
  });
});

describe("descrierile stocate fără IBAN-uri", () => {
  it("IBAN tăiat peste rânduri, cu spații sau litere mici, e eliminat după unire", async () => {
    const { buildDescription } = await import("./text");
    const d1 = buildDescription(["Plata factura", "RO12 TEST 0000 1111", "2222 3333 · rest"]);
    expect(d1).not.toMatch(/\d{4}/);
    expect(d1).toContain("Plata factura");
    const d2 = buildDescription(["Transfer catre ro13test0000111122223333 Ion"]);
    expect(d2).not.toMatch(/test0000/i);
    expect(d2).toContain("Ion");
    const d3 = buildDescription(["De la: X, RO55TEST00001111", "22223333"]);
    expect(d3).not.toMatch(/1111|2222/);
  });
});
