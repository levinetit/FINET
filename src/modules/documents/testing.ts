import sharp from "sharp";

/**
 * Doar pentru teste: fișiere generate în cod (fără binare în repo). Imagini prin sharp (inclusiv
 * una cu EXIF GPS și orientare), PDF-uri minimale scrise de mână (cu text sau cu o imagine
 * scanată), plus conținut ostil (SVG, HTML, EXE, poligloți). Nu se importă din aplicație.
 */

/** Un „bon” sintetic: fundal deschis cu dungi închise (dHash stabil și diferit de alte modele). */
export async function receiptLikeImage(
  options: Readonly<{
    width?: number;
    height?: number;
    format?: "jpeg" | "png" | "webp";
    seed?: number;
  }> = {},
): Promise<Buffer> {
  const width = options.width ?? 400;
  const height = options.height ?? 600;
  const seed = options.seed ?? 1;
  const rows: string[] = [];
  for (let i = 0; i < 12; i++) {
    const w = 40 + ((i * 37 * seed) % (width - 80));
    rows.push(`<rect x="20" y="${30 + i * 45}" width="${w}" height="14" fill="#222"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f4f1ea"/>${rows.join("")}</svg>`;
  const img = sharp(Buffer.from(svg));
  const format = options.format ?? "jpeg";
  if (format === "png") return img.png().toBuffer();
  if (format === "webp") return img.webp().toBuffer();
  return img.jpeg({ quality: 90 }).toBuffer();
}

/** JPEG cu EXIF: orientare 6 (rotit 90°), GPS (IFD3), aparat foto. */
export async function jpegWithGpsExif(): Promise<Buffer> {
  const base = await receiptLikeImage({ width: 300, height: 200 });
  return (
    sharp(base)
      .withExif({
        IFD0: { Make: "TelefonTest", Model: "ModelTest" },
        IFD3: {
          GPSLatitudeRef: "N",
          GPSLatitude: "44/1 25/1 0/1",
          GPSLongitudeRef: "E",
          GPSLongitude: "26/1 6/1 0/1",
        },
      })
      // Orientarea se setează separat (sharp o scrie din `withMetadata`, nu din IFD0).
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()
  );
}

const latin1 = (s: string) => Buffer.from(s, "latin1");

/** Un PDF minimal valid din corpurile obiectelor (fără `n 0 obj` / `endobj`). */
export function buildPdf(objects: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const b = Buffer.concat([latin1(`${i + 1} 0 obj\n`), body, latin1("\nendobj\n")]);
    parts.push(b);
    length += b.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(
    latin1(
      `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

const stream = (dict: string, data: Buffer) =>
  Buffer.concat([
    latin1(`<< ${dict} /Length ${data.length} >>\nstream\n`),
    data,
    latin1("\nendstream"),
  ]);

/** PDF cu text (bon electronic), câte o pagină pe fiecare șir din `pages`. */
export function textPdf(pages: readonly string[] = ["LIDL DISCOUNT SRL TOTAL 45,90"]): Buffer {
  const n = pages.length;
  // 1 catalog, 2 pagini, 3 font, apoi pentru fiecare pagină: pagina + conținutul.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects: Buffer[] = [
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  pages.forEach((text, i) => {
    objects.push(
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      ),
    );
    const safe = text.replace(/[()\\]/g, "");
    objects.push(stream("", latin1(`BT /F1 12 Tf 20 150 Td (${safe}) Tj ET`)));
  });
  return buildPdf(objects);
}

/** PDF „scanat”: o pagină cu o singură imagine JPEG, fără text. */
export async function scannedPdf(): Promise<Buffer> {
  const jpg = await sharp(await receiptLikeImage({ width: 300, height: 500 }))
    .jpeg()
    .toBuffer();
  return buildPdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    ),
    stream("", latin1("q 300 0 0 500 0 0 cm /Im1 Do Q")),
    stream(
      "/Type /XObject /Subtype /Image /Width 300 /Height 500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
      jpg,
    ),
  ]);
}

/**
 * PDF cu o imagine care DECLARĂ dimensiunile date (datele reale sunt câțiva octeți): o bombă de
 * decompresie simulată. `indirect`: lățimea dată prin referință (`/Width 6 0 R`).
 */
export function pdfWithDeclaredImage(width: number, height: number, indirect = false): Buffer {
  const data = Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  return buildPdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    ),
    stream("", latin1("q 300 0 0 300 0 0 cm /Im1 Do Q")),
    stream(
      `/Type /XObject /Subtype /Image /Width ${indirect ? "6 0 R" : width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
      data,
    ),
    latin1(String(width)),
  ]);
}

/** PDF gol (o pagină fără text și fără imagini). */
export function blankPdf(): Buffer {
  return buildPdf([
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    latin1("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>"),
  ]);
}

/** PNG valid de 1×1 care DECLARĂ în antet dimensiuni uriașe (bombă de decompresie simulată). */
export async function pngBomb(width = 30000, height = 30000): Promise<Buffer> {
  const png = Buffer.from(
    await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } })
      .png()
      .toBuffer(),
  );
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

/** Conținut ostil sau neacceptat, cu „extensia” pe care ar pretinde-o. */
export const HOSTILE: ReadonlyArray<readonly [label: string, data: Buffer, reason: string]> = [
  [
    "SVG cu script (pretinde .jpg)",
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    "unsupported_type",
  ],
  [
    "HTML (pretinde .png)",
    Buffer.from("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>"),
    "unsupported_type",
  ],
  [
    "EXE (MZ, pretinde .pdf)",
    Buffer.concat([Buffer.from("MZ"), Buffer.alloc(256, 0x90)]),
    "unsupported_type",
  ],
  [
    "ZIP (pretinde .webp)",
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]),
    "unsupported_type",
  ],
  [
    "HEIC",
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(32)]),
    "heic_unsupported",
  ],
  [
    "AVIF",
    Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypavif"), Buffer.alloc(32)]),
    "heic_unsupported",
  ],
  [
    "poliglot JPEG + HTML în comentariu",
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x30]),
      Buffer.from("<html><script>alert(document.cookie)</script></html>"),
    ]),
    "markup_content",
  ],
  [
    "poliglot PDF + HTML",
    Buffer.from("%PDF-1.4\n<html><body><script>alert(1)</script></body></html>"),
    "markup_content",
  ],
  [
    "PDF după un prefix (semnătura nu e la offset 0)",
    Buffer.from("  \n%PDF-1.4\n"),
    "unsupported_type",
  ],
  ["fișier gol", Buffer.alloc(0), "empty_file"],
];

export type FormPart = readonly [
  name: string,
  data: Buffer | string,
  filename?: string,
  type?: string,
];

/**
 * O cerere `multipart/form-data` cu corpul deja serializat (ca de la un client real). Corpul
 * generat de `FormData` în undici nu suportă anularea la mijloc, deci se serializează întâi.
 */
export async function multipartRequest(
  parts: readonly FormPart[],
  headers: Record<string, string> = {},
): Promise<Request> {
  const form = new FormData();
  for (const [name, data, filename, type] of parts) {
    if (typeof data === "string") form.append(name, data);
    else form.append(name, new Blob([new Uint8Array(data)], { type: type ?? "" }), filename ?? "f");
  }
  const encoded = new Request("http://localhost/api/v1/documents", { method: "POST", body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  return new Request("http://localhost/api/v1/documents", {
    method: "POST",
    headers: { "content-type": encoded.headers.get("content-type")!, ...headers },
    body,
  });
}
