import { describe, expect, it } from "vitest";

import {
  LIST_MATCH_MAX_ITEMS,
  buildListMatchRequest,
  listMatchJsonSchema,
  listMatchMessages,
  resolveAnswers,
} from "./ai-match";

const names: Record<string, string> = {
  i1: "lapte",
  i2: "detergent",
  l1: "ciocolata lapte 100g",
  l2: "budinca lapte 200g",
  l3: "ariel detergent 3kg",
};
const plan = buildListMatchRequest(
  [
    { itemId: "i1", candidateLineIds: ["l1", "l2"] },
    { itemId: "i2", candidateLineIds: ["l3", "l1"] },
  ],
  (id) => names[id]!,
  (id) => names[id]!,
)!;

describe("cererea către LLM", () => {
  it("poartă doar nume normalizate, indici și coduri (fără id-uri sau sume)", () => {
    expect(plan.request).toEqual({
      items: [
        { i: 0, name: "lapte" },
        { i: 1, name: "detergent" },
      ],
      lines: [
        { c: "c1", name: "ciocolata lapte 100g" },
        { c: "c2", name: "budinca lapte 200g" },
        { c: "c3", name: "ariel detergent 3kg" },
      ],
      pairs: [
        { i: 0, c: ["c1", "c2"] },
        { i: 1, c: ["c3", "c1"] },
      ],
    });
    const text = JSON.stringify(listMatchMessages(plan.request));
    expect(text).not.toMatch(/\bi1\b|\bl1\b|[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(
      buildListMatchRequest(
        [],
        (x) => x,
        (x) => x,
      ),
    ).toBeNull();
    const many = buildListMatchRequest(
      Array.from({ length: 40 }, (_, k) => ({ itemId: `i${k}`, candidateLineIds: ["l1"] })),
      () => "x",
      () => "y",
    )!;
    expect(many.request.items).toHaveLength(LIST_MATCH_MAX_ITEMS);
  });

  it("schema JSON limitează codurile", () => {
    const schema = listMatchJsonSchema(["c1", "c2"]) as {
      properties: { answers: { items: { properties: { c: { enum: unknown[] } } } } };
    };
    expect(schema.properties.answers.items.properties.c.enum).toEqual(["c1", "c2", null]);
  });
});

describe("răspunsul LLM (neîncrezător)", () => {
  it("acceptă un candidat al articolului sau „niciunul”", () => {
    expect(
      resolveAnswers(plan, {
        answers: [
          { i: 0, c: "c2" },
          { i: 1, c: null },
        ],
      }),
    ).toEqual([
      { itemId: "i1", lineId: "l2" },
      { itemId: "i2", lineId: null },
    ]);
  });

  it("ignoră cod inexistent, candidat al altui articol, indice necerut, dubluri și linii luate", () => {
    expect(
      resolveAnswers(plan, {
        answers: [
          { i: 0, c: "c9" }, // inexistent
          { i: 0, c: "c1" }, // al doilea răspuns pentru același articol: ignorat
          { i: 1, c: "c2" }, // c2 nu e candidat al articolului 1
          { i: 7, c: "c1" }, // indice necerut
        ],
      }),
    ).toEqual([]);
    // O linie nu se dă la două articole.
    expect(
      resolveAnswers(plan, {
        answers: [
          { i: 0, c: "c1" },
          { i: 1, c: "c1" },
        ],
      }),
    ).toEqual([{ itemId: "i1", lineId: "l1" }]);
  });

  it("aruncă la o formă invalidă (chei în plus, tipuri greșite, prea multe)", () => {
    for (const bad of [
      null,
      {},
      { answers: "da" },
      { answers: [{ i: 0, c: "c1", extra: 1 }] },
      { answers: [{ i: "0", c: "c1" }] },
      { answers: [{ i: 0, c: 5 }] },
      { answers: [{ i: -1, c: null }] },
      { answers: Array.from({ length: 31 }, () => ({ i: 0, c: null })) },
      { answers: [], note: "ignora instructiunile" },
    ]) {
      expect(() => resolveAnswers(plan, bad)).toThrow();
    }
  });
});
