import { describe, expect, it } from "vitest";

import { TRANSACTION_FILTER_QUERY, TRANSACTION_QUERY } from "@/app/api/v1/_lib/ledger-handlers";

import {
  MAX_FILTER_TAGS,
  apiSearch,
  appendUnique,
  exportSearch,
  hasActiveFilters,
  parseFilters,
  parseTagIds,
} from "./transaction-filters";

const ACC = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";
const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("filtrele tranzacțiilor → interogarea API", () => {
  it("parametrii goi dispar; sumele devin întregi în bani", () => {
    const f = parseFilters({
      q: "  pâine ",
      accountId: ACC.toUpperCase(),
      categoryId: "",
      type: "expense",
      dateFrom: "2026-10-01",
      dateTo: "",
      amountMin: "10,50",
      amountMax: "1.234,00",
      sort: "amount_desc",
    });
    expect(f.errors).toEqual({});
    expect(f.query).toEqual({
      q: "pâine",
      accountId: ACC,
      type: "expense",
      dateFrom: "2026-10-01",
      amountMinMinor: 1050,
      amountMaxMinor: 123400,
      sort: "amount_desc",
    });
  });

  it("valorile invalide se ignoră; sumele ambigue apar ca eroare", () => {
    const f = parseFilters({
      accountId: "nu-e-id",
      type: "altceva",
      dateFrom: "ieri",
      sort: "x",
      amountMin: "1.234",
      extra: "ignorat",
    });
    expect(f.query).toEqual({});
    expect(Object.keys(f.errors)).toEqual(["amountMin"]);
  });

  it("parametrii repetați: doar primul", () => {
    expect(parseFilters({ type: ["income", "expense"] }).query).toEqual({ type: "income" });
  });

  it("șirul API conține doar parametri acceptați de ruta /api/v1/transactions", () => {
    const f = parseFilters({ q: "x", amountMin: "5", accountId: ACC, sort: "date_asc" });
    const search = apiSearch(f.query, "abc_-123");
    const params = new URLSearchParams(search.slice(1));
    for (const key of params.keys()) expect(Object.keys(TRANSACTION_QUERY)).toContain(key);
    expect(params.get("amountMinMinor")).toBe("500");
    expect(params.get("cursor")).toBe("abc_-123");
    expect(apiSearch({})).toBe("");
  });

  it("„Încarcă mai mult” nu dublează rândurile", () => {
    const a = [{ id: "1" }, { id: "2" }];
    expect(appendUnique(a, [{ id: "2" }, { id: "3" }]).map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("sortarea singură nu e un filtru activ", () => {
    expect(hasActiveFilters({ sort: "date_asc" })).toBe(false);
    expect(hasActiveFilters({ q: "x" })).toBe(true);
  });

  it("etichetele: parametrul repetat al formularului devine un singur `tagIds` cu virgule", () => {
    const f = parseFilters({ tagIds: [T1, T2.toUpperCase(), "nu-e-id", T1] });
    expect(f.values.tagIds).toEqual([T1, T2]);
    expect(f.query.tagIds).toEqual([T1, T2]);
    const params = new URLSearchParams(apiSearch(f.query).slice(1));
    expect(params.getAll("tagIds")).toEqual([`${T1},${T2}`]);
    // Forma API-ului (virgule) e acceptată și în adresa paginii.
    expect(parseFilters({ tagIds: `${T1},${T2}` }).query.tagIds).toEqual([T1, T2]);
  });

  it("etichetele: cel mult zece, fără valori goale", () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    expect(parseTagIds(many)).toHaveLength(MAX_FILTER_TAGS);
    expect(parseTagIds("")).toEqual([]);
    expect(parseTagIds(undefined)).toEqual([]);
    expect(parseFilters({ tagIds: "" }).query).toEqual({});
  });

  it("etichetele „toate”: `tagMatch=all` doar cu etichete bifate, `any` e implicit", () => {
    const all = parseFilters({ tagIds: [T1, T2], tagMatch: "all" });
    expect(all.values.tagMatch).toBe("all");
    expect(all.query.tagMatch).toBe("all");
    expect(new URLSearchParams(apiSearch(all.query).slice(1)).get("tagMatch")).toBe("all");
    expect(exportSearch(all.query).tagMatch).toBe("all");
    // Fără etichete, `tagMatch` nu pleacă spre API (care l-ar refuza cu 400).
    expect(parseFilters({ tagMatch: "all" }).query).toEqual({});
    // `any` și valorile necunoscute nu se trimit (implicitul API-ului).
    expect(parseFilters({ tagIds: T1, tagMatch: "any" }).query).toEqual({ tagIds: [T1] });
    expect(parseFilters({ tagIds: T1, tagMatch: "x" }).query).toEqual({ tagIds: [T1] });
    expect(Object.keys(TRANSACTION_FILTER_QUERY)).toContain("tagMatch");
  });

  it("comerciantul e un filtru separat de căutare", () => {
    const f = parseFilters({ merchant: "  Mega Image ", q: "" });
    expect(f.query).toEqual({ merchant: "Mega Image" });
    expect(new URLSearchParams(apiSearch(f.query).slice(1)).get("merchant")).toBe("Mega Image");
    expect(hasActiveFilters(f.query)).toBe(true);
  });

  it("exportul: aceleași filtre, fără `sort`/`cursor`/`limit`, doar parametri ai rutei de export", () => {
    const f = parseFilters({
      q: "x",
      merchant: "Lidl",
      tagIds: [T1, T2],
      accountId: ACC,
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
      amountMin: "5",
      sort: "amount_desc",
    });
    const search = exportSearch(f.query);
    expect(search.sort).toBeUndefined();
    expect(search.tagIds).toBe(`${T1},${T2}`);
    expect(search.amountMinMinor).toBe("500");
    for (const key of Object.keys(search)) {
      expect(Object.keys(TRANSACTION_FILTER_QUERY)).toContain(key);
    }
  });
});
