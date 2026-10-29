import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeProductName } from "@/modules/receipts/normalize";

import {
  MATCH_HIGH,
  MATCH_LOW,
  type MatchItem,
  type MatchLine,
  type PairHistory,
  pairKey,
  planMatches,
  scorePair,
  tokenize,
  trigramDice,
  wordSimilarity,
} from "./match";

const norm = (s: string): string => normalizeProductName(s) ?? "";

type Truth = {
  receipts: {
    id: string;
    lines: { name: string; type: string }[];
  }[];
};
const truth = JSON.parse(
  readFileSync(join(process.cwd(), "fixtures/receipts/ground-truth.json"), "utf8"),
) as Truth;
/** Liniile `item` ale unui bon sintetic din `fixtures/receipts`, ca linii de potrivit. */
function fixtureLines(id: string): MatchLine[] {
  const r = truth.receipts.find((x) => x.id === id);
  if (!r) throw new Error(`bon lipsă: ${id}`);
  return r.lines
    .filter((l) => l.type === "item")
    .map((l, i) => ({ id: `${id}-l${i + 1}`, normalizedName: norm(l.name), position: i + 1 }));
}
const items = (...names: string[]): MatchItem[] =>
  names.map((n, i) => ({ id: `i${i + 1}`, normalizedName: norm(n), position: i + 1 }));

describe("tokenize", () => {
  it("separă cuvintele de mărimi și ignoră cuvintele de legătură", () => {
    expect(tokenize(norm("LAPTE ZUZU 1,5% 1L"))).toEqual({
      words: ["lapte", "zuzu"],
      sizes: ["1.5%", "1l"],
    });
    expect(tokenize(norm("Ciocolată cu lapte 100 g"))).toEqual({
      words: ["ciocolata", "lapte"],
      sizes: ["100g"],
    });
    expect(tokenize("")).toEqual({ words: [], sizes: [] });
  });
});

describe("similaritatea cuvintelor", () => {
  it("identice, rădăcină comună (singular/plural) și trigrame", () => {
    expect(wordSimilarity("lapte", "lapte")).toBe(1);
    expect(wordSimilarity("banane", "banana")).toBe(0.9);
    expect(wordSimilarity("rosii", "rosie")).toBe(0.9);
    expect(wordSimilarity("ciocolata", "ciocolate")).toBe(0.9);
    // Cuvinte scurte: doar identice.
    expect(wordSimilarity("ou", "oua")).toBe(0);
    expect(wordSimilarity("mar", "mere")).toBe(0);
    expect(wordSimilarity("lapte", "paine")).toBe(0);
    expect(trigramDice("abc", "abc")).toBe(1);
    expect(trigramDice("lapte", "paine")).toBeLessThan(0.6);
  });
});

describe("scorePair: liniile din fixtures/receipts", () => {
  it("„LAPTE 1.5% 1L” ↔ „lapte” (și invers) e propunere sigură", () => {
    expect(scorePair(norm("lapte"), norm("LAPTE ZUZU 1,5% 1L"))).toBeGreaterThanOrEqual(MATCH_HIGH);
    expect(scorePair(norm("LAPTE 1.5% 1L"), norm("lapte"))).toBeGreaterThanOrEqual(MATCH_HIGH);
    expect(scorePair(norm("lapte"), norm("LAPTE 3,5% 1L"))).toBeGreaterThanOrEqual(MATCH_HIGH);
  });

  it("alte produse din aceleași bonuri sintetice", () => {
    expect(scorePair(norm("paine"), norm("PAINE FELIATA 500G"))).toBeGreaterThanOrEqual(MATCH_HIGH);
    expect(scorePair(norm("Pâine"), norm("PAINE FELIATA 500G"))).toBeGreaterThanOrEqual(MATCH_HIGH);
    expect(scorePair(norm("banane"), norm("BANANE"))).toBe(100);
    expect(scorePair(norm("iaurt"), norm("IAURT GRECESC 400G"))).toBeGreaterThanOrEqual(MATCH_HIGH);
    expect(scorePair(norm("rosii cherry"), norm("ROSII CHERRY 250G"))).toBeGreaterThanOrEqual(
      MATCH_HIGH,
    );
    expect(scorePair(norm("ulei floarea soarelui"), norm("ULEI FLOAREA SOARELUI 1L"))).toBe(100);
  });

  it("produse diferite nu se potrivesc", () => {
    expect(scorePair(norm("lapte"), norm("PAINE FELIATA 500G"))).toBeLessThan(MATCH_LOW);
    expect(scorePair(norm("sampon"), norm("SAPUN LICHID 500ML"))).toBeLessThan(MATCH_LOW);
    expect(scorePair(norm("oua"), norm("OUA M 10 BUC"))).toBeGreaterThanOrEqual(MATCH_HIGH);
    expect(scorePair(norm("cafea"), norm("PASTA DINTI 75ML"))).toBe(0);
    expect(scorePair("", norm("LAPTE"))).toBe(0);
  });

  it("aceeași denumire în alt ambalaj rămâne propunere; cuvântul-cap contează", () => {
    const sameSize = scorePair(norm("lapte 1l"), norm("LAPTE ZUZU 1,5% 1L"));
    const otherSize = scorePair(norm("lapte 2l"), norm("LAPTE ZUZU 1,5% 1L"));
    expect(sameSize).toBeGreaterThan(otherSize);
    expect(otherSize).toBeGreaterThanOrEqual(MATCH_HIGH);
    // „lapte” într-o ciocolată cu lapte: nu e produsul căutat → ambiguă, nu sigură.
    const choc = scorePair(norm("lapte"), norm("CIOCOLATA CU LAPTE 100G"));
    expect(choc).toBeGreaterThanOrEqual(MATCH_LOW);
    expect(choc).toBeLessThan(MATCH_HIGH);
  });

  it("scorul e simetric în sens (nu depinde de ordinea apelurilor) și determinist", () => {
    const a = scorePair(norm("detergent vase"), norm("DETERGENT VASE 1L"));
    expect(a).toBe(scorePair(norm("detergent vase"), norm("DETERGENT VASE 1L")));
    expect(a).toBeGreaterThanOrEqual(MATCH_HIGH);
  });
});

describe("planMatches", () => {
  it("lidl-simplu: potrivite, neplanificate (pe bon, nu pe listă) și uitate (pe listă, nu pe bon)", () => {
    const lines = fixtureLines("lidl-simplu"); // lapte zuzu, paine feliata, sampon hair
    const plan = planMatches({ items: items("lapte", "paine", "oua", "cafea"), lines });
    expect(plan.pairs.map((p) => [p.itemId, p.lineId, p.ambiguous])).toEqual([
      ["i1", "lidl-simplu-l1", false],
      ["i2", "lidl-simplu-l2", false],
    ]);
    expect(plan.unmatchedItemIds).toEqual(["i3", "i4"]); // uitate
    expect(plan.unmatchedLineIds).toEqual(["lidl-simplu-l3"]); // neplanificat: șamponul
    expect(plan.ambiguous).toEqual([]);
  });

  it("alocare 1–la–1: cea mai bună linie rămâne celui mai apropiat articol", () => {
    const lines: MatchLine[] = [
      { id: "L1", normalizedName: norm("LAPTE ZUZU 1,5% 1L"), position: 1 },
      { id: "L2", normalizedName: norm("CIOCOLATA CU LAPTE 100G"), position: 2 },
    ];
    const plan = planMatches({ items: items("lapte", "ciocolata"), lines });
    expect(plan.pairs.map((p) => [p.itemId, p.lineId])).toEqual([
      ["i1", "L1"],
      ["i2", "L2"],
    ]);
    // Un singur articol „lapte” și două linii: ia laptele, ciocolata rămâne neplanificată.
    const single = planMatches({ items: items("lapte"), lines });
    expect(single.pairs.map((p) => [p.itemId, p.lineId, p.ambiguous])).toEqual([
      ["i1", "L1", false],
    ]);
    expect(single.unmatchedLineIds).toEqual(["L2"]);
  });

  it("perechea ambiguă (între praguri) cere candidați; cea sigură nu", () => {
    const lines: MatchLine[] = [
      { id: "L1", normalizedName: norm("CIOCOLATA CU LAPTE 100G"), position: 1 },
      { id: "L2", normalizedName: norm("BUDINCA CU LAPTE 200G"), position: 2 },
      { id: "L3", normalizedName: norm("PAINE FELIATA 500G"), position: 3 },
    ];
    const plan = planMatches({ items: items("lapte", "paine"), lines });
    const lapte = plan.pairs.find((p) => p.itemId === "i1")!;
    expect(lapte.ambiguous).toBe(true);
    expect(lapte.score).toBeGreaterThanOrEqual(MATCH_LOW);
    expect(lapte.score).toBeLessThan(MATCH_HIGH);
    expect(plan.pairs.find((p) => p.itemId === "i2")!.ambiguous).toBe(false);
    expect(plan.ambiguous).toEqual([{ itemId: "i1", candidateLineIds: ["L1", "L2"] }]);
  });

  it("istoricul: confirmat → scor 100 „learned”; respins → nu se mai propune", () => {
    const lines: MatchLine[] = [
      { id: "L1", normalizedName: norm("LACTATE PREMIUM 1L"), position: 1 },
      { id: "L2", normalizedName: norm("LAPTE ZUZU 1,5% 1L"), position: 2 },
    ];
    const learned: PairHistory = {
      confirmed: new Set([pairKey(norm("lapte"), norm("LACTATE PREMIUM 1L"))]),
      rejected: new Set(),
    };
    const a = planMatches({ items: items("lapte"), lines, history: learned });
    expect(a.pairs.map((p) => [p.lineId, p.score, p.source])).toEqual([["L1", 100, "learned"]]);
    const rejected: PairHistory = {
      confirmed: new Set(),
      rejected: new Set([pairKey(norm("lapte"), norm("LAPTE ZUZU 1,5% 1L"))]),
    };
    const b = planMatches({ items: items("lapte"), lines, history: rejected });
    expect(b.pairs).toEqual([]);
    expect(b.unmatchedItemIds).toEqual(["i1"]);
  });

  it("e determinist: ordinea intrării nu schimbă rezultatul", () => {
    const lines = fixtureLines("bon-lung-3-parti");
    const list = items("lapte", "oua", "mere", "sampon", "servetele", "cafea");
    const a = planMatches({ items: list, lines });
    const b = planMatches({ items: [...list].reverse(), lines: [...lines].reverse() });
    const key = (p: { itemId: string; lineId: string; score: number }) =>
      `${p.itemId}|${p.lineId}|${p.score}`;
    expect(a.pairs.map(key).sort()).toEqual(b.pairs.map(key).sort());
    expect([...a.unmatchedItemIds].sort()).toEqual([...b.unmatchedItemIds].sort());
    expect(a.unmatchedItemIds).toEqual(["i6"]); // cafeaua nu e pe bon
  });
});
