import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { createBudget } from "@/modules/budgets/budgets.service";
import { contributeToGoal, createGoal } from "@/modules/goals/goals.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTag } from "@/modules/tags/tags.service";
import { createTransaction } from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import {
  BUDGET_COLUMNS,
  GOAL_COLUMNS,
  TRANSACTION_COLUMNS,
  collectCsv,
  exportBudgetsCsv,
  exportGoalsCsv,
  exportTransactionsCsv,
} from "./exports.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const BOM = "﻿";
const lines = (csv: string) => csv.slice(1).split("\r\n").slice(0, -1);

describe.skipIf(!TEST_ADMIN_URL)("export CSV (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let ron: string;
  let cash: string;
  let groceries: string;
  let t1: string;
  let t2: string;
  let tagA: string;
  let tagZ: string;
  let transferGroup: string;
  let transferOut: string;
  let transferIn: string;
  const deps = () => ({ ...f.deps, now: () => new Date("2026-04-15T10:00:00Z") });

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_export");
    ron = (
      await createAccount(f.deps, f.A, f.HA, {
        name: "Banca, principală",
        type: "bank",
        currency: "RON",
      })
    ).id;
    cash = (
      await createAccount(f.deps, f.A, f.HA, { name: "Numerar", type: "cash", currency: "RON" })
    ).id;
    groceries = await systemCategoryId(f.admin, "expense.groceries");
    tagA = (await createTag(f.deps, f.A, f.HA, { name: "Acasă" })).id;
    tagZ = (await createTag(f.deps, f.A, f.HA, { name: "=Zăpadă" })).id;
    t1 = (
      await createTransaction(f.deps, f.A, f.HA, {
        accountId: ron,
        type: "expense",
        amount: "1.234,56",
        occurredOn: "2026-04-01",
        categoryId: groceries,
        merchant: "=cmd|' /C calc'!A0",
        description: 'Cumpărături "mari", săptămâna 1',
        notes: "linia 1\nlinia 2",
        tagIds: [tagZ, tagA],
      })
    ).id;
    t2 = (
      await createTransaction(f.deps, f.A, f.HA, {
        accountId: cash,
        type: "income",
        amountMinor: 5,
        occurredOn: "2026-04-02",
        description: "-minus",
      })
    ).id;
    const tr = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: ron,
      toAccountId: cash,
      amountMinor: 1_000,
      occurredOn: "2026-04-03",
    });
    transferGroup = tr.id;
    transferOut = tr.from.transactionId;
    transferIn = tr.to.transactionId;
    // Date ale altei gospodării: nu trebuie să apară niciodată.
    const accB = (
      await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" })
    ).id;
    await createTransaction(f.deps, f.B, f.HB, {
      accountId: accB,
      type: "expense",
      amountMinor: 777,
      occurredOn: "2026-04-01",
      merchant: "SECRET-B",
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  const created = async (id: string) => {
    const [row] = await f.admin<{ created_at: Date }[]>`
      select created_at from finet.transactions where id = ${id}`;
    return row!.created_at.toISOString();
  };

  // Etichetele: ordonate după `localeCompare("ro")` (punctuația înaintea literelor), unite cu `|`;
  // celula începe cu `=` → apostrof în față.
  it("tranzacții: conținut exact (BOM, antet, ghilimele, injecție, etichete, transfer)", async () => {
    const csv = await collectCsv(exportTransactionsCsv(deps(), f.A, f.HA));
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const out = csv.slice(1).split("\r\n");
    expect(out[0]).toBe(TRANSACTION_COLUMNS.join(","));
    const expected =
      [
        TRANSACTION_COLUMNS.join(","),
        `${t1},2026-04-01,expense,,${ron},"Banca, principală",${groceries},Alimente,'=Zăpadă|Acasă,123456,RON,1234.56,'=cmd|' /C calc'!A0,"Cumpărături ""mari"", săptămâna 1","linia 1\nlinia 2",manual,,${await created(t1)}`,
        `${t2},2026-04-02,income,,${cash},Numerar,,,,5,RON,0.05,,'-minus,,manual,,${await created(t2)}`,
      ].join("\r\n") + "\r\n";
    // Cele două rânduri de transfer (aceeași zi): ordinea după id.
    const legs = [
      [transferOut, "out", ron, "Banca, principală"],
      [transferIn, "in", cash, "Numerar"],
    ].sort((a, b) => a[0]!.localeCompare(b[0]!));
    const legLines = await Promise.all(
      legs.map(
        async ([id, dir, acc, name]) =>
          `${id},2026-04-03,transfer,${dir},${acc},${name!.includes(",") ? `"${name}"` : name},,,,1000,RON,10.00,,,,manual,${transferGroup},${await created(id!)}`,
      ),
    );
    expect(csv).toBe(BOM + expected + legLines.join("\r\n") + "\r\n");
    expect(csv).not.toContain("SECRET-B");
  });

  it("filtrele listei se aplică; dialectul ro (; și virgulă zecimală)", async () => {
    const byTag = lines(
      await collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, { tagIds: [tagA] })),
    );
    expect(byTag).toHaveLength(2);
    expect(byTag[1]!.startsWith(`${t1},`)).toBe(true);
    // Faza 4: `tagMatch=all` trece prin aceleași filtre ca lista.
    const byAll = lines(
      await collectCsv(
        exportTransactionsCsv(deps(), f.A, f.HA, { tagIds: [tagA, tagZ], tagMatch: "all" }),
      ),
    );
    expect(byAll).toHaveLength(2);
    expect(byAll[1]!.startsWith(`${t1},`)).toBe(true);
    const ro = lines(
      await collectCsv(
        exportTransactionsCsv(deps(), f.A, f.HA, { type: "income" }, { dialect: "ro" }),
      ),
    );
    expect(ro[0]).toBe(TRANSACTION_COLUMNS.join(";"));
    expect(ro[1]).toBe(
      `${t2};2026-04-02;income;;${cash};Numerar;;;;5;RON;0,05;;'-minus;;manual;;${await created(t2)}`,
    );
    await expect(
      collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, {}, { dialect: "xls" as never })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, { limit: 5 })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("plafonul de rânduri: peste → 409 fără conținut; exact la plafon, pe pagini mici, complet și ordonat", async () => {
    await expect(
      collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, {}, { maxRows: 3 })),
    ).rejects.toBeInstanceOf(ConflictError);
    const it4 = exportTransactionsCsv(deps(), f.A, f.HA, {}, { maxRows: 3 });
    await expect(it4.next()).rejects.toMatchObject({ reason: "export_too_large" });
    const full = lines(
      await collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, {}, { maxRows: 4, pageSize: 1 })),
    );
    const all = lines(await collectCsv(exportTransactionsCsv(deps(), f.A, f.HA)));
    expect(full).toEqual(all);
    expect(full).toHaveLength(5);
  });

  it("izolare: B exportă doar datele lui; B pe HA → 404; fără context nimic", async () => {
    const b = lines(await collectCsv(exportTransactionsCsv(deps(), f.B, f.HB)));
    expect(b).toHaveLength(2);
    expect(b[1]).toContain("SECRET-B");
    expect(b.join("\n")).not.toContain(t1);
    await expect(collectCsv(exportTransactionsCsv(deps(), f.B, f.HA))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(exportGoalsCsv(deps(), f.B, f.HA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(exportBudgetsCsv(deps(), f.B, f.HA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, { householdId: f.HB })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("obiective și bugete: coloane stabile, sume exacte, rest negativ fără prefix", async () => {
    const g = await createGoal(f.deps, f.A, f.HA, {
      name: "@Vacanță",
      targetMinor: 100_000,
      currency: "RON",
    });
    await contributeToGoal(f.deps, f.A, f.HA, g.id, { direction: "add", amountMinor: 25_050 });
    const goals = lines(await exportGoalsCsv(deps(), f.A, f.HA));
    const [gRow] = await f.admin<
      { created_at: Date }[]
    >`select created_at from finet.goals where id = ${g.id}`;
    expect(goals).toEqual([
      GOAL_COLUMNS.join(","),
      `${g.id},'@Vacanță,active,RON,100000,1000.00,25050,250.50,25,,,${gRow!.created_at.toISOString()}`,
    ]);
    const b = await createBudget(f.deps, f.A, f.HA, {
      categoryId: groceries,
      amountMinor: 100_000,
      currency: "RON",
    });
    const budgets = lines(await exportBudgetsCsv(deps(), f.A, f.HA, {}));
    expect(budgets).toEqual([
      BUDGET_COLUMNS.join(","),
      `${b.id},2026-04,household,${groceries},Alimente,RON,100000,1000.00,80,123456,1234.56,-23456,-234.56,123,red`,
    ]);
    const ro = lines(
      await exportBudgetsCsv(deps(), f.A, f.HA, { month: "2026-05" }, { dialect: "ro" }),
    );
    expect(ro[1]).toBe(
      `${b.id};2026-05;household;${groceries};Alimente;RON;100000;1000,00;80;0;0,00;100000;1000,00;0;green`,
    );
    // B nu vede nimic din HA.
    expect(lines(await exportGoalsCsv(deps(), f.B, f.HB))).toEqual([GOAL_COLUMNS.join(",")]);
    expect(lines(await exportBudgetsCsv(deps(), f.B, f.HB))).toEqual([BUDGET_COLUMNS.join(",")]);
  });
});
