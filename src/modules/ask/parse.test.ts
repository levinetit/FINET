import { describe, expect, it } from "vitest";

import { type AskContext, normalizeText, parseQuestion } from "./parse";
import { askQuerySchema } from "./query";

const C = {
  food: "11111111-1111-4111-8111-111111111111",
  transport: "22222222-2222-4222-8222-222222222222",
  health: "33333333-3333-4333-8333-333333333333",
  eating: "44444444-4444-4444-8444-444444444444",
};

const ctx: AskContext = {
  today: "2026-10-28", // miercuri
  categories: [
    { id: C.food, name: "Alimente", parentId: null },
    { id: C.transport, name: "Transport", parentId: null },
    { id: C.health, name: "Sănătate", parentId: null },
    { id: C.eating, name: "Restaurante și cafenele", parentId: null },
  ],
  merchants: ["Lidl", "Kaufland", "Mega Image", "Piața Ștefan"],
};

function ok(question: string) {
  const r = parseQuestion(question, ctx);
  expect(r.ok, question).toBe(true);
  if (!r.ok) throw new Error("unreachable");
  // Fiecare rezultat respectă schema strictă din setul închis.
  expect(askQuerySchema.safeParse(r.query).success, JSON.stringify(r.query)).toBe(true);
  return r;
}

describe("normalizeText", () => {
  it("fără diacritice, sedile sau punctuație; spații simple", () => {
    expect(normalizeText("  Cât am CHELTUIT, în Sănătate?! ș ş ț ţ ă â î ")).toBe(
      "cat am cheltuit in sanatate s s t t a a i",
    );
  });
});

describe("parseQuestion: perioade", () => {
  it("luna trecută, luna aceasta, anul acesta, anul trecut", () => {
    expect(ok("Cât am cheltuit luna trecută?").query.period).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(ok("cât am cheltuit luna aceasta").query.period).toEqual({
      from: "2026-10-01",
      to: "2026-10-28",
    });
    expect(ok("cheltuieli anul acesta").query.period).toEqual({
      from: "2026-01-01",
      to: "2026-10-28",
    });
    expect(ok("cheltuieli anul trecut").query.period).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("luni pe nume: anul curent dacă a trecut, altfel anul trecut; an explicit", () => {
    expect(ok("cât am cheltuit în martie").query.period).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(ok("cât am cheltuit în noiembrie").query.period).toEqual({
      from: "2025-11-01",
      to: "2025-11-30",
    });
    expect(ok("cât am cheltuit în ianuarie 2025").query.period).toEqual({
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(ok("cheltuieli octombrie").query.period).toEqual({
      from: "2026-10-01",
      to: "2026-10-28",
    });
    expect(ok("cheltuieli februarie 2024").query.period.from).toBe("2024-02-01");
  });

  it("„mai” luna vs. „mai” cuvânt", () => {
    expect(ok("cât am cheltuit în mai").query.period).toEqual({
      from: "2026-05-01",
      to: "2026-05-31",
    });
    expect(ok("cât am cheltuit în luna mai 2025").query.period.from).toBe("2025-05-01");
    const r = ok("pe ce am cheltuit cel mai mult");
    expect(r.query.metric).toBe("top_categories");
    expect(r.notes).toEqual(["Perioada nu a fost menționată: am folosit luna curentă."]);
    expect(r.query.period.from).toBe("2026-10-01");
  });

  it("ultimele N luni / zile, azi, ieri, săptămâni", () => {
    expect(ok("top categorii ultimele 3 luni").query.period).toEqual({
      from: "2026-08-01",
      to: "2026-10-28",
    });
    expect(ok("cheltuieli în ultimele 30 de zile").query.period).toEqual({
      from: "2026-09-29",
      to: "2026-10-28",
    });
    expect(ok("cât am cheltuit azi").query.period).toEqual({
      from: "2026-10-28",
      to: "2026-10-28",
    });
    expect(ok("cât am cheltuit ieri").query.period).toEqual({
      from: "2026-10-27",
      to: "2026-10-27",
    });
    expect(ok("cheltuieli săptămâna aceasta").query.period).toEqual({
      from: "2026-10-26",
      to: "2026-10-28",
    });
    expect(ok("cheltuieli săptămâna trecută").query.period).toEqual({
      from: "2026-10-19",
      to: "2026-10-25",
    });
  });

  it("o perioadă numită dar neînțeleasă nu se ghicește", () => {
    const r = parseQuestion("cât am cheltuit în luna foo", ctx);
    expect(r).toEqual({ ok: false, reason: "period" });
    expect(parseQuestion("cheltuieli ultimele 99 luni", ctx)).toEqual({
      ok: false,
      reason: "period",
    });
  });
});

describe("parseQuestion: metrici și filtre", () => {
  it("cheltuieli cu categorie și comerciant, ignorând diacriticele", () => {
    const r = ok("Cât am cheltuit pe alimente luna trecută?");
    expect(r.query).toMatchObject({ metric: "expense_total", categoryId: C.food });
    expect(ok("cât am cheltuit la sănătate").query.categoryId).toBe(C.health);
    expect(ok("cât am cheltuit la restaurante și cafenele în martie").query.categoryId).toBe(
      C.eating,
    );
    const lidl = ok("cât am cheltuit la Lidl luna trecută");
    expect(lidl.query.merchant).toBe("Lidl");
    expect(ok("cât am cheltuit la mega image").query.merchant).toBe("Mega Image");
    expect(ok("cât am cheltuit la piața ștefan").query.merchant).toBe("Piața Ștefan");
  });

  it("venituri (fără filtru de comerciant), clasamente (fără filtre)", () => {
    expect(ok("cât am încasat luna aceasta").query.metric).toBe("income_total");
    expect(ok("venituri la lidl").query.merchant).toBeUndefined();
    const merchants = ok("unde am cheltuit cel mai mult anul trecut");
    expect(merchants.query.metric).toBe("top_merchants");
    expect(merchants.query.categoryId).toBeUndefined();
    const withFilter = ok("top categorii la alimente");
    expect(withFilter.query.categoryId).toBeUndefined();
    expect(withFilter.query.merchant).toBeUndefined();
  });

  it("întrebările neînțelese primesc un motiv fix", () => {
    expect(parseQuestion("salut, ce faci?", ctx)).toEqual({ ok: false, reason: "metric" });
    expect(parseQuestion("  ", ctx)).toEqual({ ok: false, reason: "empty" });
    expect(parseQuestion("?!", ctx)).toEqual({ ok: false, reason: "empty" });
  });

  it("text ostil: nu ajunge nicăieri, interogarea rămâne din setul închis", () => {
    const r = ok("cât am cheltuit '; drop table finet.transactions; -- luna trecută");
    expect(Object.keys(r.query).sort()).toEqual(["metric", "period"]);
    const x = ok("cât am cheltuit la <script>alert(1)</script> Lidl");
    expect(x.query.merchant).toBe("Lidl");
  });
});
