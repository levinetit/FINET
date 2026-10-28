import { describe, expect, it } from "vitest";

import {
  type RecurrenceSpec,
  addDays,
  addMonths,
  currentMonth,
  dayNumber,
  fromDayNumber,
  gridDate,
  occurrenceAfter,
  occurrenceOnOrAfter,
  daysInMonth,
  daysOfMonth,
  isMonth,
  isTimeZone,
  localDateOf,
  monthBounds,
  monthsEndingAt,
} from "./calendar";

describe("calendar: luni calendaristice", () => {
  it("limitele lunilor: 28/29/30/31 zile, an bisect, decembrie", () => {
    expect(monthBounds("2026-01")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
    expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2100-02").to).toBe("2100-02-28");
    expect(monthBounds("2000-02").to).toBe("2000-02-29");
    expect(monthBounds("2026-04").to).toBe("2026-04-30");
    expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysOfMonth("2026-02")).toHaveLength(28);
    expect(daysOfMonth("2026-03")[30]).toBe("2026-03-31");
  });

  it("aritmetica lunilor peste ani; ultimele 12 luni", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-03", -15)).toBe("2024-12");
    expect(monthsEndingAt("2026-02", 12)).toEqual([
      "2025-03",
      "2025-04",
      "2025-05",
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("validarea lunii", () => {
    for (const ok of ["2026-01", "1900-01", "2999-12"]) expect(isMonth(ok)).toBe(true);
    for (const bad of [
      "2026-13",
      "2026-00",
      "26-01",
      "2026-1",
      "3000-01",
      "1899-12",
      202601,
      null,
    ]) {
      expect(isMonth(bad)).toBe(false);
    }
    expect(() => monthBounds("2026-13")).toThrow(RangeError);
  });
});

describe("calendar: data locală în Europe/Bucharest", () => {
  const at = (iso: string) => new Date(iso);

  it("31 dec / 1 ian: miezul nopții local e încă anul vechi în UTC", () => {
    // Iarna: UTC+2. 2026-12-31 21:59:59Z = 23:59:59 local; 22:00:00Z = 00:00 pe 1 ian.
    expect(localDateOf(at("2026-12-31T21:59:59Z"))).toBe("2026-12-31");
    expect(localDateOf(at("2026-12-31T22:00:00Z"))).toBe("2027-01-01");
    expect(currentMonth(at("2026-12-31T21:59:59Z"))).toBe("2026-12");
    expect(currentMonth(at("2026-12-31T22:00:00Z"))).toBe("2027-01");
  });

  it("februarie bisect: 29 feb 23:59 local, apoi 1 martie 00:00", () => {
    expect(localDateOf(at("2028-02-29T21:59:00Z"))).toBe("2028-02-29");
    expect(localDateOf(at("2028-02-29T22:00:00Z"))).toBe("2028-03-01");
  });

  it("trecerea la ora de vară (ultima duminică din martie): UTC+2 → UTC+3", () => {
    // 2026-03-29 03:00 local (UTC+2) devine 04:00 (UTC+3). 31 martie 23:59 local = 20:59Z.
    expect(localDateOf(at("2026-03-29T00:59:59Z"))).toBe("2026-03-29");
    expect(localDateOf(at("2026-03-31T20:59:59Z"))).toBe("2026-03-31");
    expect(localDateOf(at("2026-03-31T21:00:00Z"))).toBe("2026-04-01");
    expect(currentMonth(at("2026-03-31T21:00:00Z"))).toBe("2026-04");
    // Cu ora de iarnă (UTC+2) aceeași clipă ar fi fost încă 31 martie: offsetul contează.
    expect(localDateOf(at("2026-03-31T21:30:00Z"))).toBe("2026-04-01");
  });

  it("trecerea la ora de iarnă (ultima duminică din octombrie): UTC+3 → UTC+2", () => {
    // 2026-10-25 04:00 local (UTC+3) devine 03:00 (UTC+2). 31 oct 23:59 local = 21:59Z.
    expect(localDateOf(at("2026-10-25T00:30:00Z"))).toBe("2026-10-25");
    expect(localDateOf(at("2026-10-31T21:59:59Z"))).toBe("2026-10-31");
    expect(localDateOf(at("2026-10-31T22:00:00Z"))).toBe("2026-11-01");
    expect(currentMonth(at("2026-10-31T21:30:00Z"))).toBe("2026-10");
    // Vara (UTC+3): 30 sep 21:00Z e deja 1 octombrie local.
    expect(currentMonth(at("2026-09-30T21:00:00Z"))).toBe("2026-10");
  });

  it("fus orar invalid → Europe/Bucharest; alt fus valid e respectat", () => {
    expect(isTimeZone("Europe/Bucharest")).toBe(true);
    expect(isTimeZone("Nu/Exista")).toBe(false);
    expect(localDateOf(at("2026-12-31T22:30:00Z"), "Nu/Exista")).toBe("2027-01-01");
    expect(localDateOf(at("2026-12-31T22:30:00Z"), "UTC")).toBe("2026-12-31");
  });
});

describe("recurențe (Faza 5)", () => {
  const monthly = (startOn: string, dayOfMonth: number, interval = 1) =>
    ({ frequency: "monthly", interval, dayOfMonth, startOn }) as const;
  const seq = (spec: RecurrenceSpec, from: string, n: number) => {
    const out: string[] = [];
    let d = occurrenceOnOrAfter(spec, from);
    while (d && out.length < n) {
      out.push(d);
      d = occurrenceAfter(spec, d);
    }
    return out;
  };

  it("addDays/dayNumber trec corect peste luni, ani și 29 februarie", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(fromDayNumber(dayNumber("2026-10-25"))).toBe("2026-10-25");
    expect(() => dayNumber("2026-02-30")).toThrow(RangeError);
  });

  it("ziua 31: ultima zi în lunile scurte, fără deplasarea zilei țintă", () => {
    expect(seq(monthly("2026-01-31", 31), "2026-01-01", 5)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
    // Bisect: 29 februarie.
    expect(seq(monthly("2028-01-31", 31), "2028-02-01", 2)).toEqual(["2028-02-29", "2028-03-31"]);
  });

  it("lunar cu interval 3 (trimestrial) și ziua țintă după data de început", () => {
    expect(seq(monthly("2026-01-15", 31, 3), "2026-01-01", 4)).toEqual([
      "2026-01-31",
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
    ]);
    // Ziua țintă înaintea zilei de început: prima scadență e luna următoare a grilei.
    expect(seq(monthly("2026-01-20", 10), "2026-01-01", 2)).toEqual(["2026-02-10", "2026-03-10"]);
  });

  it("anual pe 29 februarie: 28 februarie în anii nebisecți, 29 în cei bisecți", () => {
    const spec = {
      frequency: "yearly",
      interval: 1,
      dayOfMonth: 29,
      startOn: "2028-02-29",
    } as const;
    expect(seq(spec, "2028-01-01", 5)).toEqual([
      "2028-02-29",
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  it("săptămânal și zilnic (cu interval), inclusiv peste schimbările de oră (DST)", () => {
    const weekly = {
      frequency: "weekly",
      interval: 2,
      dayOfMonth: null,
      startOn: "2026-03-22",
    } as const;
    // 29 martie 2026 = trecerea la ora de vară în București; data nu se deplasează.
    expect(seq(weekly, "2026-03-22", 3)).toEqual(["2026-03-22", "2026-04-05", "2026-04-19"]);
    const daily = {
      frequency: "daily",
      interval: 1,
      dayOfMonth: null,
      startOn: "2026-10-24",
    } as const;
    // 25 octombrie 2026 = trecerea la ora de iarnă.
    expect(seq(daily, "2026-10-24", 3)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    const every3 = {
      frequency: "daily",
      interval: 3,
      dayOfMonth: null,
      startOn: "2026-01-01",
    } as const;
    expect(occurrenceOnOrAfter(every3, "2026-01-05")).toBe("2026-01-07");
  });

  it("„azi” în București: 23:30 UTC în octombrie (după DST) e deja ziua următoare", () => {
    expect(localDateOf(new Date("2026-10-25T21:30:00Z"))).toBe("2026-10-25");
    expect(localDateOf(new Date("2026-10-25T22:30:00Z"))).toBe("2026-10-26");
    expect(localDateOf(new Date("2026-03-28T22:30:00Z"))).toBe("2026-03-29");
  });

  it("capătul calendarului: null după 2999-12-31; interval invalid → RangeError", () => {
    expect(occurrenceAfter(monthly("2999-12-01", 1), "2999-12-01")).toBeNull();
    expect(() => occurrenceOnOrAfter(monthly("2026-01-01", 1, 0), "2026-01-01")).toThrow(
      RangeError,
    );
  });

  it("gridDate: a n-a dată a grilei, fără drift (calculată din ancoră)", () => {
    const spec = monthly("2026-01-31", 31);
    expect(gridDate(spec, 13)).toBe("2027-02-28");
    expect(gridDate(spec, 14)).toBe("2027-03-31");
  });
});
