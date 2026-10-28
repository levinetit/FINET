import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { createAccount } from "@/modules/accounts/accounts.service";
import { createBudget } from "@/modules/budgets/budgets.service";
import { createCategory } from "@/modules/categories/categories.service";
import { createGoal, updateGoal } from "@/modules/goals/goals.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import { monthlyReportToJson } from "./reports.schema";
import { getMonthlyReport } from "./reports.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!TEST_ADMIN_URL)("raportul lunar (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let ron: string;
  let ron2: string;
  let groceries: string;
  let market: string;
  let transport: string;
  const month = "2026-05";
  const deps = () => ({ ...f.deps, now: () => new Date("2026-05-20T10:00:00Z") });

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_report");
    ron = (await createAccount(f.deps, f.A, f.HA, { name: "R", type: "bank", currency: "RON" })).id;
    ron2 = (await createAccount(f.deps, f.A, f.HA, { name: "R2", type: "cash", currency: "RON" }))
      .id;
    groceries = await systemCategoryId(f.admin, "expense.groceries");
    transport = await systemCategoryId(f.admin, "expense.transport");
    market = (
      await createCategory(f.deps, f.A, f.HA, {
        name: "Piață",
        kind: "expense",
        parentId: groceries,
      })
    ).id;
    const spend = (amountMinor: number, extra: Record<string, unknown>, actor = f.A) =>
      createTransaction(f.deps, actor, f.HA, {
        accountId: ron,
        type: "expense",
        amountMinor,
        occurredOn: "2026-05-10",
        ...extra,
      });
    await spend(3_000, { categoryId: groceries, merchant: "Lidl" });
    await spend(1_000, { categoryId: market, merchant: "  lidl " });
    await spend(2_000, { categoryId: transport, merchant: "OMV" });
    await spend(500, { merchant: "Kaufland" }, f.C);
    for (let i = 0; i < 11; i++) await spend(10 + i, { merchant: `Mic ${i}` });
    await spend(9_999, { categoryId: groceries, merchant: "Lidl", occurredOn: "2026-06-01" });
    await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: ron,
      toAccountId: ron2,
      amountMinor: 50_000,
      occurredOn: "2026-05-10",
    });
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: ron,
      type: "income",
      amountMinor: 100_000,
      occurredOn: "2026-05-01",
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  it("totaluri, categorii cu subcategorii, comercianți normalizați (top 10)", async () => {
    const r = await getMonthlyReport(deps(), f.A, f.HA, {});
    expect(r.month).toBe(month);
    expect(r.currencies).toHaveLength(1);
    const c = r.currencies[0]!;
    const small = Array.from({ length: 11 }, (_, i) => 10 + i).reduce((a, b) => a + b, 0);
    const expense = 3_000 + 1_000 + 2_000 + 500 + small;
    expect(c.totals).toEqual({
      incomeMinor: 100_000n,
      expenseMinor: BigInt(expense),
      netMinor: BigInt(100_000 - expense),
      transactionCount: 4 + 11 + 1,
    });
    expect(c.byCategory[0]).toMatchObject({
      categoryId: groceries,
      name: "Alimente",
      amountMinor: 4_000n,
      count: 2,
    });
    expect(c.byCategory[0]!.children).toEqual([
      { categoryId: groceries, name: "Alimente", amountMinor: 3_000n, count: 1 },
      { categoryId: market, name: "Piață", amountMinor: 1_000n, count: 1 },
    ]);
    expect(c.byCategory[1]).toMatchObject({ categoryId: transport, amountMinor: 2_000n });
    expect(c.byCategory[2]).toMatchObject({ categoryId: null, amountMinor: BigInt(500 + small) });
    expect(c.topMerchants).toHaveLength(10);
    expect(c.topMerchants.slice(0, 3)).toEqual([
      { merchant: "Lidl", amountMinor: 4_000n, count: 2 },
      { merchant: "OMV", amountMinor: 2_000n, count: 1 },
      { merchant: "Kaufland", amountMinor: 500n, count: 1 },
    ]);
    expect(c.topMerchants[3]).toEqual({ merchant: "Mic 10", amountMinor: 20n, count: 1 });
  });

  it("bugete vs. cheltuit (personalele doar proprietarului) și obiective fără cele abandonate", async () => {
    const b = await createBudget(f.deps, f.A, f.HA, {
      categoryId: groceries,
      amountMinor: 5_000,
      currency: "RON",
    });
    const p = await createBudget(f.deps, f.A, f.HA, {
      amountMinor: 1_000,
      currency: "RON",
      scope: "personal",
    });
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: "Activ",
      targetMinor: 10,
      currency: "RON",
    });
    const ab = await createGoal(f.deps, f.A, f.HA, {
      name: "Lăsat",
      targetMinor: 10,
      currency: "RON",
    });
    await updateGoal(f.deps, f.A, f.HA, ab.id, { status: "abandoned" });

    const r = await getMonthlyReport(deps(), f.A, f.HA, { month });
    expect(r.budgets.find((x) => x.id === b.id)).toMatchObject({
      spentMinor: 4_000n,
      percent: 80,
      status: "yellow",
    });
    const small = Array.from({ length: 11 }, (_, i) => 10 + i).reduce((a, x) => a + x, 0);
    expect(r.budgets.find((x) => x.id === p.id)!.spentMinor).toBe(BigInt(6_000 + small));
    expect(r.goals.map((x) => x.id)).toEqual([g.id]);
    const rc = await getMonthlyReport(deps(), f.C, f.HA, { month });
    expect(rc.budgets.map((x) => x.id)).toEqual([b.id]);
    const json = monthlyReportToJson(r);
    expect(json.currencies[0]!.topMerchants[0]).toEqual({
      merchant: "Lidl",
      amountMinor: 4_000,
      count: 2,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it("izolare: B nu cere raportul HA; raportul lui B nu conține date din HA", async () => {
    await expect(getMonthlyReport(deps(), f.B, f.HA, { month })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const rb = await getMonthlyReport(deps(), f.B, f.HB, { month });
    expect(rb).toEqual({ month, currencies: [], budgets: [], goals: [] });
  });
});
