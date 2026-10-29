import { describe, expect, it } from "vitest";

import {
  counterAmountMinor,
  coverageLabel,
  formFromSuggestion,
  formatMonth,
  lastMonths,
  mappingFromForm,
  statementErrorText,
  warningTexts,
} from "./statements-ui";

describe("interfața extraselor (funcții pure)", () => {
  it("texte pentru coduri fixe; codurile necunoscute nu se afișează brut", () => {
    expect(statementErrorText("unknown_bank")).toMatch(/CSV/);
    expect(statementErrorText("<script>")).toBe("Extrasul nu a putut fi citit.");
    expect(statementErrorText(null)).toBe("Extrasul nu a putut fi citit.");
    expect(warningTexts(["pending_skipped", "necunoscut"])).toHaveLength(1);
  });

  it("acoperirea: complet / parțial până la o dată / lipsă; lunile", () => {
    expect(
      coverageLabel({ month: "2026-10", status: "complete", coveredUntil: null, fromStart: true }),
    ).toBe("Complet");
    expect(
      coverageLabel({
        month: "2026-10",
        status: "partial",
        coveredUntil: "2026-10-15",
        fromStart: true,
      }),
    ).toBe("Parțial, până la 15.10.2026");
    expect(
      coverageLabel({ month: "2026-10", status: "missing", coveredUntil: null, fromStart: false }),
    ).toBe("Lipsă");
    expect(formatMonth("2026-03")).toBe("03.2026");
    expect(lastMonths("2026-02-10", 12)).toEqual({ from: "2025-03", to: "2026-02" });
  });

  it("maparea din formular: sumă cu semn sau debit/credit; câmpurile goale lipsesc", () => {
    const base = formFromSuggestion({
      headerRow: 0,
      date: 0,
      description: [1],
      amount: 2,
      decimal: ",",
    });
    expect(mappingFromForm(base)).toEqual({
      headerRow: 0,
      date: 0,
      dateFormat: "dmy_dot",
      decimal: ",",
      thousands: "",
      description: [1],
      amount: 2,
      negativeIs: "debit",
    });
    expect(
      mappingFromForm({ ...base, mode: "split", debit: "3", credit: "4", reference: "5" }),
    ).toMatchObject({
      debit: 3,
      credit: 4,
      reference: 5,
    });
  });

  it("suma schimbului: `10,00` → 1000; textul invalid → null", () => {
    expect(counterAmountMinor("10,00", "EUR")).toBe(1000);
    expect(counterAmountMinor("abc", "EUR")).toBeNull();
    expect(counterAmountMinor("0", "EUR")).toBeNull();
  });
});
