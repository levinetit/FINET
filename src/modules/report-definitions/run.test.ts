import { describe, expect, it } from "vitest";

import { normalizeProductName } from "@/modules/receipts/normalize";

import {
  type Coverage,
  HISTORY_LIMIT,
  PROJECTION_MIN_DAYS,
  PROJECTION_MIN_RECEIPTS,
  type RunLine,
  modeOf,
  runReport,
} from "./run";
import { type ReportRules } from "./rules";
import { SYSTEM_REPORTS } from "./system-definitions";

let seq = 0;
const line = (
  name: string,
  kind: RunLine["kind"],
  totalMinor: number,
  occurredOn: string,
  over: Partial<RunLine> = {},
): RunLine => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  receiptId: `00000000-0000-4000-9000-${occurredOn.replace(/-/g, "").padStart(12, "0")}`,
  occurredOn,
  currency: "RON",
  kind,
  rawName: name,
  normalizedName: normalizeProductName(name)!,
  quantity: "1",
  lineTotalMinor: BigInt(totalMinor),
  merchantName: "LIDL",
  ...over,
});
const sys = (key: string): ReportRules => SYSTEM_REPORTS.find((r) => r.key === key)!.rules;
const wide: Coverage = { firstOn: "2026-01-01", lastOn: "2026-10-28", receipts: 80 };

describe("rularea unui raport", () => {
  const bags = [
    line("PUNGA RAFIE", "bag", 50, "2026-10-12", { quantity: "1" }),
    line("PUNGA RAFIE", "bag", 50, "2026-09-12", { quantity: "2" }),
    line("PUNGI MENAJ 35L", "bag", 999, "2026-09-12"),
    line("LAPTE 1L", "product", 749, "2026-09-12"),
  ];
  it("total, bucăți, preț mediu pe unitate, pe lună; exclude ce nu se potrivește", () => {
    const r = runReport(sys("bags"), bags, wide);
    expect(r.matchedLines).toBe(2);
    expect(r.currencies).toHaveLength(1);
    const c = r.currencies[0]!;
    expect(c).toMatchObject({
      currency: "RON",
      mode: "standard",
      chargedMinor: 100n,
      creditMinor: 0n,
      netMinor: 100n,
      totalMinor: 100n,
      piecesMilli: 3000n,
      lineCount: 2,
      receiptCount: 2,
    });
    // 1,00 lei / 3 bucăți = 0,33 lei
    expect(c.avgUnitMinor).toBe(33n);
    expect(c.byMonth).toEqual([
      { month: "2026-09", totalMinor: 50n },
      { month: "2026-10", totalMinor: 50n },
    ]);
  });
  it("proiecția anuală din perioada EFECTIV acoperită de bonuri, marcată ca estimare", () => {
    // 100 bani în 301 zile acoperite (1 ian – 28 oct) → 100 · 365 / 301 = 121,26 → 121
    const c = runReport(sys("bags"), bags, wide).currencies[0]!;
    expect(c.projection).toEqual({
      status: "ok",
      yearlyMinor: 121n,
      coverageDays: 301,
      receipts: 80,
    });
  });
  it("perioade scurte sau puține bonuri: «date insuficiente»", () => {
    const short: Coverage = { firstOn: "2026-10-01", lastOn: "2026-10-28", receipts: 80 };
    expect(runReport(sys("bags"), bags, short).currencies[0]!.projection).toEqual({
      status: "insufficient",
      coverageDays: 28,
      receipts: 80,
    });
    const fewReceipts: Coverage = { ...wide, receipts: PROJECTION_MIN_RECEIPTS - 1 };
    expect(runReport(sys("bags"), bags, fewReceipts).currencies[0]!.projection.status).toBe(
      "insufficient",
    );
    const edge: Coverage = { firstOn: "2026-01-01", lastOn: "2026-03-01", receipts: 10 };
    // 1 ian – 1 mar = 60 de zile = pragul: acceptat
    expect(runReport(sys("bags"), bags, edge).currencies[0]!.projection.status).toBe("ok");
    expect(PROJECTION_MIN_DAYS).toBe(60);
    const none: Coverage = { firstOn: null, lastOn: null, receipts: 0 };
    expect(runReport(sys("bags"), bags, none).currencies[0]!.projection).toEqual({
      status: "insufficient",
      coverageDays: 0,
      receipts: 0,
    });
  });
  it("o singură linie potrivită într-o fereastră scurtă NU se extrapolează", () => {
    const one = [line("PUNGA RAFIE", "bag", 50, "2026-10-12")];
    const days7: Coverage = { firstOn: "2026-10-12", lastOn: "2026-10-18", receipts: 20 };
    expect(runReport(sys("bags"), one, days7).currencies[0]!.projection.status).toBe(
      "insufficient",
    );
  });
  it("SGR: plătit (deposit_sgr) față de recuperat (discount cu SGR); net = nerecuperat", () => {
    const lines = [
      line("GARANTIE SGR", "deposit_sgr", 300, "2026-09-01", { quantity: "6" }),
      line("GARANTIE SGR", "deposit_sgr", 100, "2026-10-01", { quantity: "2" }),
      line("RETUR SGR", "discount", 150, "2026-10-01", { quantity: null }),
      line("REDUCERE CARD", "discount", 500, "2026-10-01", { quantity: null }),
    ];
    const c = runReport(sys("sgr"), lines, wide).currencies[0]!;
    expect(c).toMatchObject({
      chargedMinor: 400n,
      creditMinor: 150n,
      netMinor: 250n,
      totalMinor: 250n,
    });
    expect(c.piecesMilli).toBe(8000n);
    expect(c.byMonth).toEqual([
      { month: "2026-09", totalMinor: 300n },
      { month: "2026-10", totalMinor: -50n },
    ]);
  });
  it("economii: raport doar de reduceri → totalul e suma reducerilor", () => {
    expect(modeOf(sys("savings"))).toBe("savings");
    expect(modeOf(sys("sgr"))).toBe("standard");
    const lines = [
      line("REDUCERE CARD", "discount", 500, "2026-10-18", { quantity: null }),
      line("LIDL PLUS CUPON", "discount", 250, "2026-10-19", { quantity: null }),
      line("RETUR SGR", "discount", 150, "2026-10-19", { quantity: null }),
      line("LAPTE 1L", "product", 749, "2026-10-19"),
    ];
    const c = runReport(sys("savings"), lines, wide).currencies[0]!;
    expect(c).toMatchObject({
      mode: "savings",
      creditMinor: 750n,
      chargedMinor: 0n,
      totalMinor: 750n,
    });
    expect(c.avgUnitMinor).toBeNull();
    expect(c.projection).toMatchObject({
      status: "ok",
      yearlyMinor: BigInt(Math.round((750 * 365) / 301)),
    });
  });
  it("monedele nu se amestecă; tipul liniei din regulă se aplică", () => {
    const lines = [
      line("PUNGA RAFIE", "bag", 50, "2026-10-12"),
      line("PUNGA RAFIE", "bag", 20, "2026-10-12", { currency: "EUR" }),
      line("PUNGA CADOU", "discount", 10, "2026-10-12"), // alt tip decât cele din regulă
    ];
    const r = runReport(sys("bags"), lines, wide);
    expect(r.currencies.map((c) => [c.currency, c.totalMinor])).toEqual([
      ["EUR", 20n],
      ["RON", 50n],
    ]);
  });
  it("istoricul: cele mai noi linii, plafonat; totalul rămâne complet", () => {
    const many = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) =>
      line(
        "PUNGA RAFIE",
        "bag",
        10,
        `2026-${String((i % 9) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
      ),
    );
    const r = runReport(sys("bags"), many, wide);
    expect(r.lines).toHaveLength(HISTORY_LIMIT);
    expect(r.linesTruncated).toBe(true);
    expect(r.matchedLines).toBe(HISTORY_LIMIT + 5);
    expect(r.currencies[0]!.totalMinor).toBe(BigInt(10 * (HISTORY_LIMIT + 5)));
    const dates = r.lines.map((l) => l.occurredOn);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
  it("fără linii potrivite: nicio monedă", () => {
    expect(runReport(sys("bags"), [], wide)).toMatchObject({
      currencies: [],
      lines: [],
      matchedLines: 0,
    });
  });
});
