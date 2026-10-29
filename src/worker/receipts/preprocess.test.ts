import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  blankPdf,
  HOSTILE,
  jpegWithGpsExif,
  pdfWithDeclaredImage,
  pngBomb,
  receiptLikeImage,
  scannedPdf,
  textPdf,
} from "@/modules/documents/testing";

import {
  MAX_SIDE_PX,
  PreprocessError,
  type PreprocessLimits,
  dHash,
  hammingDistance,
  preprocessDocument,
} from "./preprocess";
import { scanPdfImages } from "./pdf-scan";
import { activePdfChildren, spawnedPdfChildren } from "./pdf-sandbox";

const LIMITS: PreprocessLimits = { maxImagePixels: 50_000_000, maxPdfPages: 6, timeoutMs: 30_000 };

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error = await work.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PreprocessError);
  return (error as PreprocessError).code;
}

function onlyImage(result: Awaited<ReturnType<typeof preprocessDocument>>) {
  expect(result.kind).toBe("images");
  if (result.kind !== "images") throw new Error("nu e imagine");
  expect(result.images).toHaveLength(1);
  return result.images[0]!;
}

describe("preprocesarea imaginilor", () => {
  it("EXIF (inclusiv GPS) eliminat complet; rotirea după orientare aplicată", async () => {
    const input = await jpegWithGpsExif();
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);
    expect([before.width, before.height]).toEqual([300, 200]);

    const image = onlyImage(await preprocessDocument(input, "image/jpeg", LIMITS));
    const after = await sharp(image.jpeg).metadata();
    expect(after.format).toBe("jpeg");
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    // Orientarea 6 = rotit 90°: lățimea și înălțimea se inversează.
    expect([after.width, after.height]).toEqual([200, 300]);
    // Nici urmă din șirurile EXIF în octeții de ieșire.
    const text = image.jpeg.toString("latin1");
    for (const marker of ["Exif", "TelefonTest", "ModelTest", "GPS"]) {
      expect(text).not.toContain(marker);
    }
  });

  it("redimensionează la cel mult 2048 px pe latura lungă, fără mărire", async () => {
    const big = await receiptLikeImage({ width: 3000, height: 1200 });
    const image = onlyImage(await preprocessDocument(big, "image/jpeg", LIMITS));
    expect([image.width, image.height]).toEqual([MAX_SIDE_PX, Math.round((1200 * 2048) / 3000)]);
    const small = onlyImage(
      await preprocessDocument(
        await receiptLikeImage({ width: 200, height: 300 }),
        "image/jpeg",
        LIMITS,
      ),
    );
    expect([small.width, small.height]).toEqual([200, 300]);
  });

  it.each(["png", "webp"] as const)("%s → JPEG re-encodat", async (format) => {
    const input = await receiptLikeImage({ format });
    const image = onlyImage(await preprocessDocument(input, `image/${format}`, LIMITS));
    expect((await sharp(image.jpeg).metadata()).format).toBe("jpeg");
  });

  it("tipul salvat diferit de conținut → mime_mismatch", async () => {
    const png = await receiptLikeImage({ format: "png" });
    expect(await codeOf(preprocessDocument(png, "image/jpeg", LIMITS))).toBe("mime_mismatch");
  });

  it("bombă de decompresie → image_too_large, fără decodare", async () => {
    expect(await codeOf(preprocessDocument(await pngBomb(), "image/png", LIMITS))).toBe(
      "image_too_large",
    );
  });

  it("imagine coruptă după antet → invalid_image", async () => {
    const jpg = await receiptLikeImage();
    const corrupt = Buffer.concat([jpg.subarray(0, 400), Buffer.alloc(2000, 0x55)]);
    expect(await codeOf(preprocessDocument(corrupt, "image/jpeg", LIMITS))).toBe("invalid_image");
  });

  it.each(HOSTILE)("%s → respins (%s)", async (_label, data, reason) => {
    expect(await codeOf(preprocessDocument(data, "image/jpeg", LIMITS))).toBe(reason);
  });

  it("timeout → preprocess_timeout", async () => {
    const big = await receiptLikeImage({ width: 3000, height: 3000 });
    expect(await codeOf(preprocessDocument(big, "image/jpeg", { ...LIMITS, timeoutMs: 1 }))).toBe(
      "preprocess_timeout",
    );
  });
});

describe("dHash (poză aproape identică)", () => {
  it("aceeași poză re-encodată/redimensionată: distanță mică; alt bon: distanță mare", async () => {
    const a = await receiptLikeImage({ seed: 1 });
    const aSmall = await sharp(a).resize(200).jpeg({ quality: 50 }).toBuffer();
    const b = await receiptLikeImage({ seed: 7 });
    const ha = await dHash(a);
    expect(hammingDistance(ha, await dHash(aSmall))).toBeLessThanOrEqual(6);
    expect(hammingDistance(ha, await dHash(b))).toBeGreaterThan(6);
    expect(hammingDistance(ha, ha)).toBe(0);
  });

  it("hash-ul încape într-un bigint cu semn pe 64 de biți", async () => {
    const h = await dHash(await receiptLikeImage());
    expect(h).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(h).toBeLessThan(2n ** 63n);
    expect(hammingDistance(0n, -1n)).toBe(64);
  });
});

describe("preprocesarea PDF-urilor", () => {
  it("PDF cu text → textul pe pagini (pentru modelul text)", async () => {
    const result = await preprocessDocument(
      textPdf(["KAUFLAND ROMANIA SCS TOTAL 12,50", "PAGINA DOI CU TEXT SUFICIENT"]),
      "application/pdf",
      LIMITS,
    );
    expect(result).toEqual({
      kind: "text",
      pages: 2,
      text: ["KAUFLAND ROMANIA SCS TOTAL 12,50", "PAGINA DOI CU TEXT SUFICIENT"],
    });
  });

  it("PDF scanat → imaginea paginii extrasă și preprocesată (fără randare)", async () => {
    const image = onlyImage(
      await preprocessDocument(await scannedPdf(), "application/pdf", LIMITS),
    );
    expect([image.width, image.height]).toEqual([300, 500]);
    expect((await sharp(image.jpeg).metadata()).format).toBe("jpeg");
  });

  it("PDF fără text și fără imagini → pdf_no_content", async () => {
    expect(await codeOf(preprocessDocument(blankPdf(), "application/pdf", LIMITS))).toBe(
      "pdf_no_content",
    );
  });

  it("prea multe pagini → too_many_pages", async () => {
    const pages = Array.from({ length: 7 }, (_, i) => `PAGINA ${i + 1} CU DESTUL TEXT AICI`);
    expect(await codeOf(preprocessDocument(textPdf(pages), "application/pdf", LIMITS))).toBe(
      "too_many_pages",
    );
    expect(
      (await preprocessDocument(textPdf(pages), "application/pdf", { ...LIMITS, maxPdfPages: 7 }))
        .pages,
    ).toBe(7);
  });

  it("PDF stricat → pdf_invalid", async () => {
    const broken = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n");
    expect(await codeOf(preprocessDocument(broken, "application/pdf", LIMITS))).toBe("pdf_invalid");
  });

  it("bombă în PDF (imagine declarată 20000×20000): refuzată rapid, fără proces copil", async () => {
    const before = spawnedPdfChildren();
    expect(
      await codeOf(
        preprocessDocument(pdfWithDeclaredImage(20000, 20000), "application/pdf", LIMITS),
      ),
    ).toBe("image_too_large");
    expect(spawnedPdfChildren()).toBe(before);
  });

  it("dimensiune prin referință indirectă → pdf_image_unverifiable (fără decodare)", async () => {
    const before = spawnedPdfChildren();
    expect(
      await codeOf(
        preprocessDocument(pdfWithDeclaredImage(300, 300, true), "application/pdf", LIMITS),
      ),
    ).toBe("pdf_image_unverifiable");
    expect(spawnedPdfChildren()).toBe(before);
  });

  it("timeout pe PDF: procesul copil e ucis (SIGKILL), nicio muncă rămasă", async () => {
    expect(
      await codeOf(preprocessDocument(textPdf(), "application/pdf", { ...LIMITS, timeoutMs: 20 })),
    ).toBe("preprocess_timeout");
    expect(activePdfChildren()).toBe(0);
  });

  it("după o citire reușită, procesul copil s-a terminat", async () => {
    await preprocessDocument(textPdf(), "application/pdf", LIMITS);
    expect(activePdfChildren()).toBe(0);
  });
});

describe("inventarul imaginilor din PDF (fără decodare)", () => {
  it("citește dimensiunile; plafon pe imagine și însumat pe document", async () => {
    const pdf = await scannedPdf();
    expect(
      scanPdfImages(pdf, { maxImagePixels: 1_000_000, maxTotalPixels: 1_000_000, maxImages: 10 }),
    ).toEqual([{ width: 300, height: 500 }]);
    expect(() =>
      scanPdfImages(pdf, { maxImagePixels: 100_000, maxTotalPixels: 1_000_000, maxImages: 10 }),
    ).toThrow(expect.objectContaining({ code: "image_too_large" }));
    expect(() =>
      scanPdfImages(pdf, { maxImagePixels: 1_000_000, maxTotalPixels: 100_000, maxImages: 10 }),
    ).toThrow(expect.objectContaining({ code: "image_too_large" }));
    expect(
      scanPdfImages(textPdf(), { maxImagePixels: 1, maxTotalPixels: 1, maxImages: 1 }),
    ).toEqual([]);
  });

  it("`/Subtype /Image` în afara unui dicționar de flux → pdf_image_unverifiable", () => {
    const odd = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Width 10 /Height 10 >>\nendobj\n",
    );
    expect(() =>
      scanPdfImages(odd, { maxImagePixels: 1e9, maxTotalPixels: 1e9, maxImages: 10 }),
    ).toThrow(expect.objectContaining({ code: "pdf_image_unverifiable" }));
  });
});
