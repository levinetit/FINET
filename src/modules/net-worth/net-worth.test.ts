import { describe, expect, it } from "vitest";

import {
  type AccountMonthNet,
  type NetWorthAccount,
  type Valuation,
  accountValueAt,
  balanceAt,
  breakdownOf,
  computeNetWorth,
  latestValuation,
  pointOf,
} from "./net-worth";

/** Averea netă (ADR 0046): funcții pure, în bigint. */

const acc = (over: Partial<NetWorthAccount> & { id: string }): NetWorthAccount => ({
  name: over.id,
  type: "bank",
  currency: "RON",
  openingBalanceMinor: 0n,
  archivedAt: null,
  ...over,
});

const accounts: NetWorthAccount[] = [
  acc({ id: "bank", name: "Bancă", openingBalanceMinor: 100000n }),
  acc({ id: "card", name: "Card", type: "credit_card", openingBalanceMinor: -20000n }),
  acc({ id: "flat", name: "Apartament", type: "property", openingBalanceMinor: 0n }),
  acc({ id: "loan", name: "Credit", type: "loan", openingBalanceMinor: -30000000n }),
  acc({ id: "old", name: "Vechi", archivedAt: new Date("2026-01-01"), openingBalanceMinor: 500n }),
];
const nets: AccountMonthNet[] = [
  { accountId: "bank", month: "2026-08", netMinor: 50000n },
  { accountId: "bank", month: "2026-09", netMinor: -10000n },
  { accountId: "bank", month: "2026-10", netMinor: 20000n },
  { accountId: "card", month: "2026-10", netMinor: 5000n },
];
const valuations: Valuation[] = [
  { accountId: "flat", valuedOn: "2026-06-30", valueMinor: 40000000n },
  { accountId: "flat", valuedOn: "2026-09-15", valueMinor: 42000000n },
  { accountId: "loan", valuedOn: "2026-10-01", valueMinor: -29000000n },
];

describe("valoarea unui cont la o dată", () => {
  it("soldul: inițial + netul lunilor ≤ luna datei", () => {
    expect(balanceAt(accounts[0]!, nets, "2026-07-31")).toBe(100000n);
    expect(balanceAt(accounts[0]!, nets, "2026-09-30")).toBe(140000n);
    expect(balanceAt(accounts[0]!, nets, "2026-10-05")).toBe(160000n);
  });

  it("evaluarea cea mai recentă ≤ dată; fără evaluare, soldul", () => {
    expect(latestValuation("flat", valuations, "2026-08-01")?.valueMinor).toBe(40000000n);
    expect(latestValuation("flat", valuations, "2026-09-15")?.valueMinor).toBe(42000000n);
    expect(latestValuation("flat", valuations, "2026-05-01")).toBeNull();
    const flatEarly = accountValueAt(accounts[2]!, valuations, nets, "2026-05-31");
    expect(flatEarly).toMatchObject({ basis: "balance", valueMinor: 0n, valuedOn: null });
    const flatNow = accountValueAt(accounts[2]!, valuations, nets, "2026-10-28");
    expect(flatNow).toMatchObject({
      basis: "valuation",
      valueMinor: 42000000n,
      valuedOn: "2026-09-15",
    });
    // Creditul: soldul inițial până la prima evaluare, apoi evaluarea.
    expect(accountValueAt(accounts[3]!, valuations, nets, "2026-09-30").valueMinor).toBe(
      -30000000n,
    );
    expect(accountValueAt(accounts[3]!, valuations, nets, "2026-10-28").valueMinor).toBe(
      -29000000n,
    );
    // Un cont tranzacțional nu folosește evaluări nici dacă ar exista.
    expect(
      accountValueAt(
        accounts[0]!,
        [{ accountId: "bank", valuedOn: "2026-10-01", valueMinor: 1n }],
        nets,
        "2026-10-28",
      ).basis,
    ).toBe("balance");
  });
});

describe("punctul și gruparea", () => {
  it("activele = valorile pozitive, pasivele = cele negative (în modul), oricare ar fi tipul", () => {
    const values = accounts.map((a) => accountValueAt(a, valuations, nets, "2026-10-28"));
    const p = pointOf(values, "2026-10-28");
    // bank 160.000 + flat 42.000.000 + old 500 = 42.160.500; card −15.000 + loan −29.000.000.
    expect(p.assetsMinor).toBe(42160500n);
    expect(p.liabilitiesMinor).toBe(29015000n);
    expect(p.netMinor).toBe(13145500n);
    const by = breakdownOf(values);
    expect(by.map((b) => [b.type, b.kind, b.valueMinor])).toEqual([
      ["bank", "asset", 160500n],
      ["property", "asset", 42000000n],
      ["credit_card", "liability", -15000n],
      ["loan", "liability", -29000000n],
    ]);
    expect(by[0]!.accounts.map((a) => a.name)).toEqual(["Bancă", "Vechi"]);
    expect(by[0]!.accounts[1]!.archived).toBe(true);
  });
});

describe("averea netă cu istoric", () => {
  it("sfârșiturile de lună, ultimul înlocuit cu azi", () => {
    const n = computeNetWorth({
      currency: "RON",
      asOf: "2026-10-28",
      monthEnds: ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31"],
      accounts,
      valuations,
      nets,
    });
    expect(n.history.map((p) => p.asOf)).toEqual([
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-28",
    ]);
    // Iulie: bank 100.000 + old 500 + flat 40.000.000 − card 20.000 − loan 30.000.000.
    expect(n.history[0]).toMatchObject({
      assetsMinor: 40100500n,
      liabilitiesMinor: 30020000n,
      netMinor: 10080500n,
    });
    expect(n.history[3]).toEqual(n.current);
    expect(n.current.netMinor).toBe(13145500n);
  });

  it("fără conturi: zero", () => {
    const n = computeNetWorth({
      currency: "EUR",
      asOf: "2026-10-28",
      monthEnds: ["2026-10-31"],
      accounts: [],
      valuations: [],
      nets: [],
    });
    expect(n.current).toEqual({
      asOf: "2026-10-28",
      assetsMinor: 0n,
      liabilitiesMinor: 0n,
      netMinor: 0n,
    });
    expect(n.byType).toEqual([]);
  });
});
