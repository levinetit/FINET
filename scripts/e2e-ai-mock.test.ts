import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { checkReceipt } from "@/modules/receipts/checks";
import { parseModelReceipt, toExtractedReceipt } from "@/modules/receipts/extraction.schema";
import { mergeReceiptParts } from "@/modules/receipts/merge";
import { RO_VAT_RATES_FALLBACK } from "@/modules/receipts/vat";

import { jpegWidth, receiptFor } from "./e2e-ai-mock-data.mjs";

/**
 * Serverul AI fals al E2E (F6-C): lățimea pozei se citește corect din JPEG, iar bonurile întoarse
 * trec validarea strictă (aceeași schemă ca răspunsurile reale) și verificările din cod; bonul lung
 * (802 + 803) se unește cu totalul potrivit.
 */
describe("serverul AI fals pentru E2E", () => {
  const ctx = { today: "2026-10-29", vatRates: RO_VAT_RATES_FALLBACK };
  const parse = (w: number | null) => toExtractedReceipt(parseModelReceipt(receiptFor(w)));

  it("lățimea JPEG din antet (SOF)", async () => {
    for (const w of [801, 802, 803, 1500]) {
      const jpg = await sharp({
        create: { width: w, height: 1200, channels: 3, background: { r: 250, g: 250, b: 250 } },
      })
        .jpeg()
        .toBuffer();
      expect(jpegWidth(jpg)).toBe(w);
    }
    expect(jpegWidth(Buffer.from("nu e jpeg"))).toBeNull();
  });

  it("bonurile sunt valide și coerente", () => {
    const simple = parse(801);
    expect(simple.totalMinor).toBe(2048n);
    expect(checkReceipt(simple, ctx).map((i) => i.code)).toEqual([]);
    const generic = parse(950);
    expect(checkReceipt(generic, ctx).map((i) => i.code)).toEqual([]);
    expect(generic.receiptNumber).toBe("950");
    const merged = mergeReceiptParts([parse(802), parse(803)]);
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.receipt.lines.map((l) => l.rawName)).toEqual(["PAINE", "LAPTE", "OUA", "MERE"]);
      expect(merged.difference).toBe(0n);
    }
  });
});
