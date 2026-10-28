import { describe, expect, it } from "vitest";

import { TRANSACTION_QUERY } from "@/app/api/v1/_lib/ledger-handlers";

import { apiSearch, appendUnique, hasActiveFilters, parseFilters } from "./transaction-filters";

const ACC = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";

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
});
