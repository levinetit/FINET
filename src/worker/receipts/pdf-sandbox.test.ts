import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeflate } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPdf, scannedPdf, textPdf } from "@/modules/documents/testing";

import { PdfScanError, scanPdfImages } from "./pdf-scan";
import { PdfChildError, activePdfChildren, readPdfInChild } from "./pdf-sandbox";

/**
 * Teste de adversar pentru citirea PDF-urilor (revizuirile de securitate F6-A): inventarul pe
 * octeți e fail-closed pentru fiecare ocolire cunoscută, iar controlul real (procesul copil sub
 * `prlimit`) oprește o bombă de decompresie fără să afecteze procesul părinte.
 */

const latin1 = (s: string) => Buffer.from(s, "latin1");
const LIMITS = { maxImagePixels: 25_000_000, maxTotalPixels: 50_000_000, maxImages: 96 };

/** PDF cu un singur obiect-imagine cu dicționarul dat (datele: câțiva octeți). */
function pdfWithImageDict(dict: string, extra: readonly Buffer[] = []): Buffer {
  const data = Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  return buildPdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    ),
    Buffer.concat([
      latin1("<< /Length 22 >>\nstream\n"),
      latin1("q 9 0 0 9 0 0 cm /Im1 Do Q"),
      latin1("\nendstream"),
    ]),
    Buffer.concat([
      latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`),
      data,
      latin1("\nendstream"),
    ]),
    ...extra,
  ]);
}

const reason = (fn: () => unknown): string => {
  try {
    fn();
    return "acceptat";
  } catch (error) {
    expect(error).toBeInstanceOf(PdfScanError);
    return (error as PdfScanError).code;
  }
};
const scan = (pdf: Buffer) => reason(() => scanPdfImages(pdf, LIMITS));
const BASE =
  "/Type /XObject /Subtype /Image /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode";

describe("inventarul pe octeți: fail-closed la fiecare ocolire", () => {
  it("dicționar normal → acceptat cu dimensiunile corecte", () => {
    expect(scanPdfImages(pdfWithImageDict(`${BASE} /Width 300 /Height 400`), LIMITS)).toEqual([
      { width: 300, height: 400 },
    ]);
  });

  it.each([
    ["nume cu escape #xx în cheie (/Wid#74h)", `${BASE} /Wid#74h 40000 /Height 40000 /Width 10`],
    [
      "nume cu escape #xx în valoare (/Im#61ge)",
      "/Type /XObject /Subtype /Im#61ge /Width 10 /Height 10",
    ],
    ["chei abreviate /W /H", `${BASE} /W 40000 /H 40000 /Width 10 /Height 10`],
    ["Width dublat", `${BASE} /Width 10 /Width 40000 /Height 10`],
    ["Height dublat", `${BASE} /Width 10 /Height 10 /Height 40000`],
    ["Width indirect (N 0 R)", `${BASE} /Width 6 0 R /Height 10`],
    ["Width neîntreg", `${BASE} /Width 10.5 /Height 10`],
    ["Width lipsă", `${BASE} /Height 10`],
    ["Width zero", `${BASE} /Width 0 /Height 10`],
  ])("%s → pdf_image_unverifiable", (_label, dict) => {
    expect(scan(pdfWithImageDict(dict))).toBe("pdf_image_unverifiable");
  });

  it("fontele cu #20 în nume (bonuri electronice) rămân acceptate", () => {
    expect(scan(pdfWithImageDict(`${BASE} /Width 10 /Height 10 /Name /Arial#20Bold`))).toBe(
      "acceptat",
    );
  });

  it("flux de obiecte (ObjStm) într-un PDF cu imagini → refuzat", () => {
    const objStm = latin1("<< /Type /ObjStm /N 1 /First 4 /Length 0 >>\nstream\n\nendstream");
    expect(scan(pdfWithImageDict(`${BASE} /Width 10 /Height 10`, [objStm]))).toBe(
      "pdf_image_unverifiable",
    );
  });

  it("`/Subtype /Image` într-un obiect fără flux (potrivirea nu trece peste endobj) → refuzat", () => {
    const pdf = buildPdf([
      latin1("<< /Type /Catalog /Pages 2 0 R >>"),
      latin1("<< /Subtype /Image /Width 40000 /Height 40000 >>"),
      latin1("<< /Length 3 >>\nstream\nabc\nendstream"),
    ]);
    expect(scan(pdf)).toBe("pdf_image_unverifiable");
  });

  it("imagine inline necomprimată (BI … ID) → refuzată", () => {
    const pdf = buildPdf([
      latin1("<< /Type /Catalog /Pages 2 0 R >>"),
      latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      latin1("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Contents 4 0 R >>"),
      latin1("<< /Length 40 >>\nstream\nendstream"),
    ]);
    // Imaginea inline e în afara oricărui flux delimitat corect (conținut ostil, neformat).
    const withInline = Buffer.concat([
      pdf,
      latin1("\nBI /W 40000 /H 40000 /BPC 8 /CS /RGB ID x EI\n"),
    ]);
    expect(scan(withInline)).toBe("pdf_image_unverifiable");
  });

  it("imagine peste plafon, sumă peste plafon, prea multe imagini", () => {
    expect(scan(pdfWithImageDict(`${BASE} /Width 40000 /Height 40000`))).toBe("image_too_large");
    expect(
      reason(() =>
        scanPdfImages(pdfWithImageDict(`${BASE} /Width 3000 /Height 3000`), {
          ...LIMITS,
          maxTotalPixels: 1_000_000,
        }),
      ),
    ).toBe("image_too_large");
    expect(
      reason(() =>
        scanPdfImages(pdfWithImageDict(`${BASE} /Width 10 /Height 10`), {
          ...LIMITS,
          maxImages: 0,
        }),
      ),
    ).toBe("pdf_too_complex");
  });

  it("octeții din fluxuri nu produc potriviri false", async () => {
    expect(scan(await scannedPdf())).toBe("acceptat");
    expect(scan(textPdf())).toBe("acceptat");
  });
});

/** Un flux Flate de `size` octeți zero, comprimat în flux (fără a-l ține în memorie). */
async function deflatedZeros(size: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  deflate.on("data", (c: Buffer) => out.push(c));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  const chunk = Buffer.alloc(1024 * 1024);
  for (let written = 0; written < size; written += chunk.length) {
    if (!deflate.write(chunk)) await new Promise((r) => deflate.once("drain", r));
  }
  deflate.end();
  await done;
  return Buffer.concat(out);
}

describe("procesul copil sub prlimit: controlul real", () => {
  it("bombă de decompresie (imagine 12000×12000 dintr-un flux mic): copilul moare, părintele nu", async () => {
    const width = 12000;
    const height = 12000;
    const data = await deflatedZeros(width * height * 3);
    expect(data.length).toBeLessThan(1024 * 1024);
    const pdf = buildPdf([
      latin1("<< /Type /Catalog /Pages 2 0 R >>"),
      latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
      latin1(
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
      ),
      Buffer.concat([
        latin1("<< /Length 26 >>\nstream\n"),
        latin1("q 300 0 0 300 0 0 cm /Im1 Do Q"),
        latin1("\nendstream"),
      ]),
      Buffer.concat([
        latin1(`<< ${BASE} /Width ${width} /Height ${height} /Length ${data.length} >>\nstream\n`),
        data,
        latin1("\nendstream"),
      ]),
    ]);
    const before = process.memoryUsage().rss;
    // Direct în copil (ocolind inventarul, care ar refuza-o oricum): plafonul e al sistemului.
    const error = await readPdfInChild(pdf, {
      maxPages: 6,
      minTextChars: 20,
      deadline: Date.now() + 60_000,
      maxImagePixels: 200_000_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PdfChildError);
    expect((error as PdfChildError).code).toBe("pdf_too_complex");
    expect(activePdfChildren()).toBe(0);
    // Părintele nu a alocat pixelii (sub 100 MB în plus față de început).
    expect(process.memoryUsage().rss - before).toBeLessThan(100 * 1024 * 1024);
  }, 120_000);

  describe("copil ostil (simulat): părintele nu alocă peste bugetul fix", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "finet-fake-child-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const fake = async (name: string, code: string) => {
      const path = join(dir, `${name}.mjs`);
      await writeFile(path, code);
      return path;
    };
    const run = (childScript: string) =>
      readPdfInChild(textPdf(), {
        maxPages: 6,
        minTextChars: 20,
        maxImagePixels: 25_000_000,
        deadline: Date.now() + 30_000,
        childScript,
      }).catch((e: unknown) => e);

    it.each([
      [
        "anunță o imagine de 200 MB",
        `process.stdout.write(JSON.stringify({pages:1,text:[""],images:[{width:100,height:100,length:200*1024*1024}]})+"\\n"); setInterval(()=>{},1000);`,
      ],
      [
        "anunță 10 octeți, trimite 4 MB",
        `process.stdout.write(JSON.stringify({pages:1,text:[""],images:[{width:10,height:10,length:10}]})+"\\n"); process.stdout.write(Buffer.alloc(4*1024*1024,1)); setInterval(()=>{},1000);`,
      ],
      [
        "antet fără sfârșit (8 MB fără linie nouă)",
        `process.stdout.write(Buffer.alloc(8*1024*1024,65)); setInterval(()=>{},1000);`,
      ],
      [
        "imagine declarată 40000×40000 (peste latura maximă)",
        `process.stdout.write(JSON.stringify({pages:1,text:[""],images:[{width:40000,height:40000,length:1000}]})+"\\n"); setInterval(()=>{},1000);`,
      ],
      [
        "suma imaginilor peste bugetul total (5 × 8 MB)",
        `process.stdout.write(JSON.stringify({pages:5,text:["","","","",""],images:Array.from({length:5},()=>({width:2000,height:2000,length:8*1024*1024}))})+"\\n"); setInterval(()=>{},1000);`,
      ],
    ])(
      "%s → ucis, pdf_too_complex, fără copil rămas",
      async (_label, code) => {
        const before = process.memoryUsage().rss;
        const error = await run(await fake(`f${Math.random().toString(36).slice(2)}`, code));
        expect(error).toBeInstanceOf(PdfChildError);
        expect((error as PdfChildError).code).toBe("pdf_too_complex");
        expect(activePdfChildren()).toBe(0);
        // Plafonul antetului e 1 MB; corpul nu se alocă peste bugetul declarat valid (≤ 32 MB).
        expect(process.memoryUsage().rss - before).toBeLessThan(48 * 1024 * 1024);
      },
      60_000,
    );

    it("timeout: copilul care nu răspunde e ucis (SIGKILL) la termen", async () => {
      const script = await fake("hang", "setInterval(()=>{},1000);");
      const error = await readPdfInChild(textPdf(), {
        maxPages: 6,
        minTextChars: 20,
        maxImagePixels: 25_000_000,
        deadline: Date.now() + 300,
        childScript: script,
      }).catch((e: unknown) => e);
      expect((error as PdfChildError).code).toBe("preprocess_timeout");
      expect(activePdfChildren()).toBe(0);
    }, 30_000);
  });

  it("PDF normal: textul și imaginea scanată se întorc corect", async () => {
    const text = await readPdfInChild(textPdf(), {
      maxPages: 6,
      minTextChars: 20,
      deadline: Date.now() + 30_000,
      maxImagePixels: 25_000_000,
    });
    expect(text.images).toBeNull();
    const scanned = await readPdfInChild(await scannedPdf(), {
      maxPages: 6,
      minTextChars: 20,
      deadline: Date.now() + 30_000,
      maxImagePixels: 25_000_000,
    });
    expect(scanned.images?.map((i) => [i.width, i.height])).toEqual([[300, 500]]);
    // Copilul trimite JPEG (comprimat), nu raster brut.
    expect(scanned.images![0]!.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(activePdfChildren()).toBe(0);
  }, 60_000);
});
