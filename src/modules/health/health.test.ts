import { describe, expect, it } from "vitest";

import {
  HEALTH_WEIGHTS,
  type HealthInputs,
  averageExpense,
  bandOf,
  budgetAdherence,
  cashFlowConsistency,
  computeHealth,
  debtRatio,
  divRound,
  emergencyFund,
  savingsRate,
  spendingStability,
  weightedScore,
} from "./health";

/** Scorul de sănătate financiară (ADR 0045): funcții pure, în întregi. */

const months = (pairs: readonly (readonly [string, bigint, bigint])[]) =>
  pairs.map(([month, incomeMinor, expenseMinor]) => ({ month, incomeMinor, expenseMinor }));

const base: HealthInputs = {
  currency: "RON",
  month: "2026-10",
  months: months([
    ["2026-05", 600000n, 500000n],
    ["2026-06", 600000n, 520000n],
    ["2026-07", 600000n, 480000n],
    ["2026-08", 600000n, 510000n],
    ["2026-09", 600000n, 490000n],
    ["2026-10", 600000n, 480000n],
  ]),
  liquidMinor: 1500000n,
  debtMinor: 0n,
  budgets: [{ status: "green" }, { status: "yellow" }, { status: "red" }],
};

describe("divRound", () => {
  it("rotunjește jumătățile departe de zero", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(0n, 7n)).toBe(0n);
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });
});

describe("rata de economisire", () => {
  it("20 % din venit → 100; 0 % → 40; −20 % → 0", () => {
    const at = (income: bigint, expense: bigint) =>
      savingsRate({ ...base, months: months([["2026-10", income, expense]]) });
    expect(at(1000n, 800n).score).toBe(100);
    expect(at(1000n, 800n).value).toBe(2000);
    expect(at(1000n, 1000n).score).toBe(40);
    expect(at(1000n, 1200n).score).toBe(0);
    expect(at(1000n, 900n).score).toBe(70);
    expect(at(1000n, 1100n).score).toBe(20);
  });

  it("fără venit → null, cu explicație", () => {
    const c = savingsRate({ ...base, months: months([["2026-10", 0n, 500n]]) });
    expect(c.score).toBeNull();
    expect(c.value).toBeNull();
    expect(c.status).toBe("none");
    expect(c.explanation).toContain("Fără venituri");
  });

  it("explicația conține sumele formatate și procentul", () => {
    const c = savingsRate(base);
    expect(c.display).toBe("20,0 %");
    expect(c.explanation).toContain("1.200,00");
    expect(c.explanation).toContain("6.000,00");
  });
});

describe("fluxul de numerar", () => {
  it("numără lunile cu venit ≥ cheltuieli dintre cele cu activitate", () => {
    const c = cashFlowConsistency({
      ...base,
      months: months([
        ["2026-07", 100n, 200n],
        ["2026-08", 0n, 0n],
        ["2026-09", 100n, 100n],
        ["2026-10", 300n, 100n],
      ]),
    });
    expect(c.score).toBe(67);
    expect(c.display).toBe("2/3");
  });
  it("fără activitate → null", () => {
    expect(
      cashFlowConsistency({ ...base, months: months([["2026-10", 0n, 0n]]) }).score,
    ).toBeNull();
  });
});

describe("fondul de urgență", () => {
  it("media ultimelor 3 luni cu cheltuieli; 6 luni de acoperire = 100", () => {
    expect(averageExpense(base.months, 3)).toBe(493333n);
    const c = emergencyFund(base);
    // 1.500.000 / 493.333 = 3,04 luni → 304/600 = 51.
    expect(c.value).toBe(304);
    expect(c.score).toBe(51);
    expect(c.display).toBe("3,0 luni");
    const full = emergencyFund({ ...base, liquidMinor: 6n * 493333n });
    expect(full.score).toBe(100);
    expect(emergencyFund({ ...base, liquidMinor: 100n * 493333n }).score).toBe(100);
  });
  it("sold lichid negativ se tratează ca 0; fără cheltuieli → null", () => {
    expect(emergencyFund({ ...base, liquidMinor: -5n }).score).toBe(0);
    expect(emergencyFund({ ...base, months: months([["2026-10", 100n, 0n]]) }).score).toBeNull();
  });
});

describe("stabilitatea cheltuielilor", () => {
  it("abaterea absolută medie față de medie; ≤ 10 % → 100", () => {
    const c = spendingStability(base);
    // media 496.667; abaterile: 3.333, 23.333, 16.667, 13.333, 6.667, 16.667 → MAD 13.333 → 268 bp.
    expect(c.value).toBe(268);
    expect(c.score).toBe(100);
  });
  it("50 % → 20; ≥ 60 % → 0; sub 3 luni → null", () => {
    const wide = spendingStability({
      ...base,
      months: months([
        ["2026-08", 0n, 100n],
        ["2026-09", 0n, 300n],
        ["2026-10", 0n, 200n],
      ]),
    });
    // media 200, MAD 67 (rotunjit) → 3.350 bp → 120 − 67 = 53.
    expect(wide.value).toBe(3350);
    expect(wide.score).toBe(53);
    const two = spendingStability({
      ...base,
      months: months([
        ["2026-09", 0n, 300n],
        ["2026-10", 0n, 200n],
      ]),
    });
    expect(two.score).toBeNull();
  });
});

describe("aderența la bugete", () => {
  it("verde = 1, galben = ½, roșu = 0", () => {
    const c = budgetAdherence(base);
    expect(c.score).toBe(50);
    expect(c.explanation).toContain("1 bugete în limită");
  });
  it("fără bugete → null", () => {
    expect(budgetAdherence({ ...base, budgets: [] }).score).toBeNull();
  });
});

describe("datoriile", () => {
  it("fără datorie → 100; 50 % din venit → 0; 25 % → 50", () => {
    expect(debtRatio(base).score).toBe(100);
    expect(debtRatio({ ...base, debtMinor: 300000n }).score).toBe(0);
    expect(debtRatio({ ...base, debtMinor: 150000n }).score).toBe(50);
    expect(debtRatio({ ...base, debtMinor: 150000n }).value).toBe(2500);
  });
  it("fără venit în lună folosește venitul mediu; fără niciun venit → 0", () => {
    const c = debtRatio({
      ...base,
      debtMinor: 100000n,
      months: months([
        ["2026-09", 400000n, 100n],
        ["2026-10", 0n, 100n],
      ]),
    });
    expect(c.value).toBe(2500);
    const none = debtRatio({ ...base, debtMinor: 100n, months: months([["2026-10", 0n, 1n]]) });
    expect(none.score).toBe(0);
    expect(none.value).toBeNull();
  });
});

describe("scorul total", () => {
  it("media ponderată a componentelor cu date; ponderile însumează 100", () => {
    expect(Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const h = computeHealth(base);
    // 100·25 + 100·15 + 51·20 + 100·15 + 50·10 + 100·15 = 8.520 / 100 = 85.
    expect(h.components.map((c) => c.score)).toEqual([100, 100, 51, 100, 50, 100]);
    expect(h.score).toBe(85);
    expect(h.band).toBe("good");
    expect(h.label).toContain("Nu este un scor de credit");
  });

  it("componentele fără date se redistribuie; fără nicio componentă → null", () => {
    expect(
      weightedScore([
        { key: "savings_rate", weight: 25, score: null } as never,
        { key: "debt", weight: 15, score: 60 } as never,
      ]),
    ).toBe(60);
    expect(weightedScore([])).toBeNull();
    const empty = computeHealth({
      ...base,
      months: months([["2026-10", 0n, 0n]]),
      liquidMinor: 0n,
      debtMinor: 0n,
      budgets: [],
    });
    // Doar `debt` are valoare (fără datorie = 100).
    expect(empty.score).toBe(100);
    expect(empty.components.filter((c) => c.score !== null).map((c) => c.key)).toEqual(["debt"]);
  });

  it("benzile: ≥ 80 bun, ≥ 60 rezonabil, ≥ 40 de urmărit, altfel fragil", () => {
    expect(bandOf(80)).toBe("good");
    expect(bandOf(79)).toBe("ok");
    expect(bandOf(60)).toBe("ok");
    expect(bandOf(59)).toBe("watch");
    expect(bandOf(39)).toBe("fragile");
  });

  it("refuză mai mult de 6 luni sau zero luni", () => {
    expect(() => computeHealth({ ...base, months: [] })).toThrow(RangeError);
    expect(() => computeHealth({ ...base, months: [...base.months, ...base.months] })).toThrow(
      RangeError,
    );
  });
});
