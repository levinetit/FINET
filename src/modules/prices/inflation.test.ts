import { describe, expect, it } from "vitest";

import { normalizeProductName } from "@/modules/receipts/normalize";

import { computeInflation, weightedChangeBps } from "./inflation";
import { type PriceLine, toObservations } from "./prices";

const line = (
  name: string,
  totalMinor: number,
  occurredOn: string,
  merchantKey: string | null = "1111111",
  quantity = "1",
  currency: "RON" | "EUR" = "RON",
): PriceLine => ({
  normalizedName: normalizeProductName(name)!,
  quantity,
  lineTotalMinor: BigInt(totalMinor),
  occurredOn,
  currency,
  merchantKey,
  merchantName: merchantKey === null ? null : `Magazin ${merchantKey}`,
});
const obs = (lines: PriceLine[]) => toObservations(lines).obs;

/** Două observații pe perioadă la prețuri egale (suma = ponderea din perioada de bază). */
const both = (name: string, base: number, current: number, merchant = "1111111") => ({
  base: [line(name, base, "2025-09-05", merchant), line(name, base, "2025-09-20", merchant)],
  current: [
    line(name, current, "2026-09-05", merchant),
    line(name, current, "2026-09-20", merchant),
  ],
});

describe("inflația personală", () => {
  it("exemplu numeric: media ponderată cu cheltuiala din perioada de bază", () => {
    // A: +10 % cu 100 lei cheltuiți în baza de comparație; B: 0 % cu 50 lei; C: -5 % cu 40 lei.
    const items = [
      { basePriceMinor: 1000n, currentPriceMinor: 1100n, baseSpendMinor: 10000n }, // +10 %, 100 lei
      { basePriceMinor: 500n, currentPriceMinor: 500n, baseSpendMinor: 5000n }, // 0 %, 50 lei
      { basePriceMinor: 2000n, currentPriceMinor: 1900n, baseSpendMinor: 4000n }, // -5 %, 40 lei
    ];
    // (100·1,10 + 50·1,00 + 40·0,95) / 190 − 1 = 198 / 190 − 1 = 4,2105 % → 421 pb
    expect(weightedChangeBps(items)).toBe(421n);
    expect(weightedChangeBps([])).toBeNull();
    // rotunjire jumătate dinspre zero pe valori negative
    expect(
      weightedChangeBps([{ basePriceMinor: 1000n, currentPriceMinor: 900n, baseSpendMinor: 1n }]),
    ).toBe(-1000n);
  });

  it("agregat gospodărie și pe comerciant; doar articolele cumpărate în ambele perioade", () => {
    const a = both("LAPTE 1L", 1000, 1100);
    const b = both("PAINE 500G", 500, 500);
    const c = both("ZAHAR 1KG", 2000, 1900);
    const d = both("ULEI 1L", 1500, 1650);
    const e = both("OREZ 1KG", 800, 880);
    // Cumpărat doar în perioada de bază: nu intră.
    const onlyBase = [
      line("CAFEA 250G", 1200, "2025-09-10"),
      line("CAFEA 250G", 1200, "2025-09-11"),
    ];
    // Cumpărat doar o dată în perioada curentă: sub pragul de observații, nu intră.
    const thin = {
      base: [line("MIERE 500G", 2000, "2025-09-10"), line("MIERE 500G", 2000, "2025-09-12")],
      current: [line("MIERE 500G", 2500, "2026-09-10")],
    };
    const r = computeInflation(
      obs([...a.base, ...b.base, ...c.base, ...d.base, ...e.base, ...onlyBase, ...thin.base]),
      obs([...a.current, ...b.current, ...c.current, ...d.current, ...e.current, ...thin.current]),
    );
    expect(r).toHaveLength(1);
    const ron = r[0]!;
    expect(ron.status).toBe("ok");
    expect(ron.itemsUsed).toBe(5);
    // Bază: A 20,00 · B 10,00 · C 40,00 · D 30,00 · E 16,00 → 116 lei; I = (20·1,10 + 10·1 + 40·0,95 + 30·1,10 + 16·1,10)/116 − 1
    // = (22 + 10 + 38 + 33 + 17,6) / 116 − 1 = 120,6 / 116 − 1 = 3,9655 % → 397 pb
    expect(ron.changeBps).toBe(397n);
    expect(ron.byMerchant).toHaveLength(1);
    expect(ron.byMerchant[0]).toMatchObject({ merchantKey: "1111111", items: 5, changeBps: 397n });
    // Acoperire: 116 lei din (116 + 24 cafea + 40 miere) = 180 lei → 64,44 % → 6444 pb
    expect(ron.coverageBps).toBe(6444n);
    // Cea mai mare variație absolută prima (+10 %), nepotrivirile lipsesc.
    expect(ron.items[0]!.changeBps).toBe(1000n);
    expect(ron.items.map((i) => i.name)).not.toContain("cafea");
    expect(ron.items.map((i) => i.name)).not.toContain("miere");
  });

  it("sub pragul de articole: fără variație și fără listă", () => {
    const a = both("LAPTE 1L", 1000, 1100);
    const r = computeInflation(obs(a.base), obs(a.current));
    expect(r[0]).toMatchObject({ status: "insufficient", itemsUsed: 1, changeBps: null });
    expect(r[0]!.items).toEqual([]);
    expect(r[0]!.byMerchant).toEqual([]);
    // Prag configurabil
    const r2 = computeInflation(obs(a.base), obs(a.current), {
      minObsPerPeriod: 2,
      minItems: 1,
      minMerchantItems: 1,
    });
    expect(r2[0]).toMatchObject({ status: "ok", changeBps: 1000n });
  });

  it("același produs la comercianți diferiți = articole diferite; fără comerciant nu intră; monedele separate", () => {
    const a1 = both("LAPTE 1L", 1000, 1100, "1111111");
    const a2 = both("LAPTE 1L", 1000, 900, "2222222");
    const noMerchant = [
      line("LAPTE 1L", 5000, "2025-09-05", null),
      line("LAPTE 1L", 5000, "2025-09-06", null),
    ];
    const eur = both("LAPTE 1L", 100, 200, "1111111");
    const eurBase = eur.base.map((l) => ({ ...l, currency: "EUR" as const }));
    const eurCur = eur.current.map((l) => ({ ...l, currency: "EUR" as const }));
    const thresholds = { minObsPerPeriod: 2, minItems: 1, minMerchantItems: 1 };
    const r = computeInflation(
      obs([...a1.base, ...a2.base, ...noMerchant, ...eurBase]),
      obs([...a1.current, ...a2.current, ...eurCur]),
      thresholds,
    );
    expect(r.map((x) => x.currency)).toEqual(["EUR", "RON"]);
    const ron = r.find((x) => x.currency === "RON")!;
    expect(ron.itemsUsed).toBe(2);
    expect(ron.byMerchant.map((m) => [m.merchantKey, m.changeBps])).toEqual([
      ["1111111", 1000n],
      ["2222222", -1000n],
    ]);
    expect(ron.changeBps).toBe(0n);
    expect(r.find((x) => x.currency === "EUR")!.changeBps).toBe(10000n);
  });

  it("ambalajele diferite ale aceluiași produs se compară pe unitate standard", () => {
    // Baza: 500 g la 10,00 (20,00 lei/kg); curent: 1 kg la 22,00 (22,00 lei/kg) → +10 %
    const base = [line("OREZ 500G", 1000, "2025-09-05"), line("OREZ 500G", 1000, "2025-09-06")];
    const current = [line("OREZ 1KG", 2200, "2026-09-05"), line("OREZ 1KG", 2200, "2026-09-06")];
    const r = computeInflation(obs(base), obs(current), {
      minObsPerPeriod: 2,
      minItems: 1,
      minMerchantItems: 1,
    });
    expect(r[0]!.changeBps).toBe(1000n);
    expect(r[0]!.items[0]).toMatchObject({
      unit: "kg",
      basePriceMinor: 2000n,
      currentPriceMinor: 2200n,
    });
  });
});
