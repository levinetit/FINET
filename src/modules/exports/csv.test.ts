import { describe, expect, it } from "vitest";

import { money } from "@/lib/money";

import { CSV_BOM, csvHeader, csvRow, decimal, neutralize, raw, text } from "./csv";

describe("CSV (RFC 4180 + protecție contra injecției)", () => {
  it("ghilimele doar când e nevoie; ghilimelele interioare se dublează; CRLF", () => {
    expect(csvRow([text("simplu"), text("a,b"), text('zis "așa"'), text("rând\nnou")])).toBe(
      'simplu,"a,b","zis ""așa""","rând\nnou"\r\n',
    );
    expect(csvRow([text(null), raw(null), raw(0), raw(12n)])).toBe(",,0,12\r\n");
    expect(csvHeader(["id", "amount"])).toBe("id,amount\r\n");
    expect(CSV_BOM).toBe("﻿");
  });

  it.each([
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ["+40 721", "'+40 721"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTAB", "'\tTAB"],
    ["\rCR", "'\rCR"],
    ["Lidl", "Lidl"],
    [" =spațiu în față", " =spațiu în față"],
  ])("text liber %j → %j", (input, output) => {
    expect(neutralize(input)).toBe(output);
  });

  it("formula cu virgule și ghilimele: neutralizată ȘI pusă între ghilimele", () => {
    expect(csvRow([text('=HYPERLINK("http://x","y")')])).toBe(
      '"\'=HYPERLINK(""http://x"",""y"")"\r\n',
    );
  });

  it("valorile generate nu se prefixează: suma negativă rămâne număr; dialectul ro", () => {
    const m = money(-1234n, "RON");
    expect(csvRow([decimal(m), raw("-1234")])).toBe("-12.34,-1234\r\n");
    expect(csvRow([decimal(m, "ro"), text("a;b"), text("x,y")], "ro")).toBe('-12,34;"a;b";x,y\r\n');
    expect(csvRow([decimal(money(5n, "EUR"))])).toBe("0.05\r\n");
  });

  it("un dialect necunoscut (defensă) cade pe virgulă, nu produce `undefined`", () => {
    const row = csvRow([raw("a"), text("b,c")], "xx" as never);
    expect(row).toBe('a,"b,c"\r\n');
  });
});
