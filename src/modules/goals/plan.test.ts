import { describe, expect, it } from "vitest";

import { divCeil, emergencyFundPlan, monthsToReach, savingsPlan } from "./plan";

/** Planul de economisire (ADR 0047): funcții pure, rotunjite în sus. */

describe("divCeil", () => {
  it("rotunjește în sus; 0 pentru ≤ 0", () => {
    expect(divCeil(10n, 3n)).toBe(4n);
    expect(divCeil(9n, 3n)).toBe(3n);
    expect(divCeil(0n, 3n)).toBe(0n);
    expect(divCeil(-5n, 3n)).toBe(0n);
    expect(() => divCeil(1n, 0n)).toThrow(RangeError);
  });
});

describe("planul unui obiectiv", () => {
  it("la termen: pe zi / săptămână / lună, rotunjit în sus", () => {
    // 1.200 lei de strâns în 60 de zile (28 oct → 27 dec).
    const p = savingsPlan({
      targetMinor: 150000n,
      savedMinor: 30000n,
      deadline: "2026-12-27",
      today: "2026-10-28",
    });
    expect(p.status).toBe("on_track");
    expect(p.remainingMinor).toBe(120000n);
    expect(p.daysLeft).toBe(60);
    expect(p.dailyMinor).toBe(2000n);
    // 120.000 × 7 / 60 = 14.000; 120.000 × 30,44 / 60 = 60.880.
    expect(p.weeklyMinor).toBe(14000n);
    expect(p.monthlyMinor).toBe(60880n);
  });

  it("sub o săptămână / sub o lună: toată suma; termen depășit: restul azi", () => {
    const short = savingsPlan({
      targetMinor: 1000n,
      savedMinor: 0n,
      deadline: "2026-10-31",
      today: "2026-10-28",
    });
    expect(short.daysLeft).toBe(3);
    expect(short.dailyMinor).toBe(334n);
    expect(short.weeklyMinor).toBe(1000n);
    expect(short.monthlyMinor).toBe(1000n);
    const late = savingsPlan({
      targetMinor: 1000n,
      savedMinor: 100n,
      deadline: "2026-10-01",
      today: "2026-10-28",
    });
    expect(late).toMatchObject({
      status: "overdue",
      daysLeft: 0,
      remainingMinor: 900n,
      dailyMinor: 900n,
    });
  });

  it("fără termen: doar restul; atins: zero", () => {
    expect(
      savingsPlan({ targetMinor: 1000n, savedMinor: 100n, deadline: null, today: "2026-10-28" }),
    ).toMatchObject({
      status: "no_deadline",
      remainingMinor: 900n,
      monthlyMinor: null,
    });
    expect(
      savingsPlan({
        targetMinor: 1000n,
        savedMinor: 1000n,
        deadline: "2026-12-01",
        today: "2026-10-28",
      }),
    ).toMatchObject({
      status: "done",
      remainingMinor: 0n,
      dailyMinor: 0n,
      daysLeft: 34,
    });
  });

  it("lunile până la țintă cu o rată fixă", () => {
    expect(monthsToReach(120000n, 50000n)).toBe(3);
    expect(monthsToReach(0n, 50000n)).toBe(0);
    expect(monthsToReach(100n, 0n)).toBeNull();
    expect(monthsToReach(10n ** 13n, 1n)).toBe(600);
  });
});

describe("fondul de urgență", () => {
  it("țintele la 3 și 6 luni, diferența și rata pe 12 luni", () => {
    const plan = emergencyFundPlan("RON", 400000n, 500000n);
    expect(
      plan.options.map((o) => [o.months, o.targetMinor, o.gapMinor, o.monthlyMinor, o.coveredX100]),
    ).toEqual([
      [3, 1200000n, 700000n, 58334n, 125],
      [6, 2400000n, 1900000n, 158334n, 125],
    ]);
  });
  it("lichid negativ = 0; fără cheltuieli → fără opțiuni; acoperirea se plafonează la ținta opțiunii", () => {
    expect(emergencyFundPlan("RON", 400000n, -5n).liquidMinor).toBe(0n);
    expect(emergencyFundPlan("RON", null, 100n).options).toEqual([]);
    const rich = emergencyFundPlan("RON", 100000n, 1000000n);
    expect(rich.options[0]).toMatchObject({ gapMinor: 0n, monthlyMinor: 0n, coveredX100: 300 });
    expect(rich.options[1]).toMatchObject({ gapMinor: 0n, coveredX100: 600 });
  });
});
