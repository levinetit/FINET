import { describe, expect, it } from "vitest";

import { type HistoryTx, detectRecurring, merchantKey } from "./suggestions";

const A = "00000000-0000-4000-8000-0000000000a1";
const tx = (occurredOn: string, amountMinor: bigint, over: Partial<HistoryTx> = {}): HistoryTx => ({
  accountId: A,
  type: "expense",
  currency: "RON",
  amountMinor,
  occurredOn,
  description: "Netflix.com Amsterdam",
  merchant: null,
  categoryId: null,
  ...over,
});
const monthly = (days: readonly string[], amount = 4999n, over: Partial<HistoryTx> = {}) =>
  days.map((d) => tx(d, amount, over));

/** Detectarea plăților recurente (ADR 0019): toleranțe documentate, nimic creat automat. */
describe("propunerile de plăți recurente", () => {
  const today = "2026-11-20";

  it("lunar: 4 apariții la 28–31 de zile, sumă stabilă → o propunere cu următoarea dată", () => {
    const [s, ...rest] = detectRecurring(
      monthly(["2026-08-06", "2026-09-06", "2026-10-06", "2026-11-06"]),
      [],
      today,
    );
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      frequency: "monthly",
      amountMinor: 4999n,
      occurrences: 4,
      lastOn: "2026-11-06",
      nextOn: "2026-12-06",
      accountId: A,
    });
    expect(s!.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("săptămânal și anual", () => {
    const weekly = detectRecurring(
      monthly(["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"], 2500n, {
        description: "Abonament sala",
      }),
      [],
      today,
    );
    expect(weekly[0]).toMatchObject({ frequency: "weekly", nextOn: "2026-11-27" });
    const yearly = detectRecurring(
      monthly(["2025-03-10", "2026-03-10"], 30000n, { description: "Asigurare casa" }),
      [],
      today,
    );
    expect(yearly[0]).toMatchObject({ frequency: "yearly", nextOn: "2027-03-10" });
  });

  it("toleranța sumei: ±10% trece, +15% nu", () => {
    expect(
      detectRecurring(
        [
          tx("2026-08-06", 5000n),
          tx("2026-09-06", 5400n),
          tx("2026-10-06", 4600n),
          tx("2026-11-06", 5000n),
        ],
        [],
        today,
      ),
    ).toHaveLength(1);
    expect(
      detectRecurring(
        [tx("2026-08-06", 5000n), tx("2026-09-06", 5750n), tx("2026-10-06", 5000n)],
        [],
        today,
      ),
    ).toHaveLength(0);
  });

  it("negativ: neregulat, prea puține apariții, oprit de mult, transferuri ignorate prin apelant", () => {
    expect(detectRecurring(monthly(["2026-08-06", "2026-08-20", "2026-11-06"]), [], today)).toEqual(
      [],
    );
    expect(detectRecurring(monthly(["2026-10-06", "2026-11-06"]), [], today)).toEqual([]);
    expect(
      detectRecurring(monthly(["2026-03-06", "2026-04-06", "2026-05-06", "2026-06-06"]), [], today),
    ).toEqual([]);
  });

  it("exclus: o regulă existentă echivalentă sau o propunere respinsă (amprenta)", () => {
    const history = monthly(["2026-08-06", "2026-09-06", "2026-10-06", "2026-11-06"]);
    const rule = {
      accountId: A,
      type: "expense" as const,
      currency: "RON",
      amountMinor: 4999n,
      frequency: "monthly",
      description: "Netflix",
      merchant: null,
    };
    expect(detectRecurring(history, [rule], today)).toEqual([]);
    const [s] = detectRecurring(history, [], today);
    expect(detectRecurring(history, [], today, new Set([s!.signature]))).toEqual([]);
  });

  it("comerciantul normalizat: aceleași cuvinte semnificative, cifrele și termenii bancari ignorați", () => {
    expect(merchantKey(null, "Plata la POS NETFLIX.COM 4999")).toBe("netflix com");
    expect(merchantKey("Spotify AB", "orice")).toBe("spotify");
    expect(merchantKey(null, "123 456")).toBeNull();
  });
});
