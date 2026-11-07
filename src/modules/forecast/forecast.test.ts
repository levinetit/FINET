import { describe, expect, it } from "vitest";

import {
  type ForecastHistoryMonth,
  type ForecastInputs,
  type ForecastRule,
  baselineOf,
  computeForecast,
  confidenceOf,
  scheduledEvents,
} from "./forecast";

/** Prognoza de cash-flow (ADR 0045): funcții pure, în întregi. */

const rule = (over: Partial<ForecastRule> = {}): ForecastRule => ({
  id: "r1",
  description: "Chirie",
  type: "expense",
  amountMinor: 150000n,
  spec: { frequency: "monthly", interval: 1, dayOfMonth: 5, startOn: "2026-01-05" },
  nextRunOn: "2026-11-05",
  endOn: null,
  remainingOccurrences: null,
  ...over,
});

const history: ForecastHistoryMonth[] = [
  // 31 + 31 + 30 = 92 de zile.
  {
    month: "2026-07",
    incomeMinor: 500000n,
    expenseMinor: 400000n,
    recurringIncomeMinor: 500000n,
    recurringExpenseMinor: 150000n,
  },
  {
    month: "2026-08",
    incomeMinor: 500000n,
    expenseMinor: 420000n,
    recurringIncomeMinor: 500000n,
    recurringExpenseMinor: 150000n,
  },
  {
    month: "2026-09",
    incomeMinor: 520000n,
    expenseMinor: 380000n,
    recurringIncomeMinor: 500000n,
    recurringExpenseMinor: 150000n,
  },
];

const base: ForecastInputs = {
  currency: "RON",
  today: "2026-10-28",
  days: 90,
  openingMinor: 1000000n,
  rules: [
    rule(),
    rule({
      id: "r2",
      description: "Salariu",
      type: "income",
      amountMinor: 500000n,
      spec: { frequency: "monthly", interval: 1, dayOfMonth: 1, startOn: "2026-01-01" },
      nextRunOn: "2026-11-01",
    }),
  ],
  history,
};

describe("scadențele regulilor", () => {
  it("pornește de mâine, respectă next_run_on, end_on și scadențele rămase", () => {
    const events = scheduledEvents([rule()], "2026-10-28", 90);
    expect(events.map((e) => e.date)).toEqual(["2026-11-05", "2026-12-05", "2027-01-05"]);
    const ended = scheduledEvents([rule({ endOn: "2026-12-01" })], "2026-10-28", 90);
    expect(ended.map((e) => e.date)).toEqual(["2026-11-05"]);
    const capped = scheduledEvents([rule({ remainingOccurrences: 2 })], "2026-10-28", 90);
    expect(capped).toHaveLength(2);
    expect(scheduledEvents([rule({ remainingOccurrences: 0 })], "2026-10-28", 90)).toEqual([]);
  });

  it("o scadență restantă (next_run_on în trecut) nu se numără de două ori: sare la următoarea de după azi", () => {
    const events = scheduledEvents([rule({ nextRunOn: "2026-10-05" })], "2026-10-28", 30);
    expect(events.map((e) => e.date)).toEqual(["2026-11-05"]);
    // Azi însuși nu intră (ziua curentă e deja în sold sau o generează workerul): o regulă cu
    // scadența azi dă prima dată următoarea scadență (28 nov, deci doar în orizontul de 60).
    const spec = { ...rule().spec, dayOfMonth: 28 };
    expect(scheduledEvents([rule({ nextRunOn: "2026-10-28", spec })], "2026-10-28", 30)).toEqual(
      [],
    );
    const today = scheduledEvents([rule({ nextRunOn: "2026-10-28", spec })], "2026-10-28", 60);
    expect(today.map((e) => e.date)).toEqual(["2026-11-28"]);
  });

  it("regula săptămânală dă scadențe din 7 în 7 zile, sortate cu celelalte", () => {
    const weekly = rule({
      id: "w",
      description: "Abonament",
      amountMinor: 1000n,
      spec: { frequency: "weekly", interval: 1, dayOfMonth: null, startOn: "2026-10-27" },
      nextRunOn: "2026-11-03",
    });
    const events = scheduledEvents([rule(), weekly], "2026-10-28", 30);
    expect(events.map((e) => `${e.date} ${e.ruleId}`)).toEqual([
      "2026-11-03 w",
      "2026-11-05 r1",
      "2026-11-10 w",
      "2026-11-17 w",
      "2026-11-24 w",
    ]);
  });
});

describe("linia de bază", () => {
  it("medii zilnice ale părții nerecurente, pe zilele lunilor cu activitate", () => {
    const b = baselineOf(history);
    // Venit nerecurent: 0 + 0 + 20.000 = 20.000 / 92 = 217; cheltuială nerecurentă:
    // 250.000 + 270.000 + 230.000 = 750.000 / 92 = 8.152.
    expect(b.dailyIncomeMinor).toBe(217n);
    expect(b.dailyExpenseMinor).toBe(8152n);
    expect(b.historyMonths).toBe(3);
    expect(b.historyDays).toBe(92);
    // 450.000 recurent din 1.200.000 = 37,5 %.
    expect(b.recurringCoverageBp).toBe(3750);
    // media 400.000; abateri 0, 20.000, 20.000 → MAD 13.333 → 333 bp.
    expect(b.spendingVariationBp).toBe(333);
  });

  it("fără istoric: zero peste tot, variație și acoperire null", () => {
    const b = baselineOf([]);
    expect(b.dailyExpenseMinor).toBe(0n);
    expect(b.historyMonths).toBe(0);
    expect(b.recurringCoverageBp).toBeNull();
    expect(b.spendingVariationBp).toBeNull();
    const silent = baselineOf([
      {
        month: "2026-09",
        incomeMinor: 0n,
        expenseMinor: 0n,
        recurringIncomeMinor: 0n,
        recurringExpenseMinor: 0n,
      },
    ]);
    expect(silent.historyMonths).toBe(0);
  });
});

describe("încrederea", () => {
  it("istoric complet + stabil + acoperit → ridicată; orizontul lung scade", () => {
    const b = baselineOf(history);
    expect(confidenceOf(b, 30)).toMatchObject({ level: "high", score: 85 });
    expect(confidenceOf(b, 60).score).toBe(75);
    expect(confidenceOf(b, 90).score).toBe(65);
    expect(confidenceOf(b, 90).level).toBe("medium");
    expect(confidenceOf(b, 90).reasons.map((r) => r.code)).toEqual([
      "history_full",
      "stable_spending",
      "recurring_partial",
      "horizon_long",
    ]);
  });
  it("fără istoric și fără reguli → scăzută, cu motivele", () => {
    const c = confidenceOf(baselineOf([]), 30);
    expect(c.level).toBe("low");
    expect(c.score).toBe(0);
    expect(c.reasons.map((r) => r.code)).toEqual(["history_none", "recurring_none"]);
  });
});

describe("prognoza", () => {
  it("soldul proiectat = sold + scadențe + linia de bază, pe zile; orizonturile și minimul", () => {
    const f = computeForecast(base);
    expect(f.points).toHaveLength(91);
    expect(f.points[0]).toMatchObject({ date: "2026-10-28", balanceMinor: 1000000n });
    const dailyNet = 217n - 8152n;
    // Ziua 1 (29 oct): doar linia de bază.
    expect(f.points[1]!.balanceMinor).toBe(1000000n + dailyNet);
    // 1 nov (ziua 4): salariul.
    const nov1 = f.points.find((p) => p.date === "2026-11-01")!;
    expect(nov1.scheduledMinor).toBe(500000n);
    expect(nov1.balanceMinor).toBe(1000000n + 4n * dailyNet + 500000n);
    // 5 nov (ziua 8): chiria.
    const nov5 = f.points.find((p) => p.date === "2026-11-05")!;
    expect(nov5.scheduledMinor).toBe(-150000n);
    expect(f.horizons.map((h) => h.days)).toEqual([30, 60, 90]);
    const h30 = f.horizons[0]!;
    expect(h30.endOn).toBe("2026-11-27");
    expect(h30.scheduledIncomeMinor).toBe(500000n);
    expect(h30.scheduledExpenseMinor).toBe(150000n);
    expect(h30.projectedMinor).toBe(1000000n + 30n * dailyNet + 500000n - 150000n);
    expect(h30.baselineExpenseMinor).toBe(8152n * 30n);
    // Minimul din primele 30 de zile: chiar înainte de salariu (31 oct, ziua 3).
    expect(h30.lowestOn).toBe("2026-10-31");
    expect(h30.lowestMinor).toBe(1000000n + 3n * dailyNet);
    expect(f.upcoming[0]).toMatchObject({ date: "2026-11-01", description: "Salariu" });
    expect(f.label).toContain("Estimare");
  });

  it("orizont de 30 de zile: doar un rezumat, puncte până la 30", () => {
    const f = computeForecast({ ...base, days: 30 });
    expect(f.points).toHaveLength(31);
    expect(f.horizons).toHaveLength(1);
    expect(f.confidence.level).toBe("high");
  });

  it("sold negativ de pornire și fără date: linia e dreaptă", () => {
    const f = computeForecast({ ...base, openingMinor: -500n, rules: [], history: [] });
    expect(f.points.every((p) => p.balanceMinor === -500n)).toBe(true);
    expect(f.horizons[2]!.lowestMinor).toBe(-500n);
    expect(f.confidence.level).toBe("low");
  });

  it("refuză un orizont nepermis", () => {
    expect(() => computeForecast({ ...base, days: 45 as never })).toThrow(RangeError);
  });
});
