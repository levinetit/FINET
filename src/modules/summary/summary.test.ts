import { describe, expect, it } from "vitest";

import type { BudgetStatus } from "@/modules/budgets/budgets.schema";
import type { MonthlyReport } from "@/modules/reports/reports.schema";

import { SUMMARY_LABEL, buildSummary, percentChange } from "./summary";

const report = (month: string, expense: bigint, income: bigint): MonthlyReport => ({
  month,
  currencies: [
    {
      currency: "RON",
      totals: {
        incomeMinor: income,
        expenseMinor: expense,
        netMinor: income - expense,
        transactionCount: 5,
      },
      byCategory: [
        {
          categoryId: "c1",
          name: "Alimente",
          amountMinor: expense / 2n,
          count: 3,
          percent: 50,
          children: [],
        },
        {
          categoryId: null,
          name: null,
          amountMinor: expense / 4n,
          count: 1,
          percent: 25,
          children: [],
        },
      ],
      topMerchants: [{ merchant: "Lidl", amountMinor: expense / 3n, count: 2 }],
    },
  ],
  budgets: [],
  goals: [],
});

const budget = (id: string, status: "green" | "yellow" | "red", categoryId: string | null) =>
  ({ id, status, categoryId }) as unknown as BudgetStatus;

describe("percentChange", () => {
  it("rotunjit pe bigint, jumătățile în sus în valoare absolută; fără bază → null", () => {
    expect(percentChange(112_00n, 100_00n)).toBe(12);
    expect(percentChange(50_00n, 100_00n)).toBe(-50);
    expect(percentChange(0n, 100_00n)).toBe(-100);
    expect(percentChange(100_00n, 100_00n)).toBe(0);
    expect(percentChange(1n, 8n)).toBe(-88); // −87,5 → −88
    expect(percentChange(9n, 8n)).toBe(13); // 12,5 → 13
    expect(percentChange(5n, 0n)).toBeNull();
  });
});

describe("buildSummary", () => {
  const names = new Map([["c1", "Alimente"]]);

  it("totaluri, variație față de luna precedentă, categorii, comerciant", () => {
    const s = buildSummary(
      report("2026-03", 600_000n, 500_000n),
      report("2026-02", 500_000n, 0n),
      names,
    );
    expect(s.label).toBe(SUMMARY_LABEL);
    expect(s.month).toBe("2026-03");
    const by = Object.fromEntries(s.lines.map((l) => [l.code, l.text]));
    expect(by.totals).toContain("martie 2026");
    expect(by.totals).toContain("6.000,00");
    expect(by.totals).toContain("5.000,00");
    expect(by.totals).toContain("ai cheltuit cu 1.000,00");
    expect(by.change).toContain("cu 20% mai mari");
    expect(by.change).toContain("februarie 2026");
    expect(by.top_categories).toContain("Alimente 3.000,00");
    expect(by.top_categories).toContain("Fără categorie");
    expect(by.top_merchant).toContain("Lidl");
  });

  it("fără luna precedentă sau fără cheltuieli în ea: nu există propoziția de variație", () => {
    const cur = report("2026-03", 600_000n, 0n);
    expect(buildSummary(cur, null, names).lines.some((l) => l.code === "change")).toBe(false);
    expect(
      buildSummary(cur, report("2026-02", 0n, 0n), names).lines.some((l) => l.code === "change"),
    ).toBe(false);
  });

  it("lună goală; bugete depășite / aproape de limită / toate în limită", () => {
    const empty: MonthlyReport = { month: "2026-04", currencies: [], budgets: [], goals: [] };
    expect(buildSummary(empty, null, names).lines).toEqual([
      { code: "empty", currency: null, text: "Nu ai tranzacții înregistrate în aprilie 2026." },
    ]);
    const base = report("2026-03", 100n, 0n);
    const bad = buildSummary(
      {
        ...base,
        budgets: [
          budget("b1", "red", "c1"),
          budget("b2", "yellow", null),
          budget("b3", "green", "c1"),
        ],
      },
      null,
      names,
    );
    expect(bad.lines.find((l) => l.code === "budgets")!.text).toBe(
      "Bugete depășite: Alimente; aproape de limită: Toate categoriile.",
    );
    const good = buildSummary({ ...base, budgets: [budget("b1", "green", "c1")] }, null, names);
    expect(good.lines.find((l) => l.code === "budgets")!.text).toBe(
      "Toate cele 1 buget sunt în limită în martie 2026.",
    );
  });

  it("nicio cifră nu vine din altă parte decât din raport (text determinist)", () => {
    const a = buildSummary(report("2026-03", 600_000n, 500_000n), null, names);
    const b = buildSummary(report("2026-03", 600_000n, 500_000n), null, names);
    expect(a).toEqual(b);
  });
});
