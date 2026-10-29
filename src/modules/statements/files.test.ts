import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { checkBalances } from "./balances";
import { parseCsv } from "./csv";
import { readStatementUpload } from "./files";
import { cellAmount, cellDate, mapTable, suggestMapping } from "./mapping";
import { buildXlsx, buildZip, itemsToPdf } from "./testing";
import { StatementError } from "./types";
import { parseXlsx } from "./xlsx";
import { readZip } from "./zip";

/** Codul erorii (sau `null`). */
function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof StatementError) return e.code;
    throw e;
  }
}

const CSV_RO = [
  "Data;Descriere;Debit;Credit;Sold",
  "03.11.2026;Plata Kaufland;87,14;;1.912,86",
  '04.11.2026;"Rambursare; cina";;25,00;1.937,86',
  '04.11.2026;=HYPERLINK("http://exemplu.invalid");10,00;;1.927,86',
  ";Sold final;;;1.927,86",
].join("\r\n");

describe("CSV", () => {
  it("UTF-8 cu BOM, `;`, ghilimele cu delimitator în interior", () => {
    const t = parseCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CSV_RO)]));
    expect(t.delimiter).toBe(";");
    expect(t.rows[0]).toEqual(["Data", "Descriere", "Debit", "Credit", "Sold"]);
    expect(t.rows[2]![1]).toBe("Rambursare; cina");
    expect(t.rows).toHaveLength(5);
  });

  it("Windows-1250 (diacritice românești vechi) și UTF-16 LE cu BOM", () => {
    // „Plată” în Windows-1250: ă = 0xE3.
    const cp = Buffer.from([...Buffer.from("Data,Descriere\n01.11.2026,Plat"), 0xe3, 0x0a]);
    expect(parseCsv(cp).rows[1]![1]).toBe("Plată");
    const u16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("a,b,c\n1,2,3\n", "utf16le"),
    ]);
    expect(parseCsv(u16).rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("refuză binar (NUL), ghilimele neînchise, prea multe coloane/rânduri", () => {
    expect(code(() => parseCsv(Buffer.from([0x61, 0x00, 0x62])))).toBe("csv_invalid");
    expect(code(() => parseCsv(Buffer.from('a;"b\n1;2')))).toBe("csv_invalid");
    expect(code(() => parseCsv(Buffer.from(Array(60).fill("x").join(";"))))).toBe("csv_invalid");
    expect(code(() => parseCsv(Buffer.from("a\n".repeat(10_002))))).toBe("too_many_lines");
    expect(code(() => parseCsv(Buffer.alloc(6 * 1024 * 1024, 0x61)))).toBe("file_too_large");
  });

  it("mapare debit/credit: sume exacte, sold verificat, formula păstrată ca TEXT", () => {
    const t = parseCsv(Buffer.from(CSV_RO));
    const s = suggestMapping(t);
    expect(s.missing).toEqual([]);
    expect(s.mapping).toMatchObject({
      date: 0,
      debit: 2,
      credit: 3,
      balance: 4,
      decimal: ",",
      thousands: ".",
    });
    const parsed = mapTable(t, s.mapping, { currency: "RON", format: "csv" });
    expect(parsed.lines.map((l) => [l.direction, l.amountMinor])).toEqual([
      ["debit", 8714n],
      ["credit", 2500n],
      ["debit", 1000n],
    ]);
    expect(parsed.warnings).toContain("rows_skipped");
    expect(parsed.openingBalanceMinor).toBe(200_000n);
    expect(checkBalances(parsed).status).toBe("ok");
    // Celula care începe cu `=` rămâne text (nu se evaluează); exportul o prefixează.
    expect(parsed.lines[2]!.description.startsWith("=HYPERLINK")).toBe(true);
  });

  it("maparea invalidă sau incompletă e refuzată; rândul cu dată dar fără sumă e corupt", () => {
    const t = parseCsv(Buffer.from(CSV_RO));
    const base = {
      headerRow: 0,
      date: 0,
      dateFormat: "dmy_dot",
      decimal: ",",
      thousands: ".",
      description: [1],
    };
    expect(code(() => mapTable(t, { ...base }, { currency: "RON", format: "csv" }))).toBe(
      "csv_mapping_invalid",
    );
    expect(
      code(() =>
        mapTable(
          t,
          { ...base, amount: 2, debit: 2, credit: 3 },
          { currency: "RON", format: "csv" },
        ),
      ),
    ).toBe("csv_mapping_invalid");
    expect(
      code(() =>
        mapTable(
          t,
          { ...base, decimal: ".", thousands: ".", amount: 2 },
          { currency: "RON", format: "csv" },
        ),
      ),
    ).toBe("csv_mapping_invalid");
    const broken = parseCsv(Buffer.from("Data;Descriere;Suma\n03.11.2026;x;\n"));
    expect(
      code(() => mapTable(broken, { ...base, amount: 2 }, { currency: "RON", format: "csv" })),
    ).toBe("corrupt_row");
  });

  it("monedă diferită de a contului → refuz; ordinea „cele mai noi întâi” se inversează", () => {
    const t = parseCsv(
      Buffer.from("Data,Suma,Moneda,Descriere\n05.11.2026,-1.50,RON,b\n03.11.2026,2.00,RON,a\n"),
    );
    const m = {
      headerRow: 0,
      date: 0,
      dateFormat: "dmy_dot",
      amount: 1,
      currency: 2,
      decimal: ".",
      thousands: "",
      description: [3],
    };
    const p = mapTable(t, m, { currency: "RON", format: "csv" });
    expect(p.lines.map((l) => l.occurredOn)).toEqual(["2026-11-03", "2026-11-05"]);
    expect(code(() => mapTable(t, m, { currency: "EUR", format: "csv" }))).toBe(
      "currency_mismatch",
    );
  });

  it("șablonul Wise e recunoscut și marcat NEVERIFICAT", () => {
    const t = parseCsv(
      Buffer.from(
        '"TransferWise ID",Date,Amount,Currency,Description,"Running Balance"\nTRANSFER-1,03-11-2026,-12.50,EUR,"Card transaction",87.50\n',
      ),
    );
    const s = suggestMapping(t);
    expect(s.template).toEqual({ bank: "wise", verified: false });
    const p = mapTable(t, s.mapping, { currency: "EUR", format: "csv", bank: "wise" });
    expect(p.lines[0]).toMatchObject({
      direction: "debit",
      amountMinor: 1250n,
      bankReference: "TRANSFER-1",
    });
    expect(p.openingBalanceMinor).toBe(10_000n);
  });
});

describe("formatele de sumă și dată ale mapării", () => {
  it.each([
    ["1.234,56", ",", ".", 123456n],
    ["-1 234,56", ",", " ", -123456n],
    ["(12,00)", ",", "", -1200n],
    ["12,5", ",", "", 1250n],
    ["1,234.56", ".", ",", 123456n],
    ["5,00 RON", ",", "", 500n],
  ] as const)("%s (zecimal %s, mii %j)", (text, d, t, v) => {
    expect(cellAmount(text, d, t)).toBe(v);
  });
  it("refuză formele ambigue/greșite în CSV; XLSX rotunjește reprezentarea double pe șir", () => {
    expect(code(() => cellAmount("1.234", ",", ""))).toBe("invalid_amount");
    expect(code(() => cellAmount("1,234", ",", ""))).toBe("invalid_amount");
    expect(code(() => cellAmount("1.2345", ".", ""))).toBe("invalid_amount");
    expect(code(() => cellAmount("12a", ".", ""))).toBe("invalid_amount");
    expect(cellAmount("12.300000000000001", ".", "", 15)).toBe(1230n);
    expect(cellAmount("0.105", ".", "", 15)).toBe(11n);
    expect(cellAmount("", ".", "")).toBeNull();
  });
  it("datele, inclusiv seria Excel", () => {
    expect(cellDate("03.11.2026", "dmy_dot")).toBe("2026-11-03");
    expect(cellDate("2026-11-03 10:15", "ymd_dash")).toBe("2026-11-03");
    expect(cellDate("46329", "excel_serial")).toBe("2026-11-03");
    expect(code(() => cellDate("31.11.2026", "dmy_dot"))).toBe("invalid_date");
    expect(code(() => cellDate("03/11/2026", "dmy_dot"))).toBe("invalid_date");
  });
});

describe("XLSX", () => {
  const rows = [
    ["Data", "Descriere", "Suma"],
    [46329, "Kaufland", -87.14],
    [46330, "=1+1", 25],
  ];

  it("citește foaia: șiruri partajate, numere, fără evaluarea formulelor", () => {
    const t = parseXlsx(buildXlsx(rows));
    expect(t.rows[1]).toEqual(["46329", "Kaufland", "-87.14"]);
    expect(t.rows[2]![1]).toBe("=1+1");
    const p = mapTable(
      t,
      {
        headerRow: 0,
        date: 0,
        dateFormat: "excel_serial",
        amount: 2,
        decimal: ".",
        thousands: "",
        description: [1],
      },
      { currency: "RON", format: "xlsx" },
    );
    expect(p.lines.map((l) => [l.occurredOn, l.direction, l.amountMinor])).toEqual([
      ["2026-11-03", "debit", 8714n],
      ["2026-11-04", "credit", 2500n],
    ]);
  });

  it("refuză DOCTYPE/ENTITY (XXE, billion laughs), macro-uri, legături externe", () => {
    const xxe = '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>';
    expect(code(() => parseXlsx(buildXlsx(rows, [], xxe)))).toBe("xlsx_unsafe");
    expect(code(() => parseXlsx(buildXlsx(rows, [{ name: "xl/vbaProject.bin", data: "x" }])))).toBe(
      "xlsx_unsafe",
    );
    expect(
      code(() =>
        parseXlsx(buildXlsx(rows, [{ name: "xl/externalLinks/externalLink1.xml", data: "<x/>" }])),
      ),
    ).toBe("xlsx_unsafe");
    expect(
      code(() => parseXlsx(buildXlsx(rows, [{ name: "docProps/x.xml", data: "<!ENTITY a 'b'>" }]))),
    ).toBe("xlsx_unsafe");
  });

  it("refuză coloane peste plafon, prea multe foi, ZIP fără workbook", () => {
    const wide = [Array.from({ length: 51 }, () => "x")];
    // Coloana 51 („AY”) depășește plafonul de 50.
    const sheet = `<row r="1"><c r="AY1" t="inlineStr"><is><t>x</t></is></c></row>`;
    const xl = buildXlsx(wide.slice(0, 0), [], "");
    expect(xl.length).toBeGreaterThan(0);
    const z = buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
      },
    ]);
    expect(code(() => parseXlsx(z))).toBe("xlsx_unsafe");
    const many = buildXlsx(
      rows,
      Array.from({ length: 21 }, (_, i) => ({
        name: `xl/worksheets/sheet${i + 2}.xml`,
        data: "<worksheet/>",
      })),
    );
    expect(code(() => parseXlsx(many))).toBe("xlsx_unsafe");
    expect(code(() => parseXlsx(buildZip([{ name: "a.xml", data: "<a/>" }])))).toBe("xlsx_invalid");
  });
});

describe("XLSX adversarial (ReDoS, plafoane în timpul parcurgerii)", () => {
  const zipOf = (sheet: string, sst = "<sst/>") =>
    buildZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "xl/workbook.xml", data: "<workbook/>" },
      { name: "xl/sharedStrings.xml", data: sst },
      { name: "xl/worksheets/sheet1.xml", data: sheet },
    ]);
  const timed = (bytes: Buffer) => {
    const t = Date.now();
    const c = code(() => parseXlsx(bytes));
    return { c, ms: Date.now() - t };
  };

  it.each([
    ["100k `<si>` neînchise", zipOf("<worksheet/>", `<sst>${"<si><t>x".repeat(100_000)}</sst>`)],
    [
      "`<row` fără `</row>`",
      zipOf(`<worksheet><sheetData>${'<row r="1"><c r="A1"><v>1</v></c>'.repeat(50_000)}`),
    ],
    [
      "`<c` imbricate adânc",
      zipOf(`<worksheet><sheetData><row>${"<c>".repeat(200_000)}</row></sheetData></worksheet>`),
    ],
    ["tag fără `>`", zipOf(`<worksheet><sheetData><row ${"a".repeat(1_000_000)}`)],
    ["prea multe `<si>` închise", zipOf("<worksheet/>", `<sst>${"<si/>".repeat(200_001)}</sst>`)],
  ] as const)("%s → refuz rapid", (_l, bytes) => {
    const { c, ms } = timed(bytes);
    expect(["xlsx_invalid", "xlsx_unsafe"]).toContain(c);
    expect(ms).toBeLessThan(2_000);
  });

  it("foaia sau șirurile partajate peste 8 MB decomprimat → refuz", () => {
    const big = `<worksheet><sheetData>${" ".repeat(9 * 1024 * 1024)}</sheetData></worksheet>`;
    expect(timed(zipOf(big)).c).toBe("xlsx_unsafe");
  });
});

describe("ZIP malițios", () => {
  const ok = (name = "a.csv", data = "Data;Suma\n03.11.2026;1,00\n") => ({ name, data });

  it("ZIP normal cu două extrase: fiecare fișier tratat separat (CSV + PDF)", () => {
    const pdf = itemsToPdf([{ p: 1, x: 10, y: 10, w: 10, s: "x" }]);
    const parts = readStatementUpload(buildZip([ok(), { name: "dir/b.pdf", data: pdf }]));
    expect(parts.map((p) => p.kind)).toEqual(["table", "pdf"]);
  });

  it.each([
    ["traversare de cale", [ok("../evil.csv")]],
    ["cale absolută", [ok("/etc/x.csv")]],
    ["backslash", [ok("a\\b.csv")]],
    ["literă de unitate", [ok("C:x.csv")]],
    ["nume duplicate (majuscule)", [ok("A.csv"), ok("a.csv")]],
    ["criptat", [{ ...ok(), flags: 0x0001 }]],
    ["legătură simbolică", [{ ...ok(), external: (0o120777 << 16) >>> 0 }]],
    ["ZIP imbricat", [{ name: "inner.zip", data: buildZip([ok()]) }]],
    ["XLSX într-un ZIP", [{ name: "x.xlsx", data: buildXlsx([["a", "b", "c"]]) }]],
    ["prea multe intrări", Array.from({ length: 21 }, (_, i) => ok(`f${i}.csv`))],
    ["mărime declarată mai mică (bombă)", [{ ...ok(), declaredSize: 3 }]],
    ["intrări suprapuse", [ok("a.csv"), { ...ok("b.csv"), sameDataAs: 0 }]],
    ["mărime stocată inconsistentă", [{ ...ok(), method: 0, declaredSize: 1 }]],
  ] as const)("%s → refuz", (_label, specs) => {
    expect(["zip_unsafe", "zip_invalid"]).toContain(code(() => readZip(buildZip(specs))));
  });

  it("bombă de decompresie (raport uriaș) → `zip_unsafe` fără a decomprima tot", () => {
    const bomb = Buffer.alloc(30 * 1024 * 1024, 0);
    expect(deflateRawSync(bomb).length).toBeLessThan(100_000);
    expect(code(() => readZip(buildZip([{ name: "z.csv", data: bomb }])))).toBe("zip_unsafe");
  });

  it("CRC greșit → `zip_invalid`; arhivă trunchiată → `zip_invalid`", () => {
    expect(code(() => readZip(buildZip([{ ...ok(), crc: 1 }])))).toBe("zip_invalid");
    const z = buildZip([ok()]);
    expect(code(() => readZip(z.subarray(0, z.length - 30)))).toBe("zip_invalid");
  });

  it("tipul se stabilește după conținut, nu după nume", () => {
    const parts = readStatementUpload(
      buildZip([{ name: "extras.pdf", data: "Data;Suma\n03.11.2026;1,00\n" }]),
    );
    expect(parts[0]).toMatchObject({ kind: "table", format: "csv" });
    expect(code(() => readStatementUpload(Buffer.alloc(21 * 1024 * 1024)))).toBe("file_too_large");
  });

  it("un ZIP cu o arhivă imbricată dă `zip_unsafe` (nu eroarea XLSX), ca mesajul afișat să fie corect", () => {
    const nested = buildZip([
      { name: "inner.zip", data: buildZip([{ name: "a.csv", data: "x" }]) },
    ]);
    expect(code(() => readStatementUpload(nested))).toBe("zip_unsafe");
  });
});
