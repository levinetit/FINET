import { readFileSync, readdirSync } from "node:fs";
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

/**
 * Revizuirea F7-A: marcajele de secțiune scrise de plătitor în DETALIILE unei tranzacții (rânduri
 * de continuare, la x-ul descrierii) nu schimbă modul, perioada, moneda sau soldurile: rămân text
 * al descrierii. Pentru fiecare bancă se înlocuiește un rând de detalii cu fiecare marcaj.
 */
describe("marcaje de secțiune în descrierea controlată de plătitor", () => {
  const CASES: Record<(typeof BANKS)[number], { target: string; markers: string[] }> = {
    bt: {
      target: "tranzactie: 87.14 RON",
      markers: [
        "SUME BLOCATE",
        "RULAJ ZI",
        "SOLD FINAL ZI",
        "SOLD FINAL CONT",
        "SOLD ANTERIOR",
        "RULAJ TOTAL CONT",
        "TOTAL DISPONIBIL",
        "EXTRAS CONT din 01/01/2020",
        "Cod IBAN: RO00TEST",
      ],
    },
    brd: {
      target: "EXEMPLU SOFT SRL",
      markers: [
        "Sold final / End balance",
        "Sold initial / Start balance",
        "Total debit / Total credit",
        "De la / From 01/01/2020 La / To 02/01/2020",
        "Valuta / Currency EUR",
        "Data oper. Debit Credit",
      ],
    },
    raiffeisen: {
      target: "EXEMPLU ANA",
      markers: [
        "Sold final 1.00",
        "Soldul zilei: 01.11.2026 1.00",
        "Perioada: de la 01.01.2020 la 02.01.2020",
        "Valuta: EUR",
        "Prezentul extras are valoare",
      ],
    },
    revolut: {
      target: "Către: Spotify, Stockholm, SWE",
      markers: [
        "Tranzacții în așteptare",
        "Tranzacții din cont de la 1 ianuarie 2020 până la 2 ianuarie 2020",
        "Extras EUR",
        "Total 1,00 RON 1,00 RON",
        "Revolut Bank UAB este autorizată",
      ],
    },
  };

  for (const bank of BANKS) {
    const { target, markers } = CASES[bank];
    it.each(markers)(`${bank}: „%s” rămâne descriere`, (marker) => {
      const { items, expected } = load(bank);
      expect(items.some((i) => i.s === target)).toBe(true);
      const s = parsePdfItems(items.map((i) => (i.s === target ? { ...i, s: marker } : i)));
      expect(s.lines.length).toBe(expected.lines.length);
      expect(s.periodStart).toBe(expected.periodStart);
      expect(s.periodEnd).toBe(expected.periodEnd);
      expect(s.currency).toBe(expected.currency);
      expect(String(s.openingBalanceMinor)).toBe(expected.openingBalanceMinor);
      expect(String(s.closingBalanceMinor)).toBe(expected.closingBalanceMinor);
      expect(s.pendingCount).toBe(expected.pendingCount);
      expect(checkBalances(s).status).toBe("ok");
    });
  }

  it("Revolut: un PDF cu a doua secțiune în altă monedă → `multi_currency_statement`", () => {
    const { items } = load("revolut");
    const second = items.map((i) => ({ ...i, p: 2, s: i.s === "Extras RON" ? "Extras EUR" : i.s }));
    expect(code(() => parsePdfItems([...items, ...second]))).toBe("multi_currency_statement");
  });
});

describe("fixture-urile nu conțin IBAN-uri valide (mod-97)", () => {
  const valid = (iban: string) => {
    const s = iban.replace(/\s/g, "").toUpperCase();
    const r = s.slice(4) + s.slice(0, 4);
    let m = 0n;
    for (const ch of r) {
      const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      m = BigInt(`${m}${v}`) % 97n;
    }
    return m === 1n;
  };

  it("niciun șir de forma unui IBAN din fixtures, generator și testele extraselor nu trece mod-97", () => {
    const texts = [
      readFileSync(join(process.cwd(), "scripts/make-statement-fixtures.mjs"), "utf8"),
    ];
    for (const bank of BANKS) texts.push(readFileSync(join(DIR, bank, "items.json"), "utf8"));
    // Și fișierele `.ts` ale modulului (revizuirea F7-B, m4), fără deosebire de majuscule.
    const mod = join(process.cwd(), "src/modules/statements");
    for (const f of readdirSync(mod).filter((n) => n.endsWith(".ts"))) {
      texts.push(readFileSync(join(mod, f), "utf8"));
    }
    const found = texts.flatMap(
      (t) => t.match(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/gi) ?? [],
    );
    expect(found.length).toBeGreaterThan(3);
    expect(found.filter(valid)).toEqual([]);
    // Controlul funcției: un IBAN public de exemplu (valid) trece; compus din bucăți, ca textul
    // acestui fișier să nu conțină un IBAN valid.
    expect(valid(["GB82", "WEST", "1234", "5698", "7654", "32"].join(" "))).toBe(true);
  });
});
