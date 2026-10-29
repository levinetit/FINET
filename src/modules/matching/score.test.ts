import { describe, expect, it } from "vitest";

import { dayDistance, merchantTokens, rankCandidates, scoreMatch, taxDigits } from "./score";

const receipt = {
  totalMinor: 8714n,
  currency: "RON",
  occurredOn: "2026-11-02",
  merchantName: "KAUFLAND ROMANIA SCS",
  merchantTaxId: "RO15991149",
};
const tx = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  amountMinor: 8714n,
  currency: "RON",
  occurredOn: "2026-11-03",
  description: "Plata la POS · EPOS 02/11/2026 KAUFLAND RO valoare",
  merchant: null,
  ...over,
});

/** Potrivirea bon ↔ tranzacție (ADR 0019): reguli în întregi, deterministe. */
describe("scorul potrivirii", () => {
  it("suma exactă + ±1 zi + numele comerciantului → probabil, cu motive", () => {
    expect(scoreMatch(receipt, tx())).toEqual({
      score: 30 + 22 + 20,
      reasons: ["amount_exact", "date_diff_1", "merchant_partial"],
    });
    expect(
      scoreMatch(receipt, tx({ occurredOn: "2026-11-02", description: "CUI 15991149 plata" })),
    ).toEqual({ score: 100, reasons: ["amount_exact", "date_same_day", "merchant_tax_id"] });
  });

  it("negativ: suma diferită cu un ban, altă monedă, la 4 zile → nu e candidat", () => {
    expect(scoreMatch(receipt, tx({ amountMinor: 8713n }))).toBeNull();
    expect(scoreMatch(receipt, tx({ currency: "EUR" }))).toBeNull();
    expect(scoreMatch(receipt, tx({ occurredOn: "2026-11-06" }))).toBeNull();
    expect(scoreMatch(receipt, tx({ occurredOn: "2026-10-29" }))).toBeNull();
    expect(scoreMatch({ ...receipt, totalMinor: 0n }, tx({ amountMinor: 0n }))).toBeNull();
  });

  it("comerciant necunoscut: candidat, dar cu scor mic și motivul vizibil", () => {
    const s = scoreMatch({ ...receipt, merchantName: null, merchantTaxId: null }, tx());
    expect(s).toEqual({ score: 52, reasons: ["amount_exact", "date_diff_1", "merchant_unknown"] });
  });

  it("CUI-ul se potrivește doar ca număr întreg (nu ca fragment al altui număr)", () => {
    expect(scoreMatch(receipt, tx({ description: "REF 9159911490" }))!.reasons).not.toContain(
      "merchant_tax_id",
    );
    expect(taxDigits("RO12")).toBeNull();
    expect(taxDigits("RO 1234567")).toBe("1234567");
  });

  it("ambiguu: doi candidați cu scor apropiat; ordinea e deterministă", () => {
    const { ranked, ambiguous } = rankCandidates(receipt, [
      tx({ id: "b", occurredOn: "2026-11-02" }),
      tx({ id: "a", occurredOn: "2026-11-02" }),
      tx({ id: "c", occurredOn: "2026-11-05" }),
    ]);
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "b", "c"]);
    expect(ambiguous).toBe(true);
    const single = rankCandidates(receipt, [
      tx({ id: "a", occurredOn: "2026-11-02", description: "15991149" }),
      tx({ id: "b", occurredOn: "2026-11-05", description: "altceva" }),
    ]);
    expect(single.ambiguous).toBe(false);
  });

  it("ajutoare: zile între date, cuvinte semnificative fără forme juridice", () => {
    expect(dayDistance("2026-03-01", "2026-02-27")).toBe(2);
    expect(merchantTokens("S.C. Exemplu Soft S.R.L.")).toEqual(["exemplu", "soft"]);
  });
});
