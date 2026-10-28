import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { createBudget } from "@/modules/budgets/budgets.service";
import { createCategory } from "@/modules/categories/categories.service";
import { createGoal } from "@/modules/goals/goals.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import { dashboardToJson } from "./dashboard.schema";
import { delta, getDashboard } from "./dashboard.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("delta (comparația cu luna anterioară)", () => {
  it("diferență absolută, procent întreg rotunjit, null la 0", () => {
    expect(delta(350n, 300n, "RON")).toEqual({ diffMinor: 50n, percent: 17 });
    expect(delta(250n, 300n, "RON")).toEqual({ diffMinor: -50n, percent: -17 });
    expect(delta(100n, 0n, "RON")).toEqual({ diffMinor: 100n, percent: null });
    expect(delta(0n, 0n, "RON")).toEqual({ diffMinor: 0n, percent: null });
    // Net negativ în luna anterioară: procentul se raportează la |anterior|.
    expect(delta(-50n, -100n, "RON")).toEqual({ diffMinor: 50n, percent: 50 });
    expect(delta(1n, 8n, "RON").percent).toBe(-88); // −87,5 → −88
  });
});

describe.skipIf(!TEST_ADMIN_URL)("dashboard (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let ron: string;
  let ron2: string;
  let eur: string;
  let cats: Record<string, string>;
  // 1 ian 2026 00:30 ora României = 31 dec 2025 22:30 UTC.
  let clock = new Date("2025-12-31T22:30:00Z");
  const deps = () => ({ ...f.deps, now: () => clock });

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_dash");
    const acc = (name: string, currency: string) =>
      createAccount(f.deps, f.A, f.HA, { name, type: "bank", currency }).then((a) => a.id);
    ron = await acc("RON", "RON");
    ron2 = await acc("RON2", "RON");
    eur = await acc("EUR", "EUR");
    cats = {};
    for (const key of [
      "groceries",
      "restaurants",
      "transport",
      "health",
      "clothing",
      "children",
      "pets",
    ]) {
      cats[key] = await systemCategoryId(f.admin, `expense.${key}`);
    }
    cats.salary = await systemCategoryId(f.admin, "income.salary");
    cats.market = (
      await createCategory(f.deps, f.A, f.HA, {
        name: "Piață",
        kind: "expense",
        parentId: cats.groceries,
      })
    ).id;
  });
  afterAll(async () => {
    await f?.close();
  });

  const tx = (
    type: "income" | "expense",
    amountMinor: number,
    occurredOn: string,
    extra: Record<string, unknown> = {},
  ) =>
    createTransaction(f.deps, f.A, f.HA, {
      accountId: ron,
      type,
      amountMinor,
      occurredOn,
      ...extra,
    });

  it("gospodărie goală: fără monede, onboarding nefăcut; luna curentă după fusul orar", async () => {
    const d = await getDashboard(deps(), f.A, f.HA, {});
    // Conturile există deja, dar nu și tranzacțiile.
    expect(d.month).toBe("2026-01");
    expect(d.previousMonth).toBe("2025-12");
    expect(d.currencies).toEqual([]);
    expect(d.onboarding).toMatchObject({
      hasAccount: true,
      hasTransaction: false,
      hasBudget: false,
      hasGoal: false,
      completed: false,
    });
    clock = new Date("2025-12-31T21:59:00Z"); // 23:59 pe 31 dec, local
    expect((await getDashboard(deps(), f.A, f.HA, {})).month).toBe("2025-12");
    clock = new Date("2025-12-31T22:30:00Z");
  });

  it("totaluri separate pe monedă, transferuri excluse, comparație cu luna anterioară goală", async () => {
    await tx("income", 500_000, "2026-01-01", { categoryId: cats.salary });
    await tx("expense", 12_345, "2026-01-31", { categoryId: cats.groceries });
    await tx("expense", 10_000, "2025-12-31", { categoryId: cats.groceries }); // luna anterioară
    await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: ron,
      toAccountId: ron2,
      amountMinor: 99_999,
      occurredOn: "2026-01-15",
    });
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: eur,
      type: "expense",
      amountMinor: 700,
      occurredOn: "2026-01-10",
    });
    const d = await getDashboard(deps(), f.A, f.HA, { month: "2026-01" });
    expect(d.currencies.map((c) => c.currency)).toEqual(["EUR", "RON"]);
    const [eurD, ronD] = d.currencies;
    expect(ronD!.totals).toEqual({
      incomeMinor: 500_000n,
      expenseMinor: 12_345n,
      netMinor: 487_655n,
      transactionCount: 2,
    });
    expect(ronD!.previous).toEqual({
      incomeMinor: 0n,
      expenseMinor: 10_000n,
      netMinor: -10_000n,
      transactionCount: 1,
    });
    expect(ronD!.comparison.income).toEqual({ diffMinor: 500_000n, percent: null });
    expect(ronD!.comparison.expense).toEqual({ diffMinor: 2_345n, percent: 23 });
    expect(eurD!.totals).toEqual({
      incomeMinor: 0n,
      expenseMinor: 700n,
      netMinor: -700n,
      transactionCount: 1,
    });
    expect(eurD!.comparison.expense.percent).toBeNull();
  });

  it("trend zilnic cu zile goale = 0 și evoluție pe 12 luni peste an", async () => {
    const d = await getDashboard(deps(), f.A, f.HA, { month: "2026-01" });
    const ronD = d.currencies.find((c) => c.currency === "RON")!;
    expect(ronD.daily).toHaveLength(31);
    expect(ronD.daily[0]).toEqual({ date: "2026-01-01", incomeMinor: 500_000n, expenseMinor: 0n });
    expect(ronD.daily[14]).toEqual({ date: "2026-01-15", incomeMinor: 0n, expenseMinor: 0n });
    expect(ronD.daily[30]).toEqual({ date: "2026-01-31", incomeMinor: 0n, expenseMinor: 12_345n });
    expect(ronD.monthly.map((p) => p.month)).toEqual([
      "2025-02",
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
    ]);
    expect(ronD.monthly[10]).toEqual({
      month: "2025-12",
      incomeMinor: 0n,
      expenseMinor: 10_000n,
      netMinor: -10_000n,
    });
    expect(ronD.monthly[0]!.expenseMinor).toBe(0n);
    // Februarie bisect: 29 de zile.
    await tx("expense", 1, "2028-02-29");
    const feb = (await getDashboard(deps(), f.A, f.HA, { month: "2028-02" })).currencies.find(
      (c) => c.currency === "RON",
    )!;
    expect(feb.daily).toHaveLength(29);
    expect(feb.daily[28]).toEqual({ date: "2028-02-29", incomeMinor: 0n, expenseMinor: 1n });
  });

  it("pe categorii: subcategoriile la părinte, top N + „Altele”, fără categorie separat", async () => {
    const m = "2026-03";
    await tx("expense", 1_000, "2026-03-02", { categoryId: cats.groceries });
    await tx("expense", 500, "2026-03-02", { categoryId: cats.market });
    await tx("expense", 1_200, "2026-03-03", { categoryId: cats.restaurants });
    await tx("expense", 800, "2026-03-03", { categoryId: cats.transport });
    await tx("expense", 300, "2026-03-04", { categoryId: cats.health });
    await tx("expense", 200, "2026-03-04", { categoryId: cats.clothing });
    await tx("expense", 100, "2026-03-04", { categoryId: cats.pets });
    await tx("expense", 900, "2026-03-05"); // fără categorie
    await tx("income", 50_000, "2026-03-05", { categoryId: cats.salary }); // nu e cheltuială
    const d = await getDashboard(deps(), f.A, f.HA, { month: m, topCategories: 3 });
    const slices = d.currencies.find((c) => c.currency === "RON")!.byCategory;
    expect(slices.map((s) => [s.categoryId, s.name, s.isOther, s.amountMinor, s.percent])).toEqual([
      [cats.groceries, "Alimente", false, 1_500n, 30],
      [cats.restaurants, "Restaurante și cafenele", false, 1_200n, 24],
      [null, null, false, 900n, 18],
      [null, null, true, 1_400n, 28],
    ]);
    const all = await getDashboard(deps(), f.A, f.HA, { month: m, topCategories: 20 });
    expect(all.currencies.find((c) => c.currency === "RON")!.byCategory).toHaveLength(7);
    await expect(
      getDashboard(deps(), f.A, f.HA, { month: m, topCategories: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("onboarding: pașii se bifează; JSON cu întregi", async () => {
    await createBudget(f.deps, f.A, f.HA, { amountMinor: 100, currency: "RON" });
    let d = await getDashboard(deps(), f.A, f.HA, { month: "2026-01" });
    expect(d.onboarding.steps).toEqual([
      { key: "import", done: true },
      { key: "budget", done: true },
      { key: "goal", done: false },
    ]);
    await createGoal(f.deps, f.A, f.HA, { name: "G", targetMinor: 1, currency: "RON" });
    d = await getDashboard(deps(), f.A, f.HA, { month: "2026-01" });
    expect(d.onboarding.completed).toBe(true);
    const json = dashboardToJson(d);
    const ronJ = json.currencies.find((c) => c.currency === "RON")!;
    expect(ronJ.totals).toEqual({
      incomeMinor: 500_000,
      expenseMinor: 12_345,
      netMinor: 487_655,
      transactionCount: 2,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("izolare: B nu vede datele lui A și nu poate cere dashboard-ul HA; C (member) vede aceleași totaluri", async () => {
    const accB = (
      await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" })
    ).id;
    await createTransaction(f.deps, f.B, f.HB, {
      accountId: accB,
      type: "expense",
      amountMinor: 77_777,
      occurredOn: "2026-01-20",
    });
    const a = await getDashboard(deps(), f.A, f.HA, { month: "2026-01" });
    expect(a.currencies.find((c) => c.currency === "RON")!.totals.expenseMinor).toBe(12_345n);
    const b = await getDashboard(deps(), f.B, f.HB, { month: "2026-01" });
    expect(b.currencies).toHaveLength(1);
    expect(b.currencies[0]!.totals.expenseMinor).toBe(77_777n);
    expect(b.onboarding.hasBudget).toBe(false);
    await expect(getDashboard(deps(), f.B, f.HA, {})).rejects.toBeInstanceOf(NotFoundError);
    const c = await getDashboard(deps(), f.C, f.HA, { month: "2026-01" });
    expect(c.currencies).toEqual(a.currencies);
    await expect(
      getDashboard(deps(), f.A, f.HA, { month: "2026-01", householdId: f.HB }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
