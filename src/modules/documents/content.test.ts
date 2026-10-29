import { describe, expect, it } from "vitest";

import { ContentRejectedError, imageSize, sniffMime, validateHead } from "./content";
import { HOSTILE, pngBomb, receiptLikeImage, scannedPdf, textPdf } from "./testing";

const LIMITS = { maxImagePixels: 50_000_000 };

function reasonOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ContentRejectedError);
    return (error as ContentRejectedError).reason;
  }
}

describe("validarea după conținut (magic bytes)", () => {
  it.each(["jpeg", "png", "webp"] as const)(
    "%s valid → tipul și dimensiunile din antet",
    async (f) => {
      const data = await receiptLikeImage({ width: 321, height: 654, format: f });
      const result = validateHead(data, LIMITS);
      expect(result.mime).toBe(`image/${f}`);
      expect(result.size).toEqual({ width: 321, height: 654 });
    },
  );

  it("PDF cu text și PDF scanat → application/pdf", async () => {
    expect(validateHead(textPdf(), LIMITS).mime).toBe("application/pdf");
    expect(validateHead(await scannedPdf(), LIMITS).mime).toBe("application/pdf");
  });

  it.each(HOSTILE)("%s → respins (%s)", (_label, data, reason) => {
    expect(reasonOf(() => validateHead(data, LIMITS))).toBe(reason);
  });

  it("bombă de decompresie: antet PNG 30000×30000 → image_too_large, fără decodare", async () => {
    expect(reasonOf(() => validateHead(Buffer.from([]), LIMITS))).toBe("empty_file");
    const bomb = await pngBomb();
    expect(imageSize(bomb, "image/png")).toEqual({ width: 30000, height: 30000 });
    expect(reasonOf(() => validateHead(bomb, LIMITS))).toBe("image_too_large");
  });

  it("plafonul de pixeli e configurabil", async () => {
    const data = await receiptLikeImage({ width: 2000, height: 1000 });
    expect(reasonOf(() => validateHead(data, { maxImagePixels: 1_999_999 }))).toBe(
      "image_too_large",
    );
    expect(validateHead(data, { maxImagePixels: 2_000_000 }).mime).toBe("image/jpeg");
  });

  it("JPEG trunchiat înainte de SOF → invalid_image", () => {
    const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect(reasonOf(() => validateHead(truncated, LIMITS))).toBe("invalid_image");
  });

  it("extensia/tipul declarat nu contează: decide doar conținutul", async () => {
    // Același PNG, indiferent cum ar fi numit: tipul vine din semnătură.
    expect(sniffMime(await receiptLikeImage({ format: "png" }))).toBe("image/png");
  });
});
