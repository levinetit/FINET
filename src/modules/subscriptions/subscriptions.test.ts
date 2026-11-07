import { describe, expect, it } from "vitest";

import {
  type SubscriptionRule,
  annualCost,
  monthlyCost,
  summarize,
  toSubscription,
} from "./subscriptions";

/** Managerul de abonamente (ADR 0047): normalizarea costurilor și rezumatul, pure. */

const rule = (over: Partial<SubscriptionRule> & { id: string }): SubscriptionRule => ({
  description: over.id,
  merchant: null,
  categoryId: null,
  accountId: "acc",
  currency: "RON",
  amountMinor: 5000n,
  frequency: "monthly",
  interval: 1,
  nextRunOn: "2026-11-05",
  endOn: null,
  status: "active",
  ...over,
});

describe("normalizarea costului", () => {
  it("lunar, anual, săptămânal, zilnic, cu interval", () => {
    expect(monthlyCost(5000n, "monthly", 1)).toBe(5000n);
    expect(monthlyCost(5000n, "monthly", 2)).toBe(2500n);
    expect(monthlyCost(120000n, "yearly", 1)).toBe(10000n);
    expect(monthlyCost(1000n, "weekly", 1)).toBe(4333n);
    expect(monthlyCost(100n, "daily", 1)).toBe(3042n);
    expect(annualCost(5000n, "monthly", 1)).toBe(60000n);
    expect(annualCost(5000n, "monthly", 3)).toBe(20000n);
    expect(annualCost(120000n, "yearly", 2)).toBe(60000n);
    expect(annualCost(1000n, "weekly", 1)).toBe(52000n);
    expect(annualCost(100n, "daily", 1)).toBe(36500n);
  });
});

describe("un abonament", () => {
  it("reînnoirea doar pentru regulile active neîncheiate; zilele până la ea", () => {
    const names = new Map([["c1", "Divertisment"]]);
    const s = toSubscription(rule({ id: "n", categoryId: "c1" }), "2026-10-28", names);
    expect(s).toMatchObject({
      categoryName: "Divertisment",
      nextRenewalOn: "2026-11-05",
      daysToRenewal: 8,
    });
    const paused = toSubscription(rule({ id: "p", status: "paused" }), "2026-10-28", names);
    expect(paused.nextRenewalOn).toBeNull();
    const ended = toSubscription(rule({ id: "e", endOn: "2026-11-01" }), "2026-10-28", names);
    expect(ended.nextRenewalOn).toBeNull();
    const overdue = toSubscription(rule({ id: "o", nextRunOn: "2026-10-20" }), "2026-10-28", names);
    expect(overdue.daysToRenewal).toBe(-8);
  });
});

describe("rezumatul", () => {
  it("totaluri doar pe active, grupare pe categorii, reînnoiri în 30 de zile, încheiatele excluse", () => {
    const names = new Map([
      ["c1", "Divertisment"],
      ["c2", "Utilități"],
    ]);
    const rules = [
      rule({ id: "netflix", description: "Netflix", amountMinor: 5000n, categoryId: "c1" }),
      rule({
        id: "spotify",
        description: "Spotify",
        amountMinor: 2500n,
        categoryId: "c1",
        nextRunOn: "2026-12-15",
      }),
      rule({
        id: "net",
        description: "Internet",
        amountMinor: 6000n,
        categoryId: "c2",
        nextRunOn: "2026-11-01",
      }),
      rule({
        id: "gym",
        description: "Sală",
        amountMinor: 120000n,
        frequency: "yearly",
        status: "paused",
      }),
      rule({ id: "old", description: "Vechi", status: "completed" }),
      rule({ id: "eur", description: "Cloud", currency: "EUR", amountMinor: 1000n }),
    ];
    const s = summarize("RON", rules, "2026-10-28", names);
    expect(s.activeCount).toBe(3);
    expect(s.pausedCount).toBe(1);
    expect(s.monthlyMinor).toBe(13500n);
    expect(s.annualMinor).toBe(162000n);
    expect(s.subscriptions.map((x) => x.name)).toEqual(["Internet", "Netflix", "Spotify", "Sală"]);
    expect(s.byCategory.map((c) => [c.categoryName, c.monthlyMinor, c.count])).toEqual([
      ["Divertisment", 7500n, 2],
      ["Utilități", 6000n, 1],
    ]);
    expect(s.upcoming.map((x) => x.name)).toEqual(["Internet", "Netflix"]);
  });
});
