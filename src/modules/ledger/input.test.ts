import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ValidationError } from "@/lib/errors";
import { MoneyOverflowError } from "@/lib/money";
import { accountToJson } from "@/modules/accounts/accounts.schema";
import { escapeLike } from "@/modules/transactions/transactions.repo";
import {
  type TransactionView,
  decodeCursor,
  encodeCursor,
  transactionCreateSchema,
  transactionListSchema,
  transactionToJson,
} from "@/modules/transactions/transactions.schema";
import { transferCreateSchema } from "@/modules/transfers/transfers.schema";

import { isCalendarDate, parseInput, resolveAmount, resolvePositiveAmount } from "./input";

describe("isCalendarDate (5.2)", () => {
  it.each(["2026-10-28", "2024-02-29", "1900-01-01", "2999-12-31"])("acceptă %s", (d) => {
    expect(isCalendarDate(d)).toBe(true);
  });
  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-00-10",
    "1899-12-31",
    "3000-01-01",
    "2026-1-1",
    "28.10.2026",
    "2026-10-28T00:00:00Z",
    "",
  ])("respinge %s", (d) => {
    expect(isCalendarDate(d)).toBe(false);
  });
});

describe("sumele din intrări: întregi sau text, niciodată float", () => {
  it("amountMinor întreg → bigint", () => {
    expect(resolvePositiveAmount({ amountMinor: 12345 }, "RON")).toBe(12345n);
  });
  it("text românesc → bigint prin parseAmount", () => {
    expect(resolvePositiveAmount({ amount: "1.234,56" }, "RON")).toBe(123456n);
    expect(resolveAmount({ amount: "-50,5" }, "EUR", "openingBalanceMinor", true)).toBe(-5050n);
  });
  it("zecimale, zero, negativ, ambiguu și peste 2^53 sunt respinse", () => {
    for (const input of [
      { amountMinor: 12.5 },
      { amountMinor: 0 },
      { amountMinor: -1 },
      { amountMinor: Number.MAX_SAFE_INTEGER + 2 },
      { amount: "1.234" },
      { amount: "0" },
      { amount: "-3" },
      {},
    ]) {
      expect(() => resolvePositiveAmount(input, "RON"), JSON.stringify(input)).toThrow(
        ValidationError,
      );
    }
  });
  it("schema tranzacției respinge suma ca string numeric, float și ambele forme deodată", () => {
    const base = {
      accountId: randomUUID(),
      type: "expense",
      occurredOn: "2026-10-28",
    };
    expect(() => parseInput(transactionCreateSchema, { ...base, amountMinor: "100" })).toThrow(
      ValidationError,
    );
    expect(() => parseInput(transactionCreateSchema, { ...base, amountMinor: 1.5 })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseInput(transactionCreateSchema, { ...base, amountMinor: 100, amount: "1,00" }),
    ).toThrow(ValidationError);
  });
  it("schemele sunt stricte: householdId, currency, source sau type=transfer în body → 400", () => {
    const base = {
      accountId: randomUUID(),
      type: "expense",
      amountMinor: 100,
      occurredOn: "2026-10-28",
    };
    for (const extra of [
      { householdId: randomUUID() },
      { currency: "EUR" },
      { source: "receipt" },
      { createdByUserId: randomUUID() },
    ]) {
      try {
        parseInput(transactionCreateSchema, { ...base, ...extra });
        throw new Error("trebuia respins");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).fields[Object.keys(extra)[0]!]).toBe("Câmp nepermis.");
      }
    }
    expect(() => parseInput(transactionCreateSchema, { ...base, type: "transfer" })).toThrow(
      ValidationError,
    );
  });
  it("transferul: același cont și forme de sumă amestecate sunt respinse", () => {
    const a = randomUUID();
    expect(() =>
      parseInput(transferCreateSchema, {
        fromAccountId: a,
        toAccountId: a,
        amountMinor: 1,
        occurredOn: "2026-10-28",
      }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInput(transferCreateSchema, {
        fromAccountId: a,
        toAccountId: randomUUID(),
        amountMinor: 1,
        amountFromMinor: 1,
        amountToMinor: 1,
        occurredOn: "2026-10-28",
      }),
    ).toThrow(ValidationError);
  });
  it("lista: intervale inversate respinse", () => {
    expect(() =>
      parseInput(transactionListSchema, { dateFrom: "2026-10-02", dateTo: "2026-10-01" }),
    ).toThrow(ValidationError);
    expect(() =>
      parseInput(transactionListSchema, { amountMinMinor: 10, amountMaxMinor: 5 }),
    ).toThrow(ValidationError);
  });
});

describe("cursorul de paginare", () => {
  const id = randomUUID();
  it("dus-întors, legat de sortare", () => {
    const c = encodeCursor({ sort: "date_desc", key: "2026-10-28", id });
    expect(decodeCursor(c, "date_desc")).toEqual({ sort: "date_desc", key: "2026-10-28", id });
    expect(() => decodeCursor(c, "date_asc")).toThrow(ValidationError);
    const amount = encodeCursor({ sort: "amount_asc", key: "900719925474099300", id });
    expect(decodeCursor(amount, "amount_asc").key).toBe("900719925474099300");
  });
  it("respinge cursoare modificate sau invalide", () => {
    const forge = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const raw of [
      "nu-e-base64!",
      forge({ v: 2, s: "date_desc", k: "2026-10-28", i: id }),
      forge({ v: 1, s: "date_desc", k: "2026-02-30", i: id }),
      forge({ v: 1, s: "date_desc", k: "2026-10-28", i: "x" }),
      forge({ v: 1, s: "date_desc", k: "2026-10-28", i: id, extra: 1 }),
      forge({ v: 1, s: "amount_desc", k: "12.5", i: id }),
      forge({ v: 1, s: "amount_desc", k: 125, i: id }),
      forge({ v: 1, s: "amount_desc", k: "99999999999999999999", i: id }),
      forge("text"),
    ]) {
      expect(() => decodeCursor(raw, "date_desc"), raw).toThrow(ValidationError);
      expect(() => decodeCursor(raw, "amount_desc"), raw).toThrow(ValidationError);
    }
  });
});

describe("escapeLike", () => {
  it("tratează %, _ și \\ ca litere", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

describe("serializarea JSON (6.4)", () => {
  const t: TransactionView = {
    id: randomUUID(),
    accountId: randomUUID(),
    categoryId: null,
    type: "expense",
    amountMinor: 123456n,
    currency: "RON",
    occurredOn: "2026-10-28",
    description: null,
    merchant: null,
    notes: null,
    source: "manual",
    transferGroupId: null,
    transferDirection: null,
    recurringRuleId: null,
    createdByUserId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  it("amountMinor ca întreg JSON", () => {
    const json = transactionToJson(t);
    expect(json.amountMinor).toBe(123456);
    expect(JSON.parse(JSON.stringify(json)).amountMinor).toBe(123456);
  });
  it("peste 2^53 − 1 serializarea aruncă (tranzacție și sold de cont)", () => {
    expect(() => transactionToJson({ ...t, amountMinor: 2n ** 53n })).toThrow(MoneyOverflowError);
    expect(() =>
      accountToJson({
        id: t.id,
        name: "X",
        type: "bank",
        currency: "RON",
        openingBalanceMinor: 0n,
        balanceMinor: -(2n ** 53n),
        bankCode: null,
        ownerUserId: null,
        archivedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }),
    ).toThrow(MoneyOverflowError);
  });
});
