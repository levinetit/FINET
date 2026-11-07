import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { systemCategoryId } from "@/modules/ledger/testing";

import type { ApiDeps } from "./_lib/http";
import * as I from "./_lib/intelligence-handlers";
import * as L from "./_lib/ledger-handlers";
import * as P from "./_lib/planning-handlers";
import * as RC from "./_lib/recurring-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Inteligența financiară prin API (modernizare 2026, pasul D; ADR 0045): scorul de sănătate pe
 * PostgreSQL real, ca `finet_app`: cifrele din date, izolarea între gospodării (fiecare vede
 * DOAR propriile tranzacții, conturi și bugete), validarea lunii, 401, contractul OpenAPI.
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;

type HealthJson = {
  month: string;
  currencies: {
    currency: string;
    score: number | null;
    band: string | null;
    components: { key: string; score: number | null; value: number | null; weight: number }[];
    label: string;
  }[];
};

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1/health-score pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  // 28 octombrie 2026, 10:00 UTC → luna curentă în București: 2026-10.
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions;
  let B: Sessions;
  let groceries: string;
  let keySeq = 0;
  const PASS = "parola-sanatate-1";
  const newKey = () => `sanatate-cheie-${String(++keySeq).padStart(6, "0")}`;

  async function call(handler: Handler, path: string, init: ApiInit) {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      env,
    );
    await assertContract(handler, res);
    const body = (await readJson(res)) as Body;
    return { status: res.status, body, res };
  }

  const idOf = (r: { body: Body }) => (r.body.data as { id: string }).id;

  async function newAccount(
    s: Sessions,
    name: string,
    type: string,
    openingBalance: string,
    currency = "RON",
  ) {
    const r = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: s.bearer,
      body: { name, type, currency, openingBalance },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return idOf(r);
  }

  async function newTx(s: Sessions, body: Record<string, unknown>) {
    const r = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: s.bearer,
      headers: { "idempotency-key": newKey() },
      body,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return idOf(r);
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_intelligence_api");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: { mutations: { max: 100_000, windowSeconds: 60 } },
    };
    const mk = (email: string, name: string) =>
      createUserWithHousehold(fx.db, {
        email,
        name,
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
    await mk("ana@exemplu.ro", "Ana");
    await mk("bogdan@exemplu.ro", "Bogdan");
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");

    // Ana: cont bancar cu 3.000 lei, card de credit cu −500 lei; 6 luni de venituri și cheltuieli.
    const bank = await newAccount(A, "Bancă", "bank", "3000");
    await newAccount(A, "Card", "credit_card", "-500");
    for (let i = 0; i < 6; i++) {
      const month = `2026-${String(5 + i).padStart(2, "0")}`;
      await newTx(A, {
        type: "income",
        accountId: bank,
        amount: "5000",
        occurredOn: `${month}-05`,
        description: "Salariu",
      });
      await newTx(A, {
        type: "expense",
        accountId: bank,
        categoryId: groceries,
        amount: i === 5 ? "4000" : "3800",
        occurredOn: `${month}-10`,
        description: "Cumpărături",
      });
    }
    const budget = await call(P.createBudgetHandler, "/api/v1/budgets", {
      bearer: A.bearer,
      headers: { "idempotency-key": newKey() },
      body: { categoryId: groceries, amount: "4500", currency: "RON" },
    });
    expect(budget.status, JSON.stringify(budget.body)).toBe(201);

    // Bogdan: doar un cont cash cu 100 lei și o cheltuială; fără venituri.
    const cash = await newAccount(B, "Numerar", "cash", "100");
    await newTx(B, {
      type: "expense",
      accountId: cash,
      amount: "40",
      occurredOn: "2026-10-12",
      description: "Pâine",
    });
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("401 fără sesiune", async () => {
    const r = await call(I.healthScoreHandler, "/api/v1/health-score", {});
    expect(r.status).toBe(401);
  });

  it("scorul Anei: cifrele din tranzacții, conturi și bugete", async () => {
    const r = await call(I.healthScoreHandler, "/api/v1/health-score", { bearer: A.bearer });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const data = r.body.data as HealthJson;
    expect(data.month).toBe("2026-10");
    expect(data.currencies).toHaveLength(1);
    const ron = data.currencies[0]!;
    expect(ron.currency).toBe("RON");
    expect(ron.label).toContain("Nu este un scor de credit");
    const by = Object.fromEntries(ron.components.map((c) => [c.key, c]));
    // Octombrie: 5.000 venit − 4.000 cheltuieli = 20 % → 2.000 bp → 100.
    expect(by.savings_rate!.value).toBe(2000);
    expect(by.savings_rate!.score).toBe(100);
    // Toate cele 6 luni au venit ≥ cheltuieli.
    expect(by.cash_flow!.score).toBe(100);
    // Lichid: 3.000 + 5·(5.000 − 3.800) + (5.000 − 4.000) = 10.000; media ultimelor 3 luni cu
    // cheltuieli: (3.800 + 3.800 + 4.000)/3 = 3.866,67 → 2,59 luni → 259/600 → 43.
    expect(by.emergency_fund!.value).toBe(259);
    expect(by.emergency_fund!.score).toBe(43);
    // Cheltuieli 3.800 ×5 și 4.000: media 3.833,33, MAD 55,56 → 145 bp → 100.
    expect(by.spending_stability!.value).toBe(145);
    expect(by.spending_stability!.score).toBe(100);
    // Un buget de 4.500 cu 4.000 cheltuiți (88 % ≥ 80 % avertizare) → galben → 50.
    expect(by.budget_adherence!.score).toBe(50);
    // Card de credit −500 față de venitul de 5.000 → 10 % → 1.000 bp → 80.
    expect(by.debt!.value).toBe(1000);
    expect(by.debt!.score).toBe(80);
    // (100·25 + 100·15 + 43·20 + 100·15 + 50·10 + 80·15) / 100 = 80,6 → 81.
    expect(ron.score).toBe(81);
    expect(ron.band).toBe("good");
  });

  it("izolare: Bogdan vede doar datele lui (fără venit, cash 100, fără bugete)", async () => {
    const r = await call(I.healthScoreHandler, "/api/v1/health-score", { bearer: B.bearer });
    expect(r.status).toBe(200);
    const ron = (r.body.data as HealthJson).currencies[0]!;
    const by = Object.fromEntries(ron.components.map((c) => [c.key, c]));
    expect(by.savings_rate!.score).toBeNull();
    expect(by.budget_adherence!.score).toBeNull();
    // 100 − 40 = 60 lichid; o singură lună cu cheltuieli (40) → 1,5 luni → 150/600 → 25.
    expect(by.emergency_fund!.value).toBe(150);
    expect(by.emergency_fund!.score).toBe(25);
    expect(by.cash_flow!.score).toBe(0);
    expect(by.debt!.score).toBe(100);
    expect(ron.score).toBe((0 * 15 + 25 * 20 + 100 * 15) / (15 + 20 + 15));
  });

  it("luna din URL: validă în fereastră, 400 în afara ei sau malformată", async () => {
    const ok = await call(I.healthScoreHandler, "/api/v1/health-score?month=2026-08", {
      bearer: A.bearer,
    });
    expect(ok.status).toBe(200);
    expect((ok.body.data as HealthJson).month).toBe("2026-08");
    // August: 5.000 − 3.800 = 24 % → 100; lunile mai–august.
    const by = Object.fromEntries(
      (ok.body.data as HealthJson).currencies[0]!.components.map((c) => [c.key, c]),
    );
    expect(by.savings_rate!.value).toBe(2400);

    const future = await call(I.healthScoreHandler, "/api/v1/health-score?month=2026-11", {
      bearer: A.bearer,
    });
    expect(future.status).toBe(400);
    expect(future.body.error?.fields).toHaveProperty("month");
    const bad = await call(I.healthScoreHandler, "/api/v1/health-score?month=octombrie", {
      bearer: A.bearer,
    });
    expect(bad.status).toBe(400);
    const extra = await call(I.healthScoreHandler, "/api/v1/health-score?foo=1", {
      bearer: A.bearer,
    });
    expect(extra.status).toBe(400);
  });

  it("cu cookie: GET merge fără Origin (nu e mutație)", async () => {
    const r = await call(I.healthScoreHandler, "/api/v1/health-score", { cookie: A.cookie });
    expect(r.status).toBe(200);
  });

  describe("prognoza de cash-flow", () => {
    type ForecastJson = {
      today: string;
      days: number;
      currencies: {
        currency: string;
        openingMinor: number;
        points: { date: string; balanceMinor: number; scheduledMinor: number }[];
        horizons: {
          days: number;
          projectedMinor: number;
          scheduledExpenseMinor: number;
          lowestMinor: number;
        }[];
        upcoming: { date: string; description: string; type: string; amountMinor: number }[];
        baseline: {
          dailyIncomeMinor: number;
          dailyExpenseMinor: number;
          historyMonths: number;
          recurringCoverageBp: number | null;
        };
        confidence: { level: string; score: number; reasons: { code: string }[] };
        label: string;
      }[];
    };

    it("Ana: soldul de azi, regula recurentă ca plată viitoare, linia de bază din 3 luni", async () => {
      const accounts = await call(L.listAccountsHandler, "/api/v1/accounts", { bearer: A.bearer });
      const bank = (accounts.body.data as { id: string; name: string }[]).find(
        (x) => x.name === "Bancă",
      )!;
      const rule = await call(RC.createRecurringHandler, "/api/v1/recurring", {
        bearer: A.bearer,
        headers: { "idempotency-key": newKey() },
        body: {
          accountId: bank.id,
          type: "expense",
          amount: "1500",
          description: "Chirie",
          frequency: "monthly",
          dayOfMonth: 5,
          startOn: "2026-11-05",
        },
      });
      expect(rule.status, JSON.stringify(rule.body)).toBe(201);

      const r = await call(I.forecastHandler, "/api/v1/forecast", { bearer: A.bearer });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const data = r.body.data as ForecastJson;
      expect(data.today).toBe("2026-10-28");
      expect(data.days).toBe(90);
      const ron = data.currencies.find((c) => c.currency === "RON")!;
      // Sold: bancă 10.000 + card −500 = 9.500.
      expect(ron.openingMinor).toBe(950000);
      expect(ron.points).toHaveLength(91);
      expect(ron.points[0]!.balanceMinor).toBe(950000);
      // Istoric: iulie–septembrie (3.800 ×3 cheltuieli nerecurente / 92 zile = 12.391 bani/zi).
      expect(ron.baseline.historyMonths).toBe(3);
      expect(ron.baseline.dailyExpenseMinor).toBe(12391);
      expect(ron.baseline.recurringCoverageBp).toBe(0);
      // Chiria: 5 nov, 5 dec, 5 ian.
      expect(ron.upcoming.map((e) => e.date)).toEqual(["2026-11-05", "2026-12-05", "2027-01-05"]);
      expect(ron.upcoming[0]).toMatchObject({
        description: "Chirie",
        type: "expense",
        amountMinor: 150000,
      });
      const h30 = ron.horizons.find((h) => h.days === 30)!;
      expect(h30.scheduledExpenseMinor).toBe(150000);
      // Venitul (salariul manual) e nerecurent: 5.000 ×3 / 92 zile = 16.304 bani/zi.
      expect(ron.baseline.dailyIncomeMinor).toBe(16304);
      expect(h30.projectedMinor).toBe(950000 - 150000 + 30 * (16304 - 12391));
      expect(ron.confidence.reasons.map((x) => x.code)).toContain("history_full");
      expect(ron.label).toContain("Estimare");
    });

    it("izolare: Bogdan nu vede regula Anei; orizont de 30 de zile; 400 la orizont nepermis", async () => {
      const r = await call(I.forecastHandler, "/api/v1/forecast?days=30", { bearer: B.bearer });
      expect(r.status).toBe(200);
      const data = r.body.data as ForecastJson;
      expect(data.days).toBe(30);
      const ron = data.currencies[0]!;
      expect(ron.upcoming).toEqual([]);
      expect(ron.points).toHaveLength(31);
      expect(ron.horizons.map((h) => h.days)).toEqual([30]);
      expect(ron.openingMinor).toBe(6000);
      expect(ron.confidence.level).toBe("low");

      const bad = await call(I.forecastHandler, "/api/v1/forecast?days=45", { bearer: A.bearer });
      expect(bad.status).toBe(400);
      expect(bad.body.error?.fields).toHaveProperty("days");
      const none = await call(I.forecastHandler, "/api/v1/forecast", {});
      expect(none.status).toBe(401);
    });
  });

  describe("consilierul", () => {
    type AdviceJson = {
      month: string;
      currencies: {
        currency: string;
        expenseTotalMinor: number;
        unusual: { transactionId: string; basis: string; ratioBp: number; amountMinor: number }[];
        patterns: { code: string; categoryName: string | null; changeBp: number | null }[];
        suggestions: { code: string; priority: string; amountMinor: number | null }[];
        health: { score: number | null; band: string | null } | null;
        forecast: { days: number; lowestMinor: number; lowestOn: string } | null;
        label: string;
      }[];
    };

    it("Ana: o cheltuială de 3× mediana e neobișnuită; categoria în creștere; sugestii cu sume", async () => {
      const accounts = await call(L.listAccountsHandler, "/api/v1/accounts", { bearer: A.bearer });
      const bank = (accounts.body.data as { id: string; name: string }[]).find(
        (x) => x.name === "Bancă",
      )!;
      // Istoric: 5 cumpărături lunare la Lidl de 300 lei (mai–septembrie, în plus față de cele 3.800).
      for (let i = 0; i < 5; i++) {
        const month = `2026-${String(5 + i).padStart(2, "0")}`;
        await newTx(A, {
          type: "expense",
          accountId: bank.id,
          categoryId: groceries,
          amount: "300",
          occurredOn: `${month}-15`,
          merchant: "Lidl",
          description: "Cumpărături",
        });
      }
      // Octombrie: o cumpărătură de 900 lei la Lidl (3× mediana) și una normală.
      const big = await newTx(A, {
        type: "expense",
        accountId: bank.id,
        categoryId: groceries,
        amount: "900",
        occurredOn: "2026-10-16",
        merchant: "Lidl",
        description: "Cumpărături mari",
      });
      await newTx(A, {
        type: "expense",
        accountId: bank.id,
        categoryId: groceries,
        amount: "310",
        occurredOn: "2026-10-20",
        merchant: "Lidl",
        description: "Cumpărături",
      });

      const r = await call(I.advisorHandler, "/api/v1/advisor", { bearer: A.bearer });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const data = r.body.data as AdviceJson;
      expect(data.month).toBe("2026-10");
      const ron = data.currencies.find((c) => c.currency === "RON")!;
      // 4.000 + 900 + 310 = 5.210 lei.
      expect(ron.expenseTotalMinor).toBe(521000);
      // Două: cumpărătura mare la Lidl (3× mediana comerciantului) și cumpărătura lunară de
      // 4.000 fără comerciant, față de mediana categoriei (300, din cele 10 cheltuieli
      // anterioare mixte); ordonate după raport.
      expect(ron.unusual).toHaveLength(2);
      const lidl = ron.unusual.find((u) => u.transactionId === big)!;
      expect(lidl).toMatchObject({ basis: "merchant", ratioBp: 30000, amountMinor: 90000 });
      expect(ron.unusual[0]).toMatchObject({ basis: "category", amountMinor: 400000 });
      // Alimente: 5.210 față de media (3.800 + 300) ×5 / 5 = 4.100 → +27 %.
      expect(ron.patterns.map((p) => [p.code, p.categoryName])).toEqual([
        ["category_up", "Alimente"],
      ]);
      expect(ron.patterns[0]!.changeBp).toBe(2707);
      expect(ron.health?.score).not.toBeNull();
      expect(ron.forecast).not.toBeNull();
      const codes = ron.suggestions.map((s) => s.code);
      // Cardul (−500), fondul de urgență (lichidul e sub 3 luni), categoria în creștere (rata
      // de economisire a lunii e sub 10 %: 5.000 − 5.210 < 0), tranzacția neobișnuită.
      // Bugetul de 4.500 e depășit (5.210) → `review_budgets`.
      expect(codes).toEqual([
        "pay_down_card",
        "review_budgets",
        "emergency_fund",
        "trim_category",
        "check_unusual",
      ]);
      expect(ron.suggestions[0]!.amountMinor).toBe(50000);
      expect(ron.label).toContain("Nu este sfat financiar");
    });

    it("izolare: Bogdan nu vede nimic din datele Anei; luna fără cheltuieli e goală", async () => {
      const r = await call(I.advisorHandler, "/api/v1/advisor", { bearer: B.bearer });
      expect(r.status).toBe(200);
      const ron = (r.body.data as AdviceJson).currencies[0]!;
      expect(ron.expenseTotalMinor).toBe(4000);
      expect(ron.unusual).toEqual([]);
      expect(ron.patterns).toEqual([]);
      expect(ron.suggestions.map((s) => s.code)).toEqual(["emergency_fund", "automate_recurring"]);

      const past = await call(I.advisorHandler, "/api/v1/advisor?month=2025-12", {
        bearer: B.bearer,
      });
      expect(past.status).toBe(200);
      const old = (past.body.data as AdviceJson).currencies[0]!;
      expect(old.expenseTotalMinor).toBe(0);
      expect(old.forecast).toBeNull();
      const bad = await call(I.advisorHandler, "/api/v1/advisor?month=2027-01", {
        bearer: B.bearer,
      });
      expect(bad.status).toBe(400);
    });
  });
});
