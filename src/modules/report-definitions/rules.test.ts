import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RECEIPT_LINE_KINDS, REPORT_RULE_VERSION } from "@/db/schema";
import { normalizeProductName } from "@/modules/receipts/normalize";
import { ruleKind } from "@/modules/receipts/categorize";

import {
  LINE_KINDS,
  MAX_TERMS,
  RULE_VERSION,
  type ReportRules,
  matchesName,
  reportRulesSchema,
  termMatches,
  tokensOf,
} from "./rules";
import { SYSTEM_REPORTS } from "./system-definitions";

const rules = (over: Partial<ReportRules>): ReportRules => ({
  v: 1,
  combine: "any",
  include: [],
  exclude: [],
  kinds: ["product"],
  categoryIds: [],
  tagIds: [],
  ...over,
});
const n = (s: string) => normalizeProductName(s)!;

describe("constantele oglindite", () => {
  it("coincid cu schema bazei", () => {
    expect([...LINE_KINDS]).toEqual([...RECEIPT_LINE_KINDS]);
    expect(RULE_VERSION).toBe(REPORT_RULE_VERSION);
  });
});

describe("termeni: exact / prefix / contains / token", () => {
  it("potrivirile de bază", () => {
    expect(termMatches({ type: "exact", value: "punga rafie" }, "punga rafie")).toBe(true);
    expect(termMatches({ type: "exact", value: "punga" }, "punga rafie")).toBe(false);
    expect(termMatches({ type: "prefix", value: "pung" }, "punga rafie")).toBe(true);
    expect(termMatches({ type: "prefix", value: "rafie" }, "punga rafie")).toBe(false);
    expect(termMatches({ type: "contains", value: "ga ra" }, "punga rafie")).toBe(true);
    expect(termMatches({ type: "token", value: "punga" }, "punga rafie")).toBe(true);
    // un cuvânt întreg, nu o bucată dintr-unul
    expect(termMatches({ type: "token", value: "pung" }, "punga rafie")).toBe(false);
    expect(termMatches({ type: "token", value: "rafie" }, "punga rafie")).toBe(true);
    expect(tokensOf("lapte  1.5% 1l")).toEqual(["lapte", "1.5%", "1l"]);
  });
  it("include ȘI / SAU, exclude SAU plat, listă goală = orice nume", () => {
    const all = rules({
      combine: "all",
      include: [
        { type: "token", value: "lapte" },
        { type: "contains", value: "1l" },
      ],
    });
    expect(matchesName(all, "lapte zuzu 1l")).toBe(true);
    expect(matchesName(all, "lapte zuzu 2l")).toBe(false);
    const any = rules({ ...all, combine: "any" });
    expect(matchesName(any, "lapte zuzu 2l")).toBe(true);
    expect(matchesName(any, "paine 1l")).toBe(true);
    expect(matchesName(any, "paine 500g")).toBe(false);
    const ex = rules({
      include: [{ type: "token", value: "lapte" }],
      exclude: [
        { type: "token", value: "praf" },
        { type: "contains", value: "soia" },
      ],
    });
    expect(matchesName(ex, "lapte praf")).toBe(false);
    expect(matchesName(ex, "lapte de soia")).toBe(false);
    expect(matchesName(ex, "lapte zuzu")).toBe(true);
    expect(matchesName(rules({}), "orice")).toBe(true);
  });
});

describe("validare strictă (Zod)", () => {
  const ok = {
    v: 1,
    combine: "any",
    include: [{ type: "token", value: "Pungă" }],
    exclude: [],
    kinds: ["bag"],
    categoryIds: [],
    tagIds: [],
  };
  it("normalizează valorile (diacritice, litere mari) și acceptă forma corectă", () => {
    const parsed = reportRulesSchema.parse(ok);
    expect(parsed.include[0]).toEqual({ type: "token", value: "punga" });
  });
  it("respinge chei necunoscute, versiuni, tipuri și valori nepermise", () => {
    expect(reportRulesSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, v: 2 }).success).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, combine: "xor" }).success).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, kinds: [] }).success).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, kinds: ["bag", "bag"] }).success).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, kinds: ["necunoscut"] }).success).toBe(false);
    for (const bad of [
      { type: "regex", value: "punga" },
      { type: "token", value: "a" }, // prea scurt
      { type: "token", value: "doua cuvinte" }, // un token nu are spații
      { type: "contains", value: "" },
      { type: "contains", value: "x".repeat(200) },
      { type: "contains", value: "!!!" }, // doar punctuație → gol după normalizare
      { type: "token", value: "punga", extra: true },
    ]) {
      expect(
        reportRulesSchema.safeParse({ ...ok, include: [bad] }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
  it("limite: număr de termeni, termeni repetați, id-uri", () => {
    const terms = Array.from({ length: MAX_TERMS + 1 }, (_, i) => ({
      type: "token",
      value: `termen${i}`,
    }));
    expect(reportRulesSchema.safeParse({ ...ok, include: terms }).success).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, include: terms.slice(0, MAX_TERMS) }).success).toBe(
      true,
    );
    expect(
      reportRulesSchema.safeParse({
        ...ok,
        include: [
          { type: "token", value: "punga" },
          { type: "token", value: "PUNGĂ" },
        ],
      }).success,
    ).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, categoryIds: ["nu-e-uuid"] }).success).toBe(false);
    const id = "00000000-0000-4000-8000-000000000001";
    expect(reportRulesSchema.safeParse({ ...ok, categoryIds: [id, id] }).success).toBe(false);
    expect(reportRulesSchema.safeParse({ ...ok, categoryIds: [id], tagIds: [id] }).success).toBe(
      true,
    );
  });
  it("niciun caracter de control SQL/regex nu supraviețuiește normalizării", () => {
    const r = reportRulesSchema.safeParse({
      ...ok,
      include: [{ type: "contains", value: "%'; drop table x; --" }],
    });
    if (r.success) {
      expect(r.data.include[0]!.value).toMatch(/^[a-z0-9.% ]+$/);
    }
  });
});

describe("rapoartele de sistem", () => {
  it("toate trec validarea strictă și au nume/id-uri unice", () => {
    expect(new Set(SYSTEM_REPORTS.map((r) => r.id)).size).toBe(SYSTEM_REPORTS.length);
    expect(new Set(SYSTEM_REPORTS.map((r) => r.name.toLowerCase())).size).toBe(
      SYSTEM_REPORTS.length,
    );
    for (const r of SYSTEM_REPORTS) {
      const parsed = reportRulesSchema.safeParse(r.rules);
      expect(parsed.success, r.key).toBe(true);
      // valorile din constantă sunt deja normalizate (migrația le copiază ca atare)
      expect(parsed.success && parsed.data, r.key).toEqual(r.rules);
      expect(r.name.length).toBeLessThanOrEqual(80);
      expect(r.advice.length).toBeLessThanOrEqual(500);
      expect(r.description.length).toBeLessThanOrEqual(500);
    }
  });

  const report = (key: string) => SYSTEM_REPORTS.find((r) => r.key === key)!.rules;
  const line = (name: string) => n(name);

  it("pungi: «PUNGA RAFIE» intră, «PUNGI MENAJ 35L» nu (deși boții îl clasifică tot ca pungă)", () => {
    const bags = report("bags");
    // clasificarea din pipeline (F6) pune ambele pe kind = bag; doar regula pe nume le separă
    expect(ruleKind(line("PUNGA RAFIE"))).toBe("bag");
    expect(ruleKind(line("PUNGI MENAJ 35L"))).toBe("bag");
    expect(matchesName(bags, line("PUNGA RAFIE"))).toBe(true);
    expect(matchesName(bags, line("SACOSA HARTIE"))).toBe(true);
    expect(matchesName(bags, line("PUNGI MENAJ 35L"))).toBe(false);
    expect(matchesName(bags, line("PUNGI GUNOI 60L"))).toBe(false);
    expect(matchesName(bags, line("LAPTE ZUZU 1,5% 1L"))).toBe(false);
  });
  it("SGR, de la casă, nealimentare, băuturi, reduceri — pe linii din fixture-urile sintetice", () => {
    const fx = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures/receipts/ground-truth.json"), "utf8"),
    ) as { receipts: { lines: { name: string; type: string }[] }[] };
    const names = fx.receipts.flatMap((r) =>
      r.lines.map((l) => ({ name: n(l.name), type: l.type })),
    );
    const kindOf = (t: string) =>
      ({
        item: "product",
        deposit: "deposit_sgr",
        discount: "discount",
        bag: "bag",
        other: "other",
      })[t]!;
    const hits = (key: string) => {
      const r = report(key);
      return names
        .filter((l) => r.kinds.includes(kindOf(l.type) as never) && matchesName(r, l.name))
        .map((l) => l.name);
    };
    expect(new Set(hits("sgr"))).toEqual(new Set(["garantie sgr"]));
    expect(hits("sgr")).toHaveLength(3); // 3 linii de garanție în fixture-uri
    expect(hits("bags")).toEqual(["punga rafie"]);
    expect(hits("savings")).toEqual(["reducere card"]);
    expect(new Set(hits("nonfood"))).toEqual(
      new Set([
        "sampon hair 400ml",
        "detergent vase 1l",
        "pasta dinti 75ml",
        "hartie igienica 10 role",
        "sapun lichid 500ml",
        "sampon 250ml",
        "servetele 100buc",
      ]),
    );
    // cafea macinată 500g = ambalaj mare: NU e «băutură la bucată»
    expect(hits("drinks")).toEqual(["apa plata 2l"]);
    expect(hits("checkout")).toEqual([]);
    expect(matchesName(report("checkout"), line("CIOCOLATA MILKA 100G"))).toBe(true);
    expect(matchesName(report("checkout"), line("GUMA ORBIT"))).toBe(true);
    expect(matchesName(report("drinks"), line("CAFEA ESPRESSO"))).toBe(true);
    expect(matchesName(report("drinks"), line("CAFEA BOABE 1KG"))).toBe(false);
    expect(matchesName(report("drinks"), line("APA DE COLONIE"))).toBe(false);
  });
  it("«economii»: nu include retururile SGR (discount cu SGR în nume)", () => {
    const savings = report("savings");
    expect(matchesName(savings, line("REDUCERE CARD"))).toBe(true);
    expect(matchesName(savings, line("LIDL PLUS CUPON"))).toBe(true);
    expect(matchesName(savings, line("RETUR SGR"))).toBe(false);
    expect(matchesName(savings, line("RETUR AMBALAJE"))).toBe(false);
  });
});
