import { describe, expect, it } from "vitest";

import {
  daysInclusive,
  inflationWindows,
  lastMonthsRange,
  periodRange,
  weekStart,
} from "./periods";

describe("perioadele rapoartelor (zile locale)", () => {
  const today = "2026-10-29";
  it("toată arhiva, luna curentă, luna trecută, ultimele 3 luni, anul acesta", () => {
    expect(periodRange("all", today)).toEqual({ from: null, to: null });
    expect(periodRange("this_month", today)).toEqual({ from: "2026-10-01", to: today });
    expect(periodRange("last_month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(periodRange("last_3_months", today)).toEqual({ from: "2026-08-01", to: today });
    expect(periodRange("this_year", today)).toEqual({ from: "2026-01-01", to: today });
  });
  it("trecerea peste an și februarie bisect", () => {
    expect(periodRange("last_month", "2027-01-05")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(periodRange("last_3_months", "2027-01-05")).toEqual({
      from: "2026-11-01",
      to: "2027-01-05",
    });
    expect(periodRange("last_month", "2028-03-10")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
  it("numărul de zile, ambele capete incluse", () => {
    expect(daysInclusive("2026-10-01", "2026-10-01")).toBe(1);
    expect(daysInclusive("2026-01-01", "2026-12-31")).toBe(365);
  });
  it("ultimele N luni", () => {
    expect(lastMonthsRange(12, today)).toEqual({ from: "2025-11-01", to: today });
    expect(lastMonthsRange(1, today)).toEqual({ from: "2026-10-01", to: today });
  });
  it("ferestrele inflației: luni imediat dinainte sau același interval cu un an în urmă", () => {
    expect(inflationWindows(3, "previous", today)).toEqual({
      current: { from: "2026-08-01", to: today },
      base: { from: "2026-05-01", to: "2026-07-31" },
    });
    expect(inflationWindows(3, "year_ago", today)).toEqual({
      current: { from: "2026-08-01", to: today },
      base: { from: "2025-08-01", to: "2025-10-29" },
    });
    // 29 februarie → 28 în anul fără zi bisectă
    expect(inflationWindows(1, "year_ago", "2028-02-29").base).toEqual({
      from: "2027-02-01",
      to: "2027-02-28",
    });
  });
  it("începutul săptămânii ISO (luni)", () => {
    expect(weekStart("2026-10-29")).toBe("2026-10-26"); // joi
    expect(weekStart("2026-10-26")).toBe("2026-10-26"); // luni
    expect(weekStart("2026-11-01")).toBe("2026-10-26"); // duminică
    expect(weekStart("2026-01-01")).toBe("2025-12-29");
  });
});
