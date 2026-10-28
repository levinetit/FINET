import { describe, expect, it } from "vitest";

import { formatMoney, money } from "@/lib/money";
import { ro } from "@/messages/ro";

import {
  amountInputValue,
  apiErrors,
  formatCalendarDate,
  formatMinor,
  formatSigned,
  parseAmountInput,
  todayIn,
} from "./ledger-ui";

describe("sumele în interfață", () => {
  it("formatează din `amountMinor` întreg, românește", () => {
    expect(formatMinor(123456, "RON")).toBe(formatMoney(money(123456n, "RON")));
    expect(formatMinor(123456, "RON")).toBe("1.234,56 lei");
    expect(formatMinor(-5, "EUR")).toBe("-0,05 €");
    expect(formatSigned("expense", 1000, "RON")).toBe("−10,00 lei");
    expect(formatSigned("income", 1000, "RON")).toBe("+10,00 lei");
    expect(formatSigned("transfer", 1000, "RON")).toBe("10,00 lei");
  });

  it.each([
    ["1234,56", 123456],
    ["1.234,56", 123456],
    ["1234.56", 123456],
    ["0,5", 50],
    ["1 234,50", 123450],
    ["12", 1200],
  ])("parsează %s → %i bani", (text, minor) => {
    expect(parseAmountInput(text, "RON")).toEqual({ ok: true, amountMinor: minor });
  });

  it("valorile ambigue și invalide dau mesajul din ro.ts", () => {
    expect(parseAmountInput("1.234", "RON")).toEqual({
      ok: false,
      message: ro.ledger.amountErrors.ambiguous,
    });
    expect(parseAmountInput("", "RON")).toEqual({
      ok: false,
      message: ro.ledger.amountErrors.empty,
    });
    expect(parseAmountInput("1,234", "RON")).toMatchObject({ ok: false });
    expect(parseAmountInput("12,345", "RON")).toMatchObject({ ok: false });
    expect(parseAmountInput("abc", "RON")).toMatchObject({ ok: false });
    expect(parseAmountInput("-10", "RON")).toEqual({
      ok: false,
      message: ro.ledger.amountErrors.negative_not_allowed,
    });
    expect(parseAmountInput("0", "RON", { positive: true })).toEqual({
      ok: false,
      message: ro.ledger.amountErrors.not_positive,
    });
  });

  it("soldul inițial acceptă negativ", () => {
    expect(parseAmountInput("-1.234,50", "RON", { allowNegative: true })).toEqual({
      ok: true,
      amountMinor: -123450,
    });
  });

  it("valoarea câmpului de editare se poate parsa înapoi exact", () => {
    for (const minor of [0, 5, 99, 100, 123456, -250, 9_007_199_254_740_991]) {
      const text = amountInputValue(minor, "RON");
      expect(parseAmountInput(text, "RON", { allowNegative: true })).toEqual({
        ok: true,
        amountMinor: minor,
      });
    }
  });
});

describe("erorile API → mesaje", () => {
  it("400 cu `fields`: mesajele rămân la câmp; `_` devine mesajul general", () => {
    const r = apiErrors({
      status: 400,
      error: { code: "invalid_request", message: "x", fields: { amount: "A", _: "Root" } },
    });
    expect(r).toEqual({ form: "Root", fields: { amount: "A" } });
  });

  it("409 după `reason`, 404/429/rețea cu mesaje fixe", () => {
    expect(
      apiErrors({
        status: 409,
        error: { code: "conflict", message: "x", reason: "account_not_empty" },
      }).form,
    ).toBe(ro.ledger.errors.reasons.account_not_empty);
    expect(
      apiErrors({
        status: 409,
        error: { code: "request_in_progress", message: "x", reason: "request_in_progress" },
      }).form,
    ).toBe(ro.ledger.errors.inProgress);
    expect(apiErrors({ status: 404, error: null }).form).toBe(ro.ledger.errors.notFound);
    expect(apiErrors({ status: 429, error: null }).form).toBe(ro.ledger.errors.rateLimited);
    expect(apiErrors({ status: 0, error: null }).form).toBe(ro.ledger.errors.network);
    expect(apiErrors({ status: 500, error: null }).form).toBe(ro.ledger.errors.generic);
  });
});

describe("datele calendaristice", () => {
  it("azi în Europe/Bucharest (peste miezul nopții UTC)", () => {
    // 2026-10-27 22:30 UTC = 2026-10-28 00:30 la București (EET, UTC+2).
    expect(todayIn("Europe/Bucharest", new Date("2026-10-27T22:30:00Z"))).toBe("2026-10-28");
    expect(todayIn("UTC", new Date("2026-10-27T22:30:00Z"))).toBe("2026-10-27");
  });

  it("formatează data fără fus orar", () => {
    // Faza 4: `zz.ll.aaaa` (5.3), ca în paginile de planificare (înainte: „5 ian. 2026”).
    expect(formatCalendarDate("2026-01-05")).toBe("05.01.2026");
    expect(formatCalendarDate("2026-10-28")).toBe("28.10.2026");
    expect(formatCalendarDate("x")).toBe("x");
  });
});
