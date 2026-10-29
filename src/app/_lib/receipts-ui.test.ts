import { describe, expect, it } from "vitest";

import {
  documentErrorText,
  formatTotal,
  highlighted,
  issueText,
  linesDifference,
  moveItem,
  nextPollDelay,
  receiptQueryOf,
  selectionProblem,
  signedLinesSum,
} from "./receipts-ui";

const NBSP = " ";

describe("ajutoarele UI pentru bonuri (F6-C)", () => {
  it("polling blând: 3 s, crește până la 20 s, se oprește după 40 de încercări", () => {
    expect(nextPollDelay(0)).toBe(3000);
    expect(nextPollDelay(1)).toBe(4500);
    expect(nextPollDelay(10)).toBe(20_000);
    expect(nextPollDelay(39)).toBe(20_000);
    expect(nextPollDelay(40)).toBeNull();
    expect(nextPollDelay(-1)).toBeNull();
  });

  it("reordonarea cu butoane (sus/jos), fără ieșire din listă", () => {
    expect(moveItem(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("selecția: 1–4 fișiere; bonul lung 2–4 poze, fără PDF", () => {
    const jpg = { name: "x", type: "image/jpeg", size: 1 };
    const pdf = { name: "y", type: "application/pdf", size: 1 };
    expect(selectionProblem([], false)).toMatch(/cel puțin/);
    expect(selectionProblem([jpg, jpg, jpg, jpg, jpg], false)).toMatch(/4/);
    expect(selectionProblem([jpg], false)).toBeNull();
    expect(selectionProblem([jpg], true)).toMatch(/2 și 4/);
    expect(selectionProblem([jpg, pdf], true)).toMatch(/PDF/);
    expect(selectionProblem([jpg, jpg], true)).toBeNull();
  });

  it("sumele: „0,00 lei”, totalul lipsă „—”, suma liniilor cu reduceri, diferența", () => {
    expect(formatTotal(0, "RON")).toBe(`0,00${NBSP}lei`);
    expect(formatTotal(4590, "RON")).toBe(`45,90${NBSP}lei`);
    expect(formatTotal(null, "RON")).toBe("—");
    expect(
      signedLinesSum([
        { kind: "product", lineTotalMinor: 1000 },
        { kind: "deposit_sgr", lineTotalMinor: 50 },
        { kind: "discount", lineTotalMinor: 200 },
      ]),
    ).toBe(850);
    expect(linesDifference(850, 900)).toBe(-50);
    expect(linesDifference(null, 900)).toBeNull();
  });

  it("problemele: coduri stabile → text fix, cu linia; câmpurile și liniile evidențiate", () => {
    expect(issueText({ code: "total_mismatch", field: "total" })).toMatch(/totalul/);
    expect(issueText({ code: "line_amount_mismatch", line: 3 })).toMatch(/linia 3/);
    expect(issueText({ code: "cod_necunoscut" })).toMatch(/Încredere scăzută/);
    const h = highlighted([
      { code: "total_mismatch", field: "total" },
      { code: "vat_rate_unknown", line: 2 },
    ]);
    expect([...h.fields]).toEqual(["total"]);
    expect([...h.lines]).toEqual([2]);
    expect(documentErrorText("heic_unsupported")).toMatch(/JPEG/);
    expect(documentErrorText("x")).toMatch(/nu a reușit/);
  });

  it("căutarea din URL: doar valori cunoscute, id-uri validate", () => {
    expect(
      receiptQueryOf({
        q: " 45,90 ",
        status: "needs_review",
        categoryId: "nu-e-uuid",
        tagId: "7D5C0F8E-1B2A-4C3D-9E8F-0A1B2C3D4E5F",
        extra: "x",
      }),
    ).toEqual({
      q: "45,90",
      status: "needs_review",
      tagId: "7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f",
    });
    expect(receiptQueryOf({ status: "hack" })).toEqual({});
  });
});
