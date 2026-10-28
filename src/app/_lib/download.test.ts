import { describe, expect, it } from "vitest";

import { ro } from "@/messages/ro";

import { exportErrorMessage, filenameOf } from "./download";

describe("descărcarea exporturilor CSV", () => {
  it("numele fișierului din Content-Disposition, cu rezervă", () => {
    expect(filenameOf('attachment; filename="finet-tranzactii.csv"', "x.csv")).toBe(
      "finet-tranzactii.csv",
    );
    expect(filenameOf(null, "finet-bugete.csv")).toBe("finet-bugete.csv");
    // Un nume cu caractere neașteptate (căi, ghilimele) nu se folosește.
    expect(filenameOf('attachment; filename="../../etc/passwd"', "rezerva.csv")).toBe(
      "rezerva.csv",
    );
  });

  it("mesaje clare pentru plafon (409) și rate limit (429)", () => {
    expect(exportErrorMessage(409, "export_too_large", null)).toBe(ro.exports.tooLarge);
    expect(exportErrorMessage(429, undefined, null)).toBe(ro.exports.rateLimited);
    expect(exportErrorMessage(429, undefined, 30)).toBe(ro.exports.rateLimitedRetry(30));
    expect(exportErrorMessage(0, undefined, null)).toBe(ro.ledger.errors.network);
    expect(exportErrorMessage(500, undefined, null)).toBe(ro.exports.error);
    expect(exportErrorMessage(409, "altceva", null)).toBe(ro.exports.error);
  });
});
