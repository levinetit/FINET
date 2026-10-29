import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type StatementFixture,
  buildStatementFixtures,
  fmtCommaDot,
  fmtDotComma,
  serializeItems,
} from "../../../scripts/make-statement-fixtures.mjs";

import { checkBalances } from "./balances";
import { detectBank, parsePdfItems } from "./detect";
import { parseStatementAmount, parseRoDate, repairRaiffeisen } from "./text";
import { StatementError, type TextItem } from "./types";

const BANKS = ["bt", "brd", "raiffeisen", "revolut"] as const;
const DIR = join(process.cwd(), "fixtures/statements");

function load(bank: (typeof BANKS)[number]): StatementFixture {
  return {
    items: JSON.parse(readFileSync(join(DIR, bank, "items.json"), "utf8")),
    expected: JSON.parse(readFileSync(join(DIR, bank, "expected.json"), "utf8")),
  };
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof StatementError) return e.code;
    throw e;
  }
}

describe("fixture-urile sintetice", () => {
  it("fișierele din repo sunt exact ieșirea generatorului (determinist)", () => {
    const built = buildStatementFixtures();
    for (const bank of BANKS) {
      // Conținutul (nu formatarea: prettier rescrie JSON-ul) e exact ieșirea generatorului.
      expect(JSON.parse(readFileSync(join(DIR, bank, "items.json"), "utf8")), bank).toEqual(
        JSON.parse(serializeItems(built[bank].items)),
      );
      expect(JSON.parse(readFileSync(join(DIR, bank, "expected.json"), "utf8"))).toEqual(
        built[bank].expected,
      );
    }
  });
});

describe.each(BANKS)("parserul %s pe fixture-ul sintetic", (bank) => {
  const { items, expected } = load(bank);

  it("detectează banca și citește antetul, soldurile și rândurile", () => {
    expect(detectBank(items)).toBe(bank);
    const s = parsePdfItems(items);
    expect(s).toMatchObject({
      bank,
      format: "pdf",
      currency: expected.currency,
      periodStart: expected.periodStart,
      periodEnd: expected.periodEnd,
      openingBalanceMinor: BigInt(expected.openingBalanceMinor),
      closingBalanceMinor: BigInt(expected.closingBalanceMinor),
      pendingCount: expected.pendingCount,
      ibanLast4: expected.ibanLast4,
    });
    expect(s.lines).toHaveLength(expected.lines.length);
    s.lines.forEach((line, i) => {
      const e = expected.lines[i]!;
      expect(line.rowNo).toBe(i + 1);
      expect(line.occurredOn).toBe(e.occurredOn);
      expect(line.direction).toBe(e.direction);
      expect(line.amountMinor).toBe(BigInt(e.amountMinor));
      expect(line.bankReference).toBe(e.reference);
      expect(line.kind).toBe(e.kind ?? "movement");
      if (e.kind === "fx") {
        expect(line.fxCurrency).toBe(e.fxCurrency);
        expect(line.fxAmountMinor).toBe(e.fxAmountMinor ? BigInt(e.fxAmountMinor) : null);
      }
      expect(line.description.length).toBeGreaterThan(0);
      expect(line.description.length).toBeLessThanOrEqual(500);
      // Fără IBAN-uri și numere de card în descrierea stocată.
      expect(line.description).not.toMatch(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){4}/);
      expect(line.description).not.toMatch(/\*{4,}|X{4} X{4}/);
    });
    const b = checkBalances(s);
    expect(b).toMatchObject({ status: "ok", reasons: [] });
    expect(b.computedClosingMinor).toBe(BigInt(expected.closingBalanceMinor));
  });

  it("sold final declarat greșit → `mismatch` cu motiv (nu se salvează tăcut)", () => {
    const s = parsePdfItems(items);
    const b = checkBalances({ ...s, closingBalanceMinor: s.closingBalanceMinor! + 1n });
    expect(b.status).toBe("mismatch");
    expect(b.reasons).toContain("closing_balance");
  });

  it("un rând lipsă (o sumă coruptă) e prins de verificarea soldurilor sau refuzat", () => {
    // Prima apariție a sumei celui de-al doilea rând (ancora lui, nu un rând de sumar).
    const fmt = bank === "bt" || bank === "raiffeisen" ? fmtCommaDot : fmtDotComma;
    const target = fmt(BigInt(expected.lines[1]!.amountMinor));
    const amountIdx = items.findIndex((i) => i.s.replace(/ RON$/, "") === target);
    expect(amountIdx).toBeGreaterThanOrEqual(0);
    const broken: TextItem[] = items.map((i, idx) =>
      idx === amountIdx ? { ...i, s: i.s.replace(/\d(?=\D*$)/, "x") } : i,
    );
    let status: string;
    try {
      status = checkBalances(parsePdfItems(broken)).status;
    } catch (e) {
      status = (e as StatementError).code;
    }
    expect(["mismatch", "corrupt_row", "invalid_amount"]).toContain(status);
  });

  it("antet necunoscut → `unknown_bank`; elemente goale → `empty_statement`", () => {
    const anon = items.map((i) => ({ ...i, s: i.p === 1 ? "lorem" : i.s }));
    expect(code(() => parsePdfItems(anon))).toBe("unknown_bank");
    expect(code(() => parsePdfItems([]))).toBe("empty_statement");
  });
});

describe("cazuri specifice", () => {
  it("antete de la două bănci pe prima pagină → `ambiguous_bank` (fail-closed)", () => {
    const mixed = [...load("bt").items, ...load("brd").items.map((i) => ({ ...i, p: 1 }))];
    expect(code(() => detectBank(mixed))).toBe("ambiguous_bank");
  });

  it("BT: tranzacțiile în așteptare (SUME BLOCATE, peste o pagină) nu se importă, se numără", () => {
    const s = parsePdfItems(load("bt").items);
    expect(s.pendingCount).toBe(3);
    expect(s.warnings).toContain("pending_skipped");
    // Round Up-ul are aceeași referință ca plata (REF nu e unic la BT).
    const refs = s.lines.map((l) => l.bankReference);
    expect(refs[1]).toBe(refs[2]);
    // Două rânduri identice în aceeași zi rămân două rânduri.
    expect(s.lines[3]).toMatchObject({ amountMinor: 1500n, occurredOn: "2026-11-04" });
    expect(s.lines[4]).toMatchObject({ amountMinor: 1500n, occurredOn: "2026-11-04" });
    expect(s.lines[3]!.description).toBe(s.lines[4]!.description);
    expect(s.dayBalances).toHaveLength(3);
  });

  it("BT: o pagină lipsă (extrasul zilei rupt) → refuz sau `mismatch`", () => {
    const items = load("bt").items.filter((i) => i.p !== 3);
    let result: string;
    try {
      result = checkBalances(parsePdfItems(items)).status;
    } catch (e) {
      result = (e as StatementError).code;
    }
    expect(["corrupt_row", "mismatch"]).toContain(result);
  });

  it("BT: un extras al cărui SOLD ANTERIOR nu continuă soldul precedent → `balance_chain_break`", () => {
    const items = load("bt").items;
    // Al doilea `SOLD ANTERIOR`: valoarea de pe același rând.
    const labels = items.filter((i) => i.s === "SOLD ANTERIOR");
    const second = labels[1]!;
    const value = items.find((i) => i.p === second.p && Math.abs(i.y - second.y) < 1 && i.x > 500)!;
    const changed = items.map((i) => (i === value ? { ...i, s: "9,999.99" } : i));
    const s = parsePdfItems(changed);
    expect(s.warnings).toContain("balance_chain_break");
    expect(checkBalances(s).reasons).toContain("balance_chain_break");
  });

  it("BT: două sume pe un rând cu descriere → `corrupt_row`", () => {
    const items = load("bt").items;
    const anchor = items.find((i) => i.s === "Transfer intern")!;
    const extra = { ...anchor, x: 430, w: 22, s: "1.00" };
    expect(code(() => parsePdfItems([...items, extra]))).toBe("corrupt_row");
  });

  it("BRD: descrierea care continuă pe pagina următoare rămâne la rândul ei", () => {
    const s = parsePdfItems(load("brd").items);
    const rent = s.lines.find((l) => l.amountMinor === 120000n)!;
    expect(rent.description).toContain("Chirie octombrie");
    expect(rent.description).not.toContain("BRD-Groupe");
    expect(s.declaredDebitMinor).toBe(checkBalances(s).debitTotalMinor);
  });

  it("Raiffeisen: encodarea fontului e reparată după detectare; schimbul valutar e marcat", () => {
    const s = parsePdfItems(load("raiffeisen").items);
    expect(s.lines[0]!.kind).toBe("fx");
    expect(s.lines[0]!.fxCurrency).toBe("EUR");
    expect(s.lines[0]!.fxAmountMinor).toBeNull();
    expect(s.lines[2]!.description).toContain("utilizării");
    expect(s.dayBalances.length).toBeGreaterThan(0);
    expect(repairRaiffeisen("Dat` ini]ial Bucure[ti")).toBe("Dată inițial București");
  });

  it("Revolut: ID tranzacție = referința; schimbul valutar are suma în EUR", () => {
    const s = parsePdfItems(load("revolut").items);
    const fx = s.lines.find((l) => l.kind === "fx")!;
    expect(fx).toMatchObject({ fxCurrency: "EUR", fxAmountMinor: 1000n, direction: "debit" });
    expect(s.lines.every((l) => l.balanceAfterMinor !== null)).toBe(true);
    // Soldul pe rând greșit → `row_balance`.
    const lines = s.lines.map((l, i) => (i === 1 ? { ...l, balanceAfterMinor: 1n } : l));
    expect(checkBalances({ ...s, lines }).reasons).toContain("row_balance");
  });

  it("caracterele de control/NUL din text sunt eliminate înainte de parsare", () => {
    const items = load("revolut").items.map((i) =>
      i.s === "Spotify" ? { ...i, s: "Spo\u0000ti‮fy" } : i,
    );
    const s = parsePdfItems(items);
    expect(s.lines.some((l) => l.description.includes("\u0000"))).toBe(false);
    expect(s.lines.some((l) => l.description.startsWith("Spotify"))).toBe(true);
  });
});

describe("formatele explicite de sumă și dată", () => {
  it.each([
    ["1,234.56", "comma_dot", 123456n],
    ["0.51", "comma_dot", 51n],
    ["1.234,56", "dot_comma", 123456n],
    ["12,00", "dot_comma", 1200n],
  ] as const)("%s (%s) → %s", (text, style, minor) => {
    expect(parseStatementAmount(text, style, "RON")).toBe(minor);
  });

  it.each([
    ["1.234,56", "comma_dot"],
    ["1,234.56", "dot_comma"],
    ["1.004", "comma_dot"],
    ["1,004", "dot_comma"],
    ["12.5", "comma_dot"],
    ["1,23,456.00", "comma_dot"],
    ["-5.00", "comma_dot"],
    ["", "comma_dot"],
    ["99,999,999,999,999.00", "comma_dot"],
  ] as const)("refuză %j în stilul %s", (text, style) => {
    expect(code(() => parseStatementAmount(text, style, "RON"))).toBe("invalid_amount");
  });

  it("datele românești Revolut și datele imposibile", () => {
    expect(parseRoDate("3 nov. 2026")).toBe("2026-11-03");
    expect(parseRoDate("1 octombrie 2026")).toBe("2026-10-01");
    expect(parseRoDate("28 sept. 2026")).toBe("2026-09-28");
    expect(code(() => parseRoDate("31 nov. 2026"))).toBe("invalid_date");
    expect(code(() => parseRoDate("3 foo. 2026"))).toBe("invalid_date");
  });
});
