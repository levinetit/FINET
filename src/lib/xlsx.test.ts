import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { type ExportTable, assertTable, excelSerial } from "./export-table";
import { columnLetter, crc32, sheetName, tableToXlsx, xmlEscape, xmlSafe } from "./xlsx";

const table: ExportTable = {
  title: "Tranzacții [martie]: 2026/10",
  context: ["Perioada: 2026-03-01 – 2026-03-31", "Gospodăria: Casa"],
  columns: [
    { key: "date", label: "Data", kind: "date" },
    { key: "merchant", label: "Comerciant", kind: "text" },
    { key: "amount", label: "Suma (RON)", kind: "money" },
    { key: "n", label: "Bucăți", kind: "int" },
  ],
  rows: [
    ["2026-03-05", "LIDL & Co <test>", "-12.34", 2],
    ["2026-03-06", '=HYPERLINK("http://x")', "1234567890.50", null],
    [null, "ȘTEFAN \u0001cu\u0000control", "0.00", 1],
  ],
  totals: [null, "Total", "1234567878.16", 3],
};

/** Cititor minimal de ZIP (director central), independent de scriitor în ce privește structura. */
function unzip(buf: Uint8Array): Map<string, string> {
  const b = Buffer.from(buf);
  const eocd = b.length - 22;
  expect(b.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    expect(b.readUInt32LE(p)).toBe(0x02014b50);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28);
    const local = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = b.readUInt16LE(local + 26);
    const data = b.subarray(local + 30 + lnlen, local + 30 + lnlen + csize);
    expect(method).toBe(8);
    const text = inflateRawSync(data);
    expect(text.length).toBe(usize);
    expect(crc32(text)).toBe(crc);
    out.set(name, text.toString("utf8"));
    p += 46 + nlen;
  }
  return out;
}

describe("xlsx: funcții mici", () => {
  it("litera coloanei", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
  });
  it("CRC-32 standard", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("numele foii: fără caractere interzise, ≤ 31, nevid", () => {
    expect(sheetName("Tranzacții [martie]: 2026/10")).toBe("Tranzacții martie 2026 10");
    expect(sheetName("x".repeat(80))).toHaveLength(31);
    expect(sheetName("[]:*?/\\")).toBe("Export");
    expect(sheetName("'ghilimele'")).toBe("ghilimele");
  });
  it("XML: elimină controalele și surogatele singure, scapă simbolurile", () => {
    expect(xmlSafe("a\u0000b\u0001c\u000bd￾e\ud800f\udc00g")).toBe("abcdefg");
    expect(xmlSafe("tab\tnl\ncr\r😀")).toBe("tab\tnl\ncr\r😀");
    expect(xmlEscape('a&b<c>d"e')).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });
  it("seria Excel a datelor", () => {
    expect(excelSerial("2026-03-05")).toBe(46086);
    expect(excelSerial("2000-01-01")).toBe(36526);
  });
});

describe("tableToXlsx", () => {
  const files = unzip(tableToXlsx(table));

  it("conține părțile obligatorii", () => {
    expect([...files.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(files.get("xl/workbook.xml")).toContain('name="Tranzacții martie 2026 10"');
  });

  it("celulele: text inline (formula rămâne text), sume numerice exacte, date ca serii", () => {
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("LIDL &amp; Co &lt;test&gt;");
    expect(sheet).toContain("=HYPERLINK(&quot;http://x&quot;)");
    expect(sheet).toMatch(/<c r="B\d+" s="0" t="inlineStr"><is><t[^>]*>=HYPERLINK/);
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain("<v>-12.34</v>");
    expect(sheet).toContain("<v>1234567890.50</v>");
    expect(sheet).toContain("<v>46086</v>");
    expect(sheet).toContain("ȘTEFAN cucontrol");
    // antet înghețat + filtru pe antet și date
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toMatch(/<autoFilter ref="A5:D8"\/>/);
  });

  it("rândul de totaluri e după date, în afara filtrului", () => {
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toMatch(/<row r="9">.*Total.*<v>1234567878.16<\/v>/);
  });

  it("este determinist", () => {
    expect(Buffer.from(tableToXlsx(table)).equals(Buffer.from(tableToXlsx(table)))).toBe(true);
  });

  it("refuză tabele malformate", () => {
    expect(() => assertTable({ ...table, rows: [["2026-03-05", "x"]] })).toThrow(/celule/);
    expect(() => assertTable({ ...table, rows: [["05.03.2026", "x", "1.00", 1]] })).toThrow(/dată/);
    expect(() => assertTable({ ...table, rows: [["2026-03-05", "x", "1e3", 1]] })).toThrow(/număr/);
    expect(() => assertTable({ ...table, columns: [] })).toThrow(/coloane/);
  });
});

const hasPython =
  spawnSync("python3", ["-c", "import zipfile, xml.etree.ElementTree"]).status === 0;

describe.skipIf(!hasPython)("xlsx: verificare cu un cititor independent (python3)", () => {
  it("arhivul trece testul ZIP, iar toate fișierele XML sunt bine formate", () => {
    const dir = mkdtempSync(join(tmpdir(), "finet-xlsx-"));
    try {
      const file = join(dir, "t.xlsx");
      writeFileSync(file, tableToXlsx(table));
      const out = execFileSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import sys, zipfile, xml.etree.ElementTree as ET",
            "z = zipfile.ZipFile(sys.argv[1])",
            "assert z.testzip() is None",
            "n = 0",
            "for name in z.namelist():",
            "    ET.fromstring(z.read(name)); n += 1",
            "ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}",
            "rows = ET.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//m:row', ns)",
            "print(n, len(rows))",
          ].join("\n"),
          file,
        ],
        { encoding: "utf8" },
      );
      expect(out.trim()).toBe("6 8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
