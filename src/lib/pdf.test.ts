import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";

import type { ExportTable } from "./export-table";
import { PDF_MAX_ROWS, displayCell, encodeChar, tableToPdf, textWidth, wrap } from "./pdf";

const columns = [
  { key: "date", label: "Data", kind: "date" },
  { key: "merchant", label: "Comerciant", kind: "text" },
  { key: "amount", label: "Suma (RON)", kind: "money" },
  { key: "n", label: "Bucăți", kind: "int" },
] as const;

const small: ExportTable = {
  title: "Raport în română: ăâîșț ĂÂÎȘȚ",
  context: ["Perioada: 2026-03-01 – 2026-03-31"],
  columns,
  rows: [
    ["2026-03-05", "Piața Ștefan cel Mare — țuică „bună”", "-1234567.89", 2],
    ["2026-03-06", "ŞCOALĂ şi ţară (sedilă)", "0.5", null],
  ],
  totals: [null, "Total", "-1234567.39", 2],
};

async function textOf(pdf: Uint8Array): Promise<{ pages: string[]; count: number }> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { totalPages, text } = await extractText(doc, { mergePages: false });
  return { pages: text, count: totalPages };
}

describe("pdf: funcții mici", () => {
  it("codificarea: diacriticele românești au coduri proprii, restul ASCII/Latin-1", () => {
    expect(["ă", "Ă", "ș", "Ș", "ț", "Ț", "ş", "ţ"].map(encodeChar)).toEqual([
      1, 2, 3, 4, 5, 6, 3, 5,
    ]);
    expect(encodeChar("a")).toBe(0x61);
    expect(encodeChar("â")).toBe(0xe2);
    expect(encodeChar("î")).toBe(0xee);
    expect(encodeChar("😀")).toBe(0x3f);
    expect(encodeChar("\n")).toBe(0x20);
  });
  it("lățimea textului: literele înguste sunt mai înguste; accentele păstrează lățimea literei", () => {
    expect(textWidth("iiii", 10)).toBeLessThan(textWidth("WWWW", 10));
    expect(textWidth("a", 10)).toBeCloseTo(5.56, 5);
    expect(textWidth("ă", 10)).toBeCloseTo(textWidth("a", 10), 5);
    expect(textWidth("â", 10)).toBeCloseTo(textWidth("a", 10), 5);
  });
  it("sumele se afișează cu puncte la mii și virgulă", () => {
    expect(displayCell("money", "-1234567.89")).toBe("-1.234.567,89");
    expect(displayCell("money", "0.5")).toBe("0,50");
    expect(displayCell("money", "12")).toBe("12,00");
    expect(displayCell("percent", 80)).toBe("80%");
    expect(displayCell("int", null)).toBe("");
  });
  it("wrap: rupe pe cuvinte, apoi pe caractere, cu cel mult 3 rânduri și „…”", () => {
    const lines = wrap("unu doi trei patru cinci șase șapte opt nouă zece", 40, 8);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(40.001);
    expect(lines.at(-1)!.text.endsWith("…")).toBe(true);
    const long = wrap("x".repeat(80), 30, 8);
    expect(long.length).toBeGreaterThan(1);
    for (const l of long) expect(l.width).toBeLessThanOrEqual(30.001);
    expect(wrap("", 30, 8)).toHaveLength(1);
  });
});

describe("tableToPdf", () => {
  it("structura: antet, xref cu decalaje corecte, sfârșit", () => {
    const buf = Buffer.from(tableToPdf(small));
    const text = buf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(entries.length).toBeGreaterThanOrEqual(6);
    entries.forEach((offset, i) => {
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("textul extras de un cititor independent (pdf.js) păstrează diacriticele și sumele", async () => {
    const { pages, count } = await textOf(tableToPdf(small));
    expect(count).toBe(1);
    const t = pages[0]!;
    expect(t).toContain("Raport în română: ăâîșț ĂÂÎȘȚ");
    expect(t).toContain("Piața Ștefan cel Mare");
    expect(t).toContain("țuică");
    expect(t).toContain("-1.234.567,89");
    expect(t).toContain("0,50");
    expect(t).toContain("Pagina 1 din 1");
    // sedilele se desenează cu glifele cu virgulă (același aspect), deci textul extras e cu virgulă
    expect(t).toContain("ȘCOALĂ și țară");
  });

  it("mai multe pagini: antetul se repetă, numerotarea e corectă, totalul e pe ultima", async () => {
    const rows = Array.from({ length: 220 }, (_, i) => [
      "2026-03-05",
      `Magazin ${i}`,
      `${i}.25`,
      i,
    ]) as ExportTable["rows"][number][];
    const table: ExportTable = { ...small, rows, totals: [null, "Total general", "99.00", 1] };
    const { pages, count } = await textOf(tableToPdf(table));
    expect(count).toBeGreaterThan(2);
    pages.forEach((p, i) => {
      expect(p).toContain("Comerciant");
      expect(p).toContain(`Pagina ${i + 1} din ${count}`);
    });
    expect(pages[count - 1]).toContain("Total general");
    expect(pages[0]).toContain("Magazin 0");
    expect(pages[count - 1]).toContain("Magazin 219");
  });

  it("antetul nu primește sufixul % al coloanelor procentuale", async () => {
    const table: ExportTable = {
      ...small,
      columns: [{ key: "p", label: "Pondere %", kind: "percent" }],
      rows: [[50]],
      totals: undefined,
    };
    const { pages } = await textOf(tableToPdf(table));
    expect(pages[0]).toContain("Pondere %");
    expect(pages[0]).not.toContain("Pondere %%");
    expect(pages[0]).toContain("50%");
  });

  it("este determinist și refuză prea multe rânduri", () => {
    expect(Buffer.from(tableToPdf(small)).equals(Buffer.from(tableToPdf(small)))).toBe(true);
    const many = Array.from({ length: PDF_MAX_ROWS + 1 }, () => ["2026-03-05", "x", "1.00", 1]);
    expect(() => tableToPdf({ ...small, rows: many as ExportTable["rows"] })).toThrow(/rânduri/);
  });
});
