import { describe, expect, it } from "vitest";

import {
  formatBps,
  formatPieces,
  formatUnitPrice,
  insightsHref,
  pickCurrency,
  pickId,
  pickPeriod,
  pickText,
  reportExportPath,
} from "./insights-ui";

describe("formatarea procentelor din puncte de bază", () => {
  it("fără împărțiri float: semn, virgulă zecimală, zero", () => {
    expect(formatBps(1250)).toBe("12,50 %");
    expect(formatBps(1250, { sign: true })).toBe("+12,50 %");
    expect(formatBps(-123)).toBe("−1,23 %");
    expect(formatBps(0, { sign: true })).toBe("0,00 %");
    expect(formatBps(5)).toBe("0,05 %");
    expect(formatBps(100000)).toBe("1000,00 %");
  });
  it("cantitatea în miimi", () => {
    expect(formatPieces(3000)).toBe("3");
    expect(formatPieces(1254)).toBe("1,254");
    expect(formatPieces(500)).toBe("0,5");
    expect(formatPieces(0)).toBe("0");
  });
  it("prețul pe unitate", () => {
    expect(formatUnitPrice(2400, "RON", "kg")).toMatch(/24,00\s*lei \/ kg$/);
    expect(formatUnitPrice(115, "RON", "l")).toMatch(/1,15\s*lei \/ l$/);
    expect(formatUnitPrice(699, "RON", "unit")).toMatch(/6,99\s*lei$/);
  });
});

describe("parametrii din URL", () => {
  it("perioada: validă sau toată arhiva", () => {
    expect(pickPeriod("this_month")).toBe("this_month");
    expect(pickPeriod(["last_month", "x"])).toBe("last_month");
    expect(pickPeriod("ieri")).toBe("all");
    expect(pickPeriod(undefined)).toBe("all");
  });
  it("id-urile și textele se validează, nu se încred", () => {
    expect(pickId("00000000-0000-4000-8000-00000000000A")).toBe(
      "00000000-0000-4000-8000-00000000000a",
    );
    expect(pickId("nu-e-uuid")).toBeNull();
    expect(pickId(undefined)).toBeNull();
    expect(pickText("  lapte\u0000\n zuzu  ", 20)).toBe("lapte zuzu");
    expect(pickText("x".repeat(500), 10)).toHaveLength(10);
    expect(pickCurrency("EUR")).toBe("EUR");
    expect(pickCurrency("XYZ")).toBe("RON");
  });
  it("adrese stabile, doar parametrii nenuli", () => {
    expect(insightsHref({})).toBe("/insights");
    expect(insightsHref({ report: "a", period: "all" })).toBe("/insights?report=a");
    expect(insightsHref({ report: "a", period: "this_year" }, "rapoarte")).toBe(
      "/insights?report=a&period=this_year#rapoarte",
    );
    expect(
      insightsHref({ product: "l|lapte", currency: "EUR", months: 6, baseline: "previous" }),
    ).toBe("/insights?product=l%7Clapte&cur=EUR&im=6&ib=previous");
  });
  it("calea exportului CSV", () => {
    expect(reportExportPath("abc", "all")).toBe(
      "/api/v1/report-definitions/abc/export.csv?dialect=ro",
    );
    expect(reportExportPath("abc", "this_year")).toBe(
      "/api/v1/report-definitions/abc/export.csv?period=this_year&dialect=ro",
    );
  });
});
