import { buildPdf } from "@/modules/documents/testing";

import type { TextItem } from "./types";

/**
 * Doar pentru teste: un PDF cu text la pozițiile date (Helvetica 8 pt, WinAnsiEncoding), din
 * elementele unui fixture sintetic. Caracterele fără loc în WinAnsi (ă, ș, ț) se transliterează
 * (parserele pliază oricum diacriticele), `€` devine codul WinAnsi 0x80. Nu se importă din codul
 * aplicației.
 */
const TRANSLIT: Readonly<Record<string, string>> = {
  ă: "a",
  Ă: "A",
  ș: "s",
  Ș: "S",
  ț: "t",
  Ț: "T",
  "€": "\x80",
};

const latin1 = (s: string) => Buffer.from(s, "latin1");

function pdfString(s: string): string {
  const t = [...s].map((c) => TRANSLIT[c] ?? (c.charCodeAt(0) <= 0xff ? c : "?")).join("");
  return t.replace(/[()\\]/g, (c) => `\\${c}`);
}

export function itemsToPdf(items: readonly TextItem[], pageCount?: number): Buffer {
  const pages = pageCount ?? Math.max(1, ...items.map((i) => i.p));
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects: Buffer[] = [
    latin1("<< /Type /Catalog /Pages 2 0 R >>"),
    latin1(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`),
    latin1("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  ];
  for (let p = 1; p <= pages; p++) {
    objects.push(
      latin1(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (p - 1) * 2} 0 R >>`,
      ),
    );
    const ops = items
      .filter((i) => i.p === p)
      .map((i) => `BT /F1 8 Tf 1 0 0 1 ${i.x} ${i.y} Tm (${pdfString(i.s)}) Tj ET`)
      .join("\n");
    const data = latin1(ops);
    objects.push(
      Buffer.concat([
        latin1(`<< /Length ${data.length} >>\nstream\n`),
        data,
        latin1("\nendstream"),
      ]),
    );
  }
  return buildPdf(objects);
}
