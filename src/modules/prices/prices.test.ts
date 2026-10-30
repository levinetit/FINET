import { describe, expect, it } from "vitest";

import { normalizeProductName } from "@/modules/receipts/normalize";

import {
  type PriceLine,
  type PriceObs,
  buildSeries,
  cheapestMerchant,
  summarizeProducts,
  toObservations,
  weightedPrice,
} from "./prices";

/** O linie sintetică: nume brut, cantitate, total (bani), data, comerciant (CUI). */
const line = (
  name: string,
  quantity: string | null,
  totalMinor: number,
  occurredOn: string,
  merchantKey: string | null = "22891860",
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

const obs = (lines: PriceLine[]): PriceObs[] => toObservations(lines).obs;

describe("observații de preț din liniile bonurilor", () => {
  it("exclude liniile ambigue sau fără sumă pozitivă și le numără", () => {
    const r = toObservations([
      line("LAPTE 1L", "1", 749, "2026-09-01"),
      line("APA 2L 6 BUC", "1", 500, "2026-09-01"),
      line("BANANE 1,234 KG", "1.234", 900, "2026-09-01"),
      line("PAINE", "1", 0, "2026-09-01"),
    ]);
    expect(r.obs).toHaveLength(1);
    expect(r.excluded).toBe(3);
  });
  it("ambalaje diferite ale aceluiași produs ajung în aceeași cheie, pe kg", () => {
    const o = obs([
      line("CAFEA MACINATA 250G", "1", 1500, "2026-09-01"), // 60,00 lei/kg
      line("CAFEA MACINATA 500G", "1", 2999, "2026-09-02"), // 59,98 lei/kg
    ]);
    expect(new Set(o.map((x) => x.productKey))).toEqual(new Set(["kg|cafea macinata"]));
    // (1500 + 2999) bani / 0,75 kg = 59,99 lei/kg
    expect(weightedPrice(o)).toBe(5999n);
  });
});

describe("rezumatul pe produs și pragul de date", () => {
  const milk = [
    line("LAPTE 1L", "2", 1498, "2026-08-10"), // 7,49
    line("LAPTE 1L", "1", 799, "2026-09-12"), // 7,99
    line("LAPTE 1L", "1", 849, "2026-10-03"), // 8,49
  ];
  it("sub prag: fără niciun preț (nu sunt suficiente date)", () => {
    const s = summarizeProducts(obs(milk.slice(0, 2)));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      enough: false,
      priceMinor: null,
      observations: 2,
      cheapest: null,
    });
    expect(s[0]!.merchants).toEqual([]);
    // O singură lună nu ajunge, oricâte linii ar fi.
    const oneMonth = summarizeProducts(
      obs([1, 2, 3, 4].map((d) => line("LAPTE 1L", "1", 749, `2026-09-0${d}`))),
    );
    expect(oneMonth[0]).toMatchObject({ enough: false, months: 1, observations: 4 });
  });
  it("prag configurabil", () => {
    const s = summarizeProducts(obs(milk.slice(0, 2)), { minObservations: 2, minMonths: 2 });
    expect(s[0]).toMatchObject({ enough: true });
    // (1498 + 799) bani / 3 l = 765,67 → 766
    expect(s[0]!.priceMinor).toBe(766n);
  });
  it("peste prag: media ponderată cu cantitatea, pe unitatea standard", () => {
    const s = summarizeProducts(obs(milk));
    expect(s[0]).toMatchObject({ enough: true, unit: "l", name: "lapte", months: 3 });
    // (1498 + 799 + 849) / 4 l = 786,5 bani/l → 787 (jumătate în sus)
    expect(s[0]!.priceMinor).toBe(787n);
  });
  it("monedele nu se amestecă: un rezumat pe (produs, monedă)", () => {
    const both = [
      ...milk,
      ...milk.map((l) => ({ ...l, currency: "EUR" as const, lineTotalMinor: 150n })),
    ];
    const s = summarizeProducts(obs(both));
    expect(s.map((x) => x.currency).sort()).toEqual(["EUR", "RON"]);
    // 3 × 150 bani / 4 l = 112,5 → 113
    expect(s.find((x) => x.currency === "EUR")!.priceMinor).toBe(113n);
  });
});

describe("cel mai ieftin comerciant", () => {
  const cui = { a: "1111111", b: "2222222", c: "3333333" };
  const lines = [
    // A: de obicei (4 observații), 8,00 lei/l
    ...["2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"].map((d) =>
      line("LAPTE 1L", "1", 800, d, cui.a),
    ),
    // B: mai ieftin (2 observații), 7,00 lei/l
    line("LAPTE 1L", "1", 700, "2026-09-05", cui.b),
    line("LAPTE 1L", "1", 700, "2026-10-05", cui.b),
    // C: o singură observație, 5,00 (nu intră în comparație)
    line("LAPTE 1L", "1", 500, "2026-10-06", cui.c),
    // fără comerciant: în serie, nu în comparație
    line("LAPTE 1L", "1", 100, "2026-10-07", null),
  ];
  it("doar comercianți cu destule observații; diferența față de comerciantul uzual", () => {
    const s = summarizeProducts(obs(lines))[0]!;
    expect(s.cheapest).not.toBeNull();
    expect(s.cheapest!.cheapest.merchantKey).toBe(cui.b);
    expect(s.cheapest!.mostUsed.merchantKey).toBe(cui.a);
    expect(s.cheapest!.diffMinor).toBe(100n);
    expect(s.cheapest!.diffBps).toBe(1250n); // 12,50 %
    expect(s.merchants.map((m) => m.merchantKey)).toEqual([cui.c, cui.b, cui.a]);
  });
  it("un singur comerciant eligibil → fără comparație", () => {
    const only = obs(lines.filter((l) => l.merchantKey === cui.a));
    expect(summarizeProducts(only)[0]!.cheapest).toBeNull();
    expect(cheapestMerchant([])).toBeNull();
  });
});

describe("evoluția în timp", () => {
  const lines = [
    line("COLA 2L", "1", 900, "2026-08-03"),
    line("COLA 2L", "1", 1000, "2026-08-24"),
    line("COLA 2L", "1", 1100, "2026-09-14"),
    line("COLA 2L", "1", 1200, "2026-09-21"),
  ];
  it("serie lunară cu media ponderată pe lună", () => {
    const s = buildSeries(obs(lines), "l|cola", "RON", "month")!;
    expect(s.enough).toBe(true);
    expect(s.overall).toEqual([
      { bucket: "2026-08", priceMinor: 475n, observations: 2 },
      { bucket: "2026-09", priceMinor: 575n, observations: 2 },
    ]);
  });
  it("serie săptămânală (săptămâna începe luni)", () => {
    const s = buildSeries(obs(lines), "l|cola", "RON", "week")!;
    expect(s.overall.map((p) => p.bucket)).toEqual([
      "2026-08-03",
      "2026-08-24",
      "2026-09-14",
      "2026-09-21",
    ]);
  });
  it("sub prag: serii goale; produs necunoscut: null", () => {
    expect(buildSeries(obs(lines.slice(0, 2)), "l|cola", "RON", "month")).toMatchObject({
      enough: false,
      overall: [],
      byMerchant: [],
    });
    expect(buildSeries(obs(lines), "l|inexistent", "RON", "month")).toBeNull();
    expect(buildSeries(obs(lines), "l|cola", "EUR", "month")).toBeNull();
  });
});
