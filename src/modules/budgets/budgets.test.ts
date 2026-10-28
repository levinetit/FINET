import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { createCategory } from "@/modules/categories/categories.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import { budgetStatusToJson } from "./budgets.schema";
import {
  createBudget,
  deleteBudget,
  getBudget,
  getBudgetAlerts,
  getBudgetStatuses,
  listBudgets,
  trafficLight,
  updateBudget,
} from "./budgets.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("semaforul bugetului (comparații exacte, fără float)", () => {
  // Buget 100,00 lei, prag 80%.
  it.each([
    [7_900n, "green"],
    [7_999n, "green"],
    [8_000n, "yellow"],
    [8_100n, "yellow"],
    [9_900n, "yellow"],
    [10_000n, "yellow"],
    [10_001n, "red"],
    [10_100n, "red"],
  ] as const)("cheltuit %s din 10000 → %s", (spent, color) => {
    expect(trafficLight(spent, 10_000n, 80)).toBe(color);
  });

  it("prag 100%: galben doar la exact 100%; prag 1%: orice cheltuială e galbenă", () => {
    expect(trafficLight(9_999n, 10_000n, 100)).toBe("green");
    expect(trafficLight(10_000n, 10_000n, 100)).toBe("yellow");
    expect(trafficLight(0n, 10_000n, 1)).toBe("green");
    expect(trafficLight(100n, 10_000n, 1)).toBe("yellow");
    // Sume uriașe: fără pierdere de precizie (bigint).
    const big = 10_000_000_000_000n;
    expect(trafficLight(big * 8n, big * 10n, 80)).toBe("yellow");
    expect(trafficLight(big * 8n - 1n, big * 10n, 80)).toBe("green");
  });
});

describe.skipIf(!TEST_ADMIN_URL)("bugete (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let ron: string;
  let ron2: string;
  let eur: string;
  let accB: string;
  let groceries: string;
  let restaurants: string;
  let salary: string;
  let sub: string;
  // Ceas injectat: 31 oct 2026 23:30 ora României (UTC+2 după trecerea la ora de iarnă).
  let clock = new Date("2026-10-31T21:30:00Z");
  const deps = () => ({ ...f.deps, now: () => clock });

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_budgets");
    const acc = (name: string, currency: string) =>
      createAccount(f.deps, f.A, f.HA, { name, type: "bank", currency }).then((a) => a.id);
    ron = await acc("RON", "RON");
    ron2 = await acc("RON 2", "RON");
    eur = await acc("EUR", "EUR");
    accB = (await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" }))
      .id;
    groceries = await systemCategoryId(f.admin, "expense.groceries");
    restaurants = await systemCategoryId(f.admin, "expense.restaurants");
    salary = await systemCategoryId(f.admin, "income.salary");
    sub = (
      await createCategory(f.deps, f.A, f.HA, {
        name: "Piață",
        kind: "expense",
        parentId: groceries,
      })
    ).id;
  });
  afterAll(async () => {
    await f?.close();
  });

  const spend = (
    amountMinor: number,
    occurredOn: string,
    extra: Record<string, unknown> = {},
    actor = f.A,
  ) =>
    createTransaction(f.deps, actor, f.HA, {
      accountId: ron,
      type: "expense",
      amountMinor,
      occurredOn,
      ...extra,
    });

  it("creare: validare, categorie de venit → 400, categoria altei gospodării → 404, dublură → 409", async () => {
    await expect(
      createBudget(deps(), f.A, f.HA, { categoryId: salary, amountMinor: 100, currency: "RON" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const catB = await createCategory(f.deps, f.B, f.HB, { name: "Cat B", kind: "expense" });
    await expect(
      createBudget(deps(), f.A, f.HA, { categoryId: catB.id, amountMinor: 100, currency: "RON" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    for (const bad of [
      { amountMinor: 0, currency: "RON" },
      { amountMinor: 10_000_000_000_001, currency: "RON" },
      { amountMinor: 100, currency: "GBP" },
      { amountMinor: 100, currency: "RON", warnPct: 0 },
      { amountMinor: 100, currency: "RON", warnPct: 101 },
      { amountMinor: 100, amount: "1,00", currency: "RON" },
      { amountMinor: 100, currency: "RON", householdId: f.HB },
      { amountMinor: 100, currency: "RON", userId: f.C.userId },
    ]) {
      await expect(
        createBudget(deps(), f.A, f.HA, bad),
        JSON.stringify(bad),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    const b = await createBudget(deps(), f.A, f.HA, { amount: "1.234,50", currency: "USD" });
    expect(b).toMatchObject({
      amountMinor: 123_450n,
      warnPct: 80,
      scope: "household",
      categoryId: null,
    });
    await expect(
      createBudget(deps(), f.A, f.HA, { amountMinor: 5, currency: "USD" }),
    ).rejects.toMatchObject({ reason: "budget_exists" });
    // Arhivat → se poate crea altul; dezarhivarea lui ar dubla → 409.
    await updateBudget(deps(), f.A, f.HA, b.id, { archived: true });
    await createBudget(deps(), f.A, f.HA, { amountMinor: 5, currency: "USD" });
    await expect(updateBudget(deps(), f.A, f.HA, b.id, { archived: false })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("octombrie: limite exacte 79/80/81% pe categorie (cu subcategorie), transfer și venit excluse, altă monedă separat", async () => {
    const cat = await createBudget(deps(), f.A, f.HA, {
      categoryId: groceries,
      amountMinor: 10_000,
      currency: "RON",
    });
    const general = await createBudget(deps(), f.A, f.HA, { amountMinor: 20_000, currency: "RON" });
    const eurBudget = await createBudget(deps(), f.A, f.HA, {
      amountMinor: 1_000,
      currency: "EUR",
    });
    const status = async () => {
      const all = await getBudgetStatuses(deps(), f.A, f.HA, { month: "2026-10" });
      return (id: string) => all.find((s) => s.id === id)!;
    };

    await spend(7_000, "2026-10-01", { categoryId: groceries });
    await spend(900, "2026-10-31", { categoryId: sub }); // subcategoria intră la părinte
    let s = await status();
    expect(s(cat.id)).toMatchObject({ spentMinor: 7_900n, percent: 79, status: "green" });

    // Excluse: luna următoare/anterioară, transferul, venitul, altă categorie (la bugetul pe
    // categorie), altă monedă.
    await spend(5_000, "2026-11-01", { categoryId: groceries });
    await spend(5_000, "2026-09-30", { categoryId: groceries });
    await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: ron,
      toAccountId: ron2,
      amountMinor: 50_000,
      occurredOn: "2026-10-10",
    });
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: ron,
      type: "income",
      amountMinor: 90_000,
      occurredOn: "2026-10-10",
      categoryId: salary,
    });
    await spend(1_000, "2026-10-05", { categoryId: restaurants });
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: eur,
      type: "expense",
      amountMinor: 800,
      occurredOn: "2026-10-05",
      categoryId: groceries,
    });
    s = await status();
    expect(s(cat.id)).toMatchObject({ spentMinor: 7_900n, status: "green" });
    expect(s(general.id)).toMatchObject({ spentMinor: 8_900n, percent: 44, status: "green" });
    expect(s(eurBudget.id)).toMatchObject({ spentMinor: 800n, percent: 80, status: "yellow" });

    await spend(100, "2026-10-15", { categoryId: groceries });
    expect((await status())(cat.id)).toMatchObject({ percent: 80, status: "yellow" });
    await spend(100, "2026-10-15", { categoryId: groceries });
    expect((await status())(cat.id)).toMatchObject({ percent: 81, status: "yellow" });
    await spend(1_800, "2026-10-15", { categoryId: groceries }); // 99%
    expect((await status())(cat.id)).toMatchObject({ percent: 99, status: "yellow" });
    await spend(100, "2026-10-15", { categoryId: sub }); // exact 100%
    s = await status();
    expect(s(cat.id)).toMatchObject({
      spentMinor: 10_000n,
      percent: 100,
      remainingMinor: 0n,
      status: "yellow",
    });
    await spend(1, "2026-10-15", { categoryId: groceries }); // 100,01% → roșu, afișat 100
    s = await status();
    expect(s(cat.id)).toMatchObject({ percent: 100, remainingMinor: -1n, status: "red" });
    await spend(99, "2026-10-15", { categoryId: groceries }); // 101%
    s = await status();
    expect(s(cat.id)).toMatchObject({ percent: 101, remainingMinor: -100n, status: "red" });
    expect(budgetStatusToJson(s(cat.id))).toMatchObject({
      spentMinor: 10_100,
      remainingMinor: -100,
      amountMinor: 10_000,
      month: "2026-10",
    });

    // „Luna curentă” = octombrie (31 oct 23:30 local); alertele: roșii întâi.
    const alerts = await getBudgetAlerts(deps(), f.A, f.HA);
    expect(alerts.map((a) => a.id)).toEqual([cat.id, eurBudget.id]);
    // Peste jumătate de oră e 1 noiembrie local: altă lună, doar cheltuiala din 1 noiembrie.
    clock = new Date("2026-10-31T22:00:00Z");
    const nov = await getBudgetStatuses(deps(), f.A, f.HA);
    expect(nov.find((x) => x.id === cat.id)).toMatchObject({
      month: "2026-11",
      spentMinor: 5_000n,
    });
    clock = new Date("2026-10-31T21:30:00Z");
  });

  it("februarie bisect: 29 feb inclus, 1 martie exclus; martie (DST) are 31 de zile", async () => {
    const b = await createBudget(deps(), f.A, f.HA, {
      categoryId: restaurants,
      amountMinor: 1_000,
      currency: "RON",
      warnPct: 50,
    });
    await spend(300, "2028-02-01", { categoryId: restaurants });
    await spend(200, "2028-02-29", { categoryId: restaurants });
    await spend(700, "2028-03-01", { categoryId: restaurants });
    await spend(50, "2028-03-31", { categoryId: restaurants });
    const feb = (await getBudgetStatuses(deps(), f.A, f.HA, { month: "2028-02" })).find(
      (x) => x.id === b.id,
    )!;
    expect(feb).toMatchObject({ spentMinor: 500n, percent: 50, status: "yellow" });
    const mar = (await getBudgetStatuses(deps(), f.A, f.HA, { month: "2028-03" })).find(
      (x) => x.id === b.id,
    )!;
    expect(mar).toMatchObject({ spentMinor: 750n, status: "yellow" });
    await expect(getBudgetStatuses(deps(), f.A, f.HA, { month: "2028-13" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("buget personal: doar cheltuielile proprietarului; invizibil celorlalți membri", async () => {
    const mine = await createBudget(deps(), f.A, f.HA, {
      amountMinor: 1_000,
      currency: "RON",
      scope: "personal",
    });
    expect(mine.userId).toBe(f.A.userId);
    await spend(100, "2027-01-10", {}, f.A);
    await spend(400, "2027-01-10", {}, f.C);
    const a = (await getBudgetStatuses(deps(), f.A, f.HA, { month: "2027-01" })).find(
      (x) => x.id === mine.id,
    )!;
    expect(a.spentMinor).toBe(100n);
    // Bugetul general al gospodăriei vede ambele cheltuieli.
    const general = (await getBudgetStatuses(deps(), f.A, f.HA, { month: "2027-01" })).find(
      (x) => x.scope === "household" && x.categoryId === null && x.currency === "RON",
    )!;
    expect(general.spentMinor).toBe(500n);
    // C nu vede, nu modifică și nu șterge bugetul personal al lui A.
    expect((await listBudgets(deps(), f.C, f.HA)).map((x) => x.id)).not.toContain(mine.id);
    await expect(getBudget(deps(), f.C, f.HA, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateBudget(deps(), f.C, f.HA, mine.id, { warnPct: 10 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteBudget(deps(), f.C, f.HA, mine.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(
      (await getBudgetStatuses(deps(), f.C, f.HA, { month: "2027-01" })).map((x) => x.id),
    ).not.toContain(mine.id);
    // C își poate face propriul buget personal (unic per utilizator).
    await createBudget(deps(), f.C, f.HA, { amountMinor: 5, currency: "RON", scope: "personal" });
  });

  it("izolare: B nu vede, nu modifică și nu șterge bugetele lui A; B nu folosește HA", async () => {
    const b = (await listBudgets(deps(), f.A, f.HA))[0]!;
    await expect(getBudget(deps(), f.B, f.HB, b.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBudget(deps(), f.B, f.HA, b.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateBudget(deps(), f.B, f.HB, b.id, { warnPct: 1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteBudget(deps(), f.B, f.HB, b.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getBudgetStatuses(deps(), f.B, f.HA)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listBudgets(deps(), f.B, f.HB)).toEqual([]);
    // Cheltuielile lui B nu ajung în bugetele lui A.
    await createTransaction(f.deps, f.B, f.HB, {
      accountId: accB,
      type: "expense",
      amountMinor: 99_999,
      occurredOn: "2026-10-15",
    });
    const general = (await getBudgetStatuses(deps(), f.A, f.HA, { month: "2026-10" })).find(
      (x) => x.scope === "household" && x.categoryId === null && x.currency === "RON",
    )!;
    expect(general.spentMinor).toBe(11_100n);
  });

  it("modificare (sumă, prag, arhivare) și ștergere cu audit fără sume", async () => {
    const b = await createBudget(deps(), f.A, f.HA, {
      categoryId: sub,
      amountMinor: 100,
      currency: "RON",
    });
    const u = await updateBudget(deps(), f.A, f.HA, b.id, { amount: "2,50", warnPct: 90 });
    expect(u).toMatchObject({ amountMinor: 250n, warnPct: 90 });
    await expect(updateBudget(deps(), f.A, f.HA, b.id, { currency: "EUR" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(updateBudget(deps(), f.A, f.HA, b.id, {})).rejects.toBeInstanceOf(ValidationError);
    const archived = await updateBudget(deps(), f.A, f.HA, b.id, { archived: true });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await listBudgets(deps(), f.A, f.HA)).map((x) => x.id)).not.toContain(b.id);
    expect(
      (await listBudgets(deps(), f.A, f.HA, { includeArchived: true })).map((x) => x.id),
    ).toContain(b.id);
    await deleteBudget(deps(), f.A, f.HA, b.id);
    await expect(getBudget(deps(), f.A, f.HA, b.id)).rejects.toBeInstanceOf(NotFoundError);
    const [audit] = await f.admin<{ metadata: unknown }[]>`
      select metadata from finet.audit_events where action = 'budget.deleted' and target_id = ${b.id}`;
    expect(audit!.metadata).toEqual({ scope: "household" });
  });
});
