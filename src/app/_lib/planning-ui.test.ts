import { describe, expect, it } from "vitest";

import { MONTH_WINDOW_BACK as API_MONTH_WINDOW_BACK } from "@/app/api/v1/_lib/planning-handlers";

import {
  MONTH_SELECTOR_COUNT,
  MONTH_WINDOW_BACK,
  barLength,
  countDelta,
  deltaView,
  exportPath,
  formatAbsMinor,
  formatDate,
  formatDayShort,
  formatMonth,
  formatMonthAbbr,
  formatMonthShort,
  maxAbs,
  monthOptions,
  pickMonth,
  progressLength,
} from "./planning-ui";

describe("lunile din interfață", () => {
  it("fereastra de luni e aceeași ca în API", () => {
    expect(MONTH_WINDOW_BACK).toBe(API_MONTH_WINDOW_BACK);
  });

  it("numele lunii în română, fără locale-ul serverului", () => {
    expect(formatMonth("2026-01")).toBe("ianuarie 2026");
    expect(formatMonth("2026-10")).toBe("octombrie 2026");
    expect(formatMonth("2026-12")).toBe("decembrie 2026");
    expect(formatMonth("2026-13")).toBe("2026-13");
    expect(formatMonthAbbr("2026-10")).toBe("oct");
    expect(formatMonthAbbr("2026-03")).toBe("mar");
  });

  it("selectorul: ultimele 12 luni, de la cea curentă, peste schimbarea anului", () => {
    const list = monthOptions("2026-02");
    expect(list).toHaveLength(MONTH_SELECTOR_COUNT);
    expect(list[0]).toBe("2026-02");
    expect(list[1]).toBe("2026-01");
    expect(list[2]).toBe("2025-12");
    expect(list[11]).toBe("2025-03");
  });

  it("`?month=` valid în fereastră; viitorul, formatul greșit și prea vechi → luna curentă", () => {
    const current = "2026-10";
    expect(pickMonth(undefined, current)).toEqual({ month: current, invalid: false });
    expect(pickMonth("", current)).toEqual({ month: current, invalid: false });
    expect(pickMonth("2026-09", current)).toEqual({ month: "2026-09", invalid: false });
    expect(pickMonth("2026-10", current)).toEqual({ month: "2026-10", invalid: false });
    // Exact 60 de luni în urmă: acceptat; 61: refuzat.
    expect(pickMonth("2021-10", current)).toEqual({ month: "2021-10", invalid: false });
    expect(pickMonth("2021-09", current)).toEqual({ month: current, invalid: true });
    expect(pickMonth("2026-11", current)).toEqual({ month: current, invalid: true });
    expect(pickMonth("2026-1", current)).toEqual({ month: current, invalid: true });
    expect(pickMonth("2026-00", current)).toEqual({ month: current, invalid: true });
    expect(pickMonth(["2026-08", "2026-07"], current)).toEqual({
      month: "2026-08",
      invalid: false,
    });
  });
});

describe("datele românești (5.3)", () => {
  it("zz.ll.aaaa din cifre", () => {
    expect(formatDate("2026-10-25")).toBe("25.10.2026");
    expect(formatDate("2024-02-29")).toBe("29.02.2024");
    expect(formatDate("x")).toBe("x");
    expect(formatDayShort("2026-03-05")).toBe("05.03");
    expect(formatMonthShort("2026-03")).toBe("03.2026");
  });
});

describe("comparația cu luna anterioară", () => {
  it("săgeata urmează diferența; procentul null → „—”", () => {
    expect(deltaView({ diffMinor: 1200, percent: 12 })).toEqual({ direction: "up", text: "+12%" });
    expect(deltaView({ diffMinor: -500, percent: -5 })).toEqual({
      direction: "down",
      text: "−5%",
    });
    expect(deltaView({ diffMinor: 0, percent: 0 })).toEqual({ direction: "flat", text: "0%" });
    expect(deltaView({ diffMinor: 900, percent: null })).toEqual({ direction: "none", text: "—" });
  });
});

describe("sume", () => {
  it("valoarea absolută, format românesc", () => {
    expect(formatAbsMinor(-123456, "RON")).toBe(formatAbsMinor(123456, "RON"));
    expect(formatAbsMinor(-123456, "RON")).toMatch(/^1\.234,56\s*lei$/u);
  });
});

describe("comparația numărului de tranzacții", () => {
  it("procent rotunjit half_away; luna anterioară 0 → null", () => {
    expect(countDelta(9, 8)).toEqual({ diffMinor: 1, percent: 13 });
    expect(countDelta(4, 8)).toEqual({ diffMinor: -4, percent: -50 });
    expect(countDelta(3, 0)).toEqual({ diffMinor: 3, percent: null });
    expect(countDelta(0, 0)).toEqual({ diffMinor: 0, percent: null });
  });
});

describe("scalarea graficelor în întregi", () => {
  it("bara e floor(valoare × 100 / max), limitată la 100, minim 1 pentru o valoare nenulă", () => {
    expect(barLength(50, 100)).toBe(50);
    expect(barLength(100, 100)).toBe(100);
    expect(barLength(333, 1000)).toBe(33);
    expect(barLength(1, 1_000_000)).toBe(1);
    expect(barLength(0, 1000)).toBe(0);
    expect(barLength(0, 0)).toBe(0);
    expect(barLength(-250, 1000)).toBe(25);
    expect(barLength(2000, 1000)).toBe(100);
    // Sume mari (sub 2^53): fără pierdere de precizie.
    expect(barLength(9_007_199_254_740_991, 9_007_199_254_740_991)).toBe(100);
  });

  it("maximul absolut; lista goală → 0", () => {
    expect(maxAbs([3, -7, 5])).toBe(7);
    expect(maxAbs([])).toBe(0);
  });

  it("progresul unui buget sau obiectiv e limitat la [0, 100]", () => {
    expect(progressLength(42)).toBe(42);
    expect(progressLength(250)).toBe(100);
    expect(progressLength(-3)).toBe(0);
    expect(progressLength(0)).toBe(0);
  });
});

describe("adresele exporturilor", () => {
  it("mereu `dialect=ro`, fără parametri goi", () => {
    expect(exportPath("goals")).toBe("/api/v1/exports/goals.csv?dialect=ro");
    expect(exportPath("budgets", { month: "2026-10" })).toBe(
      "/api/v1/exports/budgets.csv?month=2026-10&dialect=ro",
    );
    expect(exportPath("transactions", { dateFrom: "2026-10-01", q: "" })).toBe(
      "/api/v1/exports/transactions.csv?dateFrom=2026-10-01&dialect=ro",
    );
  });
});
