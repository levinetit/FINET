import { describe, expect, it } from "vitest";

import {
  applyPreferences,
  budgetAlerts,
  goalReminders,
  monthlySummary,
  paymentsDue,
  subscriptionRenewals,
  syncFailures,
  unusualSpending,
} from "./rules";

/** Regulile notificărilor (ADR 0048): candidați cu dedupKey stabil, pure. */

describe("plăți programate", () => {
  it("doar cheltuielile din următoarele 3 zile, după azi", () => {
    const events = [
      { date: "2026-10-28", ruleId: "a", description: "Azi", type: "expense", amountMinor: 100n },
      {
        date: "2026-10-30",
        ruleId: "b",
        description: "Chirie",
        type: "expense",
        amountMinor: 150000n,
      },
      {
        date: "2026-10-31",
        ruleId: "c",
        description: "Salariu",
        type: "income",
        amountMinor: 500000n,
      },
      { date: "2026-11-01", ruleId: "d", description: "Net", type: "expense", amountMinor: 6000n },
    ];
    const out = paymentsDue(events, "RON", "2026-10-28");
    expect(out.map((c) => c.dedupKey)).toEqual(["payment_due:b:2026-10-30"]);
    expect(out[0]!.title).toBe("Plată programată: Chirie");
    expect(out[0]!.body).toContain("1.500,00");
    expect(out[0]!.link).toBe("/recurring/b");
  });
});

describe("bugete", () => {
  it("galben → avertizare, roșu → depășit, verde nimic; cheia pe buget și lună", () => {
    const out = budgetAlerts(
      [
        {
          id: "g",
          name: "Alimente",
          status: "green",
          spentMinor: 1n,
          amountMinor: 10n,
          currency: "RON",
        },
        {
          id: "y",
          name: "Transport",
          status: "yellow",
          spentMinor: 8500n,
          amountMinor: 10000n,
          currency: "RON",
        },
        {
          id: "r",
          name: "Haine",
          status: "red",
          spentMinor: 12000n,
          amountMinor: 10000n,
          currency: "RON",
        },
      ],
      "2026-10",
    );
    expect(out.map((c) => [c.kind, c.dedupKey])).toEqual([
      ["budget_warning", "budget_warning:y:2026-10"],
      ["budget_exceeded", "budget_exceeded:r:2026-10"],
    ]);
    expect(out[1]!.body).toContain("Ai cheltuit 120,00");
    expect(out[1]!.body).toContain("din 100,00");
  });
});

describe("restul regulilor", () => {
  it("neobișnuite: o cheie pe tranzacție, cel mult 5", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      transactionId: `t${i}`,
      merchant: "X",
      description: null,
      amountMinor: 100n,
      explanation: "expl",
    }));
    const out = unusualSpending(many, "RON", "2026-10");
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({
      kind: "unusual_spending",
      dedupKey: "unusual_spending:t0",
      body: "expl",
      link: "/advisor?month=2026-10",
    });
  });

  it("obiective: termen depășit sau în ≤ 7 zile; fără termen nimic", () => {
    const out = goalReminders([
      {
        goalId: "a",
        name: "A",
        currency: "RON",
        deadline: null,
        plan: { status: "no_deadline", remainingMinor: 1n, daysLeft: null },
      },
      {
        goalId: "b",
        name: "B",
        currency: "RON",
        deadline: "2026-10-01",
        plan: { status: "overdue", remainingMinor: 500n, daysLeft: 0 },
      },
      {
        goalId: "c",
        name: "C",
        currency: "RON",
        deadline: "2026-11-02",
        plan: { status: "on_track", remainingMinor: 700n, daysLeft: 5 },
      },
      {
        goalId: "d",
        name: "D",
        currency: "RON",
        deadline: "2026-12-02",
        plan: { status: "on_track", remainingMinor: 700n, daysLeft: 35 },
      },
    ]);
    expect(out.map((c) => c.dedupKey)).toEqual([
      "goal_overdue:b:2026-10-01",
      "goal_soon:c:2026-11-02",
    ]);
    expect(out[1]!.title).toBe("Obiectivul C are termenul în 5 zile");
  });

  it("abonamente: reînnoiri în 0–3 zile", () => {
    const out = subscriptionRenewals([
      {
        ruleId: "n",
        name: "Netflix",
        currency: "RON",
        amountMinor: 5000n,
        nextRenewalOn: "2026-10-30",
        daysToRenewal: 2,
      },
      {
        ruleId: "s",
        name: "Spotify",
        currency: "RON",
        amountMinor: 2500n,
        nextRenewalOn: "2026-11-10",
        daysToRenewal: 13,
      },
      {
        ruleId: "o",
        name: "Vechi",
        currency: "RON",
        amountMinor: 1n,
        nextRenewalOn: "2026-10-20",
        daysToRenewal: -8,
      },
      {
        ruleId: "p",
        name: "Pauză",
        currency: "RON",
        amountMinor: 1n,
        nextRenewalOn: null,
        daysToRenewal: null,
      },
    ]);
    expect(out.map((c) => c.dedupKey)).toEqual(["subscription_renewal:n:2026-10-30"]);
  });

  it("rezumatul lunii: o singură notificare, goală dacă nu există text", () => {
    expect(monthlySummary({ month: "2026-09", label: "septembrie 2026", lines: [] })).toEqual([]);
    const out = monthlySummary({
      month: "2026-09",
      label: "septembrie 2026",
      lines: [{ text: "A." }, { text: "B." }],
    });
    expect(out[0]).toMatchObject({
      kind: "monthly_summary",
      dedupKey: "monthly_summary:2026-09",
      body: "A. B.",
      link: "/reports?month=2026-09",
    });
  });

  it("documente eșuate: pe document, cu linkul potrivit", () => {
    const out = syncFailures([
      { id: "d1", kind: "receipt" },
      { id: "u1", kind: "statement" },
    ]);
    expect(out.map((c) => [c.dedupKey, c.link])).toEqual([
      ["sync_failure:receipt:d1", "/receipts"],
      ["sync_failure:statement:u1", "/statements"],
    ]);
  });

  it("preferințele: tipurile oprite dispar; inApp = false oprește tot", () => {
    const cands = syncFailures([{ id: "d1", kind: "receipt" }]).concat(
      monthlySummary({ month: "2026-09", label: "x", lines: [{ text: "A." }] }),
    );
    expect(
      applyPreferences(cands, { inApp: true, kinds: ["monthly_summary"] }).map((c) => c.kind),
    ).toEqual(["monthly_summary"]);
    expect(
      applyPreferences(cands, { inApp: false, kinds: ["monthly_summary", "sync_failure"] }),
    ).toEqual([]);
  });
});
