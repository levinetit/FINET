import { describe, expect, it } from "vitest";

import { askLlmMessages, buildAskRequest, resolveAskLlm } from "./ask-llm";
import type { AskContext } from "./parse";
import { resolvePeriod } from "./period";

const ctx: AskContext = {
  today: "2026-10-28",
  categories: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Alimente", parentId: null },
    { id: "22222222-2222-4222-8222-222222222222", name: "Sănătate", parentId: null },
  ],
  merchants: ["Lidl", "Piața Ștefan"],
};

const ok = (over: Record<string, unknown> = {}) => ({
  understood: true,
  metric: "expense_total",
  period: { kind: "last_month" },
  category: null,
  merchant: null,
  ...over,
});

describe("buildAskRequest: ce pleacă către model", () => {
  it("doar întrebarea, data de azi și numele categoriilor (fără comercianți, id-uri sau sume)", () => {
    const req = buildAskRequest("cât am dat pe medicamente", ctx);
    expect(req).toEqual({
      today: "2026-10-28",
      question: "cât am dat pe medicamente",
      categories: ["Alimente", "Sănătate"],
    });
    const wire = JSON.stringify(askLlmMessages(req));
    expect(wire).not.toContain("Lidl");
    expect(wire).not.toContain("Piața");
    expect(wire).not.toContain("1111");
  });
});

describe("resolveAskLlm", () => {
  it("rezolvă perioada în cod și potrivește numele (egalitate după normalizare)", () => {
    const r = resolveAskLlm(
      ok({
        category: "sanatate",
        merchant: "piata stefan",
        period: { kind: "month", month: "2026-03" },
      }),
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      query: {
        metric: "expense_total",
        period: { from: "2026-03-01", to: "2026-03-31" },
        categoryId: "22222222-2222-4222-8222-222222222222",
        merchant: "Piața Ștefan",
      },
      periodLabel: "martie 2026",
      notes: [],
    });
  });

  it("aceeași perioadă ca parserul din cod (o singură implementare)", () => {
    const r = resolveAskLlm(ok({ period: { kind: "last_n_months", n: 3 } }), ctx);
    const expected = resolvePeriod({ kind: "last_n_months", n: 3 }, ctx.today)!;
    expect(r.ok && r.query.period).toEqual({ from: expected.from, to: expected.to });
    expect(r.ok && r.query.period).toEqual({ from: "2026-08-01", to: "2026-10-28" });
  });

  it("perioadă lipsă → luna curentă, spus în note; clasamentele ignoră filtrele (cu notă)", () => {
    const a = resolveAskLlm(ok({ period: null }), ctx);
    expect(a).toMatchObject({ ok: true, periodLabel: "luna curentă" });
    expect(a.ok && a.notes).toEqual(["Perioada nu a fost menționată: am folosit luna curentă."]);
    const t = resolveAskLlm(ok({ metric: "top_categories", category: "Alimente" }), ctx);
    expect(t.ok && t.query.categoryId).toBeUndefined();
    expect(t.ok && t.notes).toEqual([
      "Clasamentele nu au filtre: am ignorat categoria și comerciantul.",
    ]);
  });

  it("refuză, nu ghicește: nume necunoscut, perioadă în viitor, întrebare neînțeleasă", () => {
    expect(resolveAskLlm(ok({ category: "Mașini" }), ctx)).toEqual({ ok: false, reason: "name" });
    expect(resolveAskLlm(ok({ merchant: "Necunoscut SRL" }), ctx)).toEqual({
      ok: false,
      reason: "name",
    });
    expect(resolveAskLlm(ok({ period: { kind: "month", month: "2027-01" } }), ctx)).toEqual({
      ok: false,
      reason: "period",
    });
    expect(resolveAskLlm(ok({ understood: false, metric: null }), ctx)).toEqual({
      ok: false,
      reason: "metric",
    });
    expect(resolveAskLlm(ok({ metric: null }), ctx)).toEqual({ ok: false, reason: "metric" });
  });

  it("comerciant la venituri: ignorat cu notă", () => {
    const r = resolveAskLlm(ok({ metric: "income_total", merchant: "Lidl" }), ctx);
    expect(r.ok && r.query.merchant).toBeUndefined();
    expect(r.ok && r.notes[0]).toContain("doar la cheltuieli");
  });

  it("aruncă pe orice abatere de la schemă (câmpuri în plus, tipuri greșite, perioade inventate)", () => {
    for (const bad of [
      { ...ok(), extra: 1 },
      ok({ metric: "drop_table" }),
      ok({ period: { kind: "from_to", from: "2026-01-01", to: "2026-02-01" } }),
      ok({ period: { kind: "last_n_months", n: 99 } }),
      ok({ category: 5 }),
      "text",
      null,
    ]) {
      expect(() => resolveAskLlm(bad, ctx), JSON.stringify(bad)).toThrow();
    }
  });
});
