import { describe, expect, it } from "vitest";

import type { HealthScore } from "@/modules/health/health";

import {
  type CategoryMonth,
  type CategoryStat,
  type MerchantStat,
  type MonthExpense,
  findPatterns,
  findUnusual,
  suggest,
} from "./advisor";

/** Consilierul (ADR 0045): analize pure, în întregi. */

const names = new Map([
  ["c-food", "Alimente"],
  ["c-car", "Mașină"],
]);

const expense = (over: Partial<MonthExpense> & { id: string }): MonthExpense => ({
  occurredOn: "2026-10-10",
  amountMinor: 10000n,
  merchant: "Lidl",
  merchantKey: "lidl",
  rootCategoryId: "c-food",
  description: null,
  source: "manual",
  ...over,
});

const merchantStats: MerchantStat[] = [
  { merchantKey: "lidl", merchant: "Lidl", count: 12, medianMinor: 12000n },
  { merchantKey: "omv", merchant: "OMV", count: 2, medianMinor: 30000n },
];
const categoryStats: CategoryStat[] = [
  { rootCategoryId: "c-food", count: 40, medianMinor: 11000n },
  { rootCategoryId: "c-car", count: 6, medianMinor: 25000n },
];

describe("tranzacții neobișnuite", () => {
  it("≥ 2× mediana comerciantului (minimum 3), cel puțin 1 % din lună; recurentele excluse", () => {
    const expenses = [
      expense({ id: "big", amountMinor: 30000n }), // 2,5× mediana Lidl
      expense({ id: "normal", amountMinor: 13000n }),
      expense({ id: "rec", amountMinor: 50000n, source: "recurring" }),
      expense({
        id: "tiny",
        amountMinor: 900n,
        merchant: "Kiosk",
        merchantKey: "kiosk",
        rootCategoryId: null,
      }),
    ];
    const out = findUnusual("RON", expenses, merchantStats, categoryStats, 100000n, names);
    expect(out.map((u) => u.transactionId)).toEqual(["big"]);
    expect(out[0]).toMatchObject({ basis: "merchant", baselineMinor: 12000n, ratioBp: 25000 });
    expect(out[0]!.explanation).toContain("2,5×");
    expect(out[0]!.explanation).toContain("Lidl");
  });

  it("comerciant cu istoric scurt → categoria (minimum 5); fără istoric → nimic", () => {
    const expenses = [
      expense({
        id: "fuel",
        amountMinor: 60000n,
        merchant: "OMV",
        merchantKey: "omv",
        rootCategoryId: "c-car",
      }),
      expense({
        id: "new",
        amountMinor: 90000n,
        merchant: "Emag",
        merchantKey: "emag",
        rootCategoryId: null,
      }),
    ];
    const out = findUnusual("RON", expenses, merchantStats, categoryStats, 200000n, names);
    expect(out.map((u) => u.transactionId)).toEqual(["fuel"]);
    expect(out[0]).toMatchObject({ basis: "category", baselineMinor: 25000n, ratioBp: 24000 });
    expect(out[0]!.categoryName).toBe("Mașină");
  });

  it("fără cheltuieli în lună → listă goală; ordonat după raport, cel mult 10", () => {
    expect(findUnusual("RON", [], merchantStats, categoryStats, 0n, names)).toEqual([]);
    const many = Array.from({ length: 15 }, (_, i) =>
      expense({ id: `e${i}`, amountMinor: 24000n + BigInt(i) * 1000n }),
    );
    const out = findUnusual("RON", many, merchantStats, categoryStats, 1000000n, names);
    expect(out).toHaveLength(10);
    expect(out[0]!.transactionId).toBe("e14");
  });
});

describe("tipare", () => {
  const months: CategoryMonth[] = [
    { month: "2026-08", rootCategoryId: "c-food", totalMinor: 100000n },
    { month: "2026-09", rootCategoryId: "c-food", totalMinor: 100000n },
    { month: "2026-10", rootCategoryId: "c-food", totalMinor: 140000n },
    { month: "2026-08", rootCategoryId: "c-car", totalMinor: 80000n },
    { month: "2026-09", rootCategoryId: "c-car", totalMinor: 80000n },
    { month: "2026-10", rootCategoryId: "c-car", totalMinor: 20000n },
    { month: "2026-10", rootCategoryId: null, totalMinor: 5000n },
  ];

  it("categorie în creștere ≥ 25 % și în scădere ≤ −25 %, față de media lunilor anterioare", () => {
    const out = findPatterns("RON", "2026-10", months, [], new Set(), 165000n, names);
    expect(out.map((p) => [p.code, p.categoryName, p.changeBp])).toEqual([
      ["category_up", "Alimente", 4000],
      ["category_down", "Mașină", -7500],
    ]);
    expect(out[0]!.explanation).toContain("40,0 %");
    expect(out[0]!.explanation).toContain("2 luni");
  });

  it("o singură lună anterioară nu ajunge; comercianți noi și concentrarea", () => {
    const one: CategoryMonth[] = [
      { month: "2026-09", rootCategoryId: "c-food", totalMinor: 100000n },
      { month: "2026-10", rootCategoryId: "c-food", totalMinor: 200000n },
    ];
    const expenses = [
      expense({ id: "a", amountMinor: 70000n, merchant: "Dedeman", merchantKey: "dedeman" }),
      expense({ id: "b", amountMinor: 10000n, merchant: "Dedeman", merchantKey: "dedeman" }),
      expense({ id: "c", amountMinor: 20000n }),
    ];
    const out = findPatterns("RON", "2026-10", one, expenses, new Set(["lidl"]), 100000n, names);
    expect(out.map((p) => p.code)).toEqual(["merchant_concentration", "new_merchant"]);
    expect(out[0]).toMatchObject({ merchant: "Dedeman", currentMinor: 80000n, changeBp: 8000 });
    expect(out[1]!.explanation).toContain("2 cheltuieli");
  });
});

describe("sugestii", () => {
  const health = (savingsBp: number | null): HealthScore => ({
    currency: "RON",
    month: "2026-10",
    score: 50,
    band: "watch",
    label: "",
    components: [
      {
        key: "savings_rate",
        weight: 25,
        score: 40,
        status: "ok",
        value: savingsBp,
        unit: "bp",
        display: "",
        explanation: "",
      },
    ],
  });
  const base = {
    currency: "RON" as const,
    health: health(500),
    forecast: null,
    patterns: [],
    unusual: [],
    redBudgets: [],
    liquidMinor: 100000n,
    debtMinor: 0n,
    averageExpenseMinor: 100000n,
    hasRecurringRules: true,
  };

  it("fondul de urgență: ținta 3 luni, rata lunară pe 12 luni", () => {
    const out = suggest(base);
    expect(out.map((s) => s.code)).toEqual(["emergency_fund"]);
    // (300.000 − 100.000) / 12 = 16.667.
    expect(out[0]!.amountMinor).toBe(16667n);
    expect(out[0]!.text).toContain("166,67");
  });

  it("prioritățile: descoperire și card înaintea celorlalte; categoria în creștere cu rată mică", () => {
    const out = suggest({
      ...base,
      debtMinor: 50000n,
      redBudgets: ["Alimente"],
      forecast: {
        horizons: [{ days: 30, lowestMinor: -2000n, lowestOn: "2026-11-20" }],
      } as never,
      patterns: [
        {
          code: "category_up",
          categoryId: "c-food",
          categoryName: "Alimente",
          merchant: null,
          currentMinor: 140000n,
          baselineMinor: 100000n,
          changeBp: 4000,
          explanation: "",
        },
      ],
      unusual: [{ transactionId: "x" } as never],
      hasRecurringRules: false,
    });
    expect(out.map((s) => s.code)).toEqual([
      "overdraft_ahead",
      "pay_down_card",
      "review_budgets",
      "emergency_fund",
      "trim_category",
      "check_unusual",
      "automate_recurring",
    ]);
    expect(out[0]!.amountMinor).toBe(2000n);
    expect(out[4]!.amountMinor).toBe(14000n);
    expect(out[2]!.text).toContain("Alimente");
  });

  it("nimic de semnalat → „nimic urgent”", () => {
    const out = suggest({ ...base, liquidMinor: 400000n, health: health(2500) });
    expect(out.map((s) => s.code)).toEqual(["keep_going"]);
  });
});
