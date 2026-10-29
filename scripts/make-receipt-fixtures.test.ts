import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkReceipt } from "@/modules/receipts/checks";
import { parseModelReceipt, toExtractedReceipt } from "@/modules/receipts/extraction.schema";
import { RO_VAT_RATES_FALLBACK } from "@/modules/receipts/vat";

import { FIXTURES, renderFixture } from "./make-receipt-fixtures.mjs";

describe("bonurile sintetice (scripts/make-receipt-fixtures.mjs)", () => {
  it("adevărul e coerent: fiecare bon trece verificările din cod (sumă, CUI, TVA, SGR)", () => {
    for (const gt of FIXTURES) {
      const model = parseModelReceipt({
        merchantName: gt.merchantName,
        merchantTaxId: gt.merchantTaxId,
        storeAddress: gt.storeAddress,
        receiptNumber: gt.receiptNumber,
        date: gt.date,
        paymentMethod: gt.paymentMethod,
        currency: gt.currency,
        total: gt.total,
        vatTotal: gt.vatTotal,
        lines: gt.lines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          vatRate: l.vatRate,
          type: l.type,
        })),
      });
      expect(
        checkReceipt(toExtractedReceipt(model), {
          today: "2026-10-29",
          vatRates: RO_VAT_RATES_FALLBACK,
        }),
        gt.id,
      ).toEqual([]);
    }
  });

  it("ground-truth.json din repo e sincronizat cu scriptul", () => {
    const file = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures/receipts/ground-truth.json"), "utf8"),
    );
    expect(file.receipts).toEqual(JSON.parse(JSON.stringify(FIXTURES)));
  });

  it("generează fișiere după conținut: JPEG/PNG/PDF; bonul lung în 3 părți", async () => {
    const lung = await renderFixture(FIXTURES.find((f) => f.id === "bon-lung-3-parti")!);
    expect(lung.map((f) => f.name)).toEqual([
      "bon-lung-3-parti-1.jpg",
      "bon-lung-3-parti-2.jpg",
      "bon-lung-3-parti-3.jpg",
    ]);
    expect(lung[0]!.data.subarray(0, 2).toString("hex")).toBe("ffd8");
    const [pdf] = await renderFixture(FIXTURES.find((f) => f.id === "pdf-text")!);
    expect(pdf!.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const [png] = await renderFixture(FIXTURES.find((f) => f.id === "kaufland-reducere-punga")!);
    expect(png!.data.subarray(1, 4).toString("latin1")).toBe("PNG");
  });
});
