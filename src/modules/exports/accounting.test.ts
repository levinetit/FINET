import { describe, expect, it } from "vitest";

import { assertTable } from "@/lib/export-table";

import {
  ACCOUNTING_COLUMNS,
  type AccountingReceipt,
  accountingTable,
  receiptListTable,
  vatIncluded,
} from "./accounting";

const base: AccountingReceipt = {
  id: "11111111-1111-4111-8111-111111111111",
  occurredOn: "2026-03-05",
  number: "0123",
  merchantName: "LIDL DISCOUNT SRL",
  merchantTaxId: "RO22891860",
  currency: "RON",
  totalMinor: 14900n,
  vatTotalMinor: 1991n,
  accountName: "Card",
  categoryName: "Alimente",
  groups: [
    { rate: "19.00", grossMinor: 11900n },
    { rate: "9.00", grossMinor: 3000n },
  ],
};

const col = (key: string) => ACCOUNTING_COLUMNS.findIndex((c) => c.key === key);

describe("vatIncluded", () => {
  it("TVA inclus într-o valoare brută, rotunjit o dată", () => {
    expect(vatIncluded(11900n, 1900)).toBe(1900n);
    expect(vatIncluded(3000n, 900)).toBe(248n); // 3000×9/109 = 247,706…
    expect(vatIncluded(100n, 2100)).toBe(17n); // 17,355…
    expect(vatIncluded(0n, 1900)).toBe(0n);
    expect(vatIncluded(5000n, 0)).toBe(0n);
  });
  it("jumătățile merg în sus în valoare absolută, simetric pentru negativ", () => {
    expect(vatIncluded(3n, 10000)).toBe(2n); // 1,5 → 2
    expect(vatIncluded(-3n, 10000)).toBe(-2n);
    expect(vatIncluded(-11900n, 1900)).toBe(-1900n);
  });
});

describe("accountingTable", () => {
  it("defalcarea pe cote: bază + TVA = brut, rotunjirea o dată pe grup", () => {
    const t = accountingTable([base], ["Perioada: 2026-03-01 – 2026-03-31"]);
    assertTable(t);
    const row = t.rows[0]!;
    expect(row[col("base_1900")]).toBe("100.00");
    expect(row[col("vat_1900")]).toBe("19.00");
    expect(row[col("base_900")]).toBe("27.52");
    expect(row[col("vat_900")]).toBe("2.48");
    expect(row[col("base_2100")]).toBeNull();
    expect(row[col("vat_computed")]).toBe("21.48");
    expect(row[col("vat_receipt")]).toBe("19.91");
    expect(row[col("vat_diff")]).toBe("1.57");
    expect(row[col("lines_total")]).toBe("149.00");
    expect(row[col("total")]).toBe("149.00");
    expect(row[col("total_diff")]).toBe("0.00");
    expect(row[col("account")]).toBe("Card");
    expect(row[col("category")]).toBe("Alimente");
  });

  it("liniile fără cotă nu se estimează; diferența de TVA rămâne goală", () => {
    const t = accountingTable(
      [{ ...base, groups: [...base.groups, { rate: null, grossMinor: 500n }], totalMinor: 14900n }],
      [],
    );
    const row = t.rows[0]!;
    expect(row[col("gross_no_rate")]).toBe("5.00");
    expect(row[col("vat_diff")]).toBeNull();
    expect(row[col("total_diff")]).toBe("-5.00");
  });

  it("alte cote merg în „Altă cotă”; reducerile (negative) intră în grupul lor", () => {
    const t = accountingTable(
      [
        {
          ...base,
          totalMinor: 1100n,
          vatTotalMinor: 100n,
          groups: [
            { rate: "10.00", grossMinor: 1200n },
            { rate: "19.00", grossMinor: -119n },
          ],
        },
      ],
      [],
    );
    const row = t.rows[0]!;
    expect(row[col("base_other")]).toBe("10.91");
    expect(row[col("vat_other")]).toBe("1.09");
    expect(row[col("base_1900")]).toBe("-1.00");
    expect(row[col("vat_1900")]).toBe("-0.19");
  });

  it("totaluri doar pentru o singură monedă; eticheta în coloana comerciantului", () => {
    const one = accountingTable(
      [
        base,
        {
          ...base,
          id: "x",
          groups: [{ rate: "19.00", grossMinor: 119n }],
          totalMinor: 119n,
          vatTotalMinor: 19n,
        },
      ],
      [],
    );
    expect(one.totals).toBeDefined();
    expect(one.totals![2]).toBe("Total");
    expect(one.totals![col("total")]).toBe("150.19");
    expect(one.totals![col("vat_1900")]).toBe("19.19");
    const mixed = accountingTable([base, { ...base, id: "y", currency: "EUR" }], []);
    expect(mixed.totals).toBeUndefined();
    expect(accountingTable([], []).totals).toBeUndefined();
  });

  it("coloanele au chei unice, ASCII, iar tabelul gol e valid", () => {
    const keys = ACCOUNTING_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+$/);
    assertTable(accountingTable([], ["gol"]));
  });
});

describe("receiptListTable", () => {
  it("o linie per bon, coloane simple, aceleași valori", () => {
    const t = receiptListTable([base], []);
    assertTable(t);
    expect(t.title).toBe("Bonuri");
    expect(t.columns.map((c) => c.key)).toEqual([
      "occurred_on",
      "receipt_number",
      "merchant",
      "tax_id",
      "currency",
      "vat_receipt",
      "total",
      "account",
      "category",
    ]);
    expect(t.rows[0]).toEqual([
      "2026-03-05",
      "0123",
      "LIDL DISCOUNT SRL",
      "RO22891860",
      "RON",
      "19.91",
      "149.00",
      "Card",
      "Alimente",
    ]);
  });
});
