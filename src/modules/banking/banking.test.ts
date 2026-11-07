import { describe, expect, it } from "vitest";

import { createMockBankingProvider } from "./mock";
import { availableBankingProviders, bankingProvider, toParsedStatement } from "./provider";

/** Open Banking (ADR 0050): interfața furnizorului, furnizorul mock și maparea în extras. */

describe("registrul furnizorilor", () => {
  it("mock e disponibil; un furnizor neînregistrat aruncă", () => {
    expect(availableBankingProviders()).toContain("mock");
    expect(bankingProvider("mock").id).toBe("mock");
    expect(() => bankingProvider("gocardless")).toThrow("banking_provider_unavailable:gocardless");
  });
});

describe("furnizorul mock", () => {
  it("instituții pe țară, consimțământ pending → authorized, conturi, solduri, tranzacții în fereastră", async () => {
    const p = createMockBankingProvider();
    expect((await p.listInstitutions("ro")).map((i) => i.id)).toEqual(["mock-bank-ro"]);
    const c = await p.createConsent({
      institutionId: "mock-bank-ro",
      redirectUrl: "https://finet.exemplu.ro/banking/return",
      reference: "ref-1",
    });
    expect(c.status).toBe("pending");
    expect(c.authorizeUrl).toContain("ref-1");
    await expect(p.listAccounts(c.id)).rejects.toThrow("banking_consent_not_authorized");
    const authorized = await p.getConsent(c.id);
    expect(authorized.status).toBe("authorized");
    const accounts = await p.listAccounts(c.id);
    expect(accounts.map((a) => a.currency)).toEqual(["RON", "EUR"]);
    expect(accounts[0]!.ibanMasked).toMatch(/^RO\*+1234$/);
    const balances = await p.fetchBalances(c.id, "mock-acc-ron");
    expect(balances.find((b) => b.kind === "booked")?.amountMinor).toBe(326550n);
    const tx = await p.fetchTransactions(c.id, "mock-acc-ron", {
      from: "2026-10-01",
      to: "2026-10-15",
    });
    expect(tx.map((t) => t.id)).toEqual(["mock-tx-1", "mock-tx-2", "mock-tx-3"]);
    await p.revokeConsent(c.id);
    await expect(p.listAccounts(c.id)).rejects.toThrow("banking_consent_not_authorized");
    await expect(
      p.createConsent({ institutionId: "nope", redirectUrl: "x", reference: "r" }),
    ).rejects.toThrow("banking_institution_unknown");
  });
});

describe("maparea în ParsedStatement", () => {
  it("doar confirmate, în moneda contului, fără zero; semnul → direcție; amprenta e stabilă", async () => {
    const p = createMockBankingProvider();
    const c = await p.getConsent(
      (await p.createConsent({ institutionId: "mock-bank-ro", redirectUrl: "x", reference: "r" }))
        .id,
    );
    const account = (await p.listAccounts(c.id))[0]!;
    const window = { from: "2026-10-01", to: "2026-10-31" };
    const tx = await p.fetchTransactions(c.id, account.id, window);
    const closing = (await p.fetchBalances(c.id, account.id)).find((b) => b.kind === "booked")!;
    const r = toParsedStatement({
      providerId: "mock",
      account,
      window,
      transactions: tx,
      closingBalance: closing,
    });
    expect(r.pendingSkipped).toBe(1);
    expect(r.zeroSkipped).toBe(1);
    expect(r.currencyMismatches).toBe(0);
    expect(r.parsed).toMatchObject({
      bank: "generic",
      format: "csv",
      parserVersion: 1,
      currency: "RON",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      closingBalanceMinor: 326550n,
      pendingCount: 1,
      zeroCount: 1,
      ibanLast4: "1234",
    });
    expect(
      r.parsed.lines.map((l) => [l.rowNo, l.direction, l.amountMinor, l.bankReference]),
    ).toEqual([
      [1, "credit", 500000n, "mock-tx-1"],
      [2, "debit", 150000n, "mock-tx-2"],
      [3, "debit", 23450n, "mock-tx-3"],
    ]);
    expect(r.parsed.lines[2]!.description).toBe("LIDL · POS LIDL");
    expect(r.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    const again = toParsedStatement({
      providerId: "mock",
      account,
      window,
      transactions: tx,
      closingBalance: closing,
    });
    expect(again.sourceSha256).toBe(r.sourceSha256);
    const other = toParsedStatement({
      providerId: "mock",
      account,
      window: { from: "2026-10-01", to: "2026-10-15" },
      transactions: tx.slice(0, 3),
    });
    expect(other.sourceSha256).not.toBe(r.sourceSha256);
    expect(other.parsed.closingBalanceMinor).toBeNull();
  });

  it("tranzacțiile în altă monedă decât contul se numără și se exclud", () => {
    const r = toParsedStatement({
      providerId: "mock",
      account: { id: "a", ibanMasked: "RO**1111", name: null, currency: "RON" },
      window: { from: "2026-10-01", to: "2026-10-31" },
      transactions: [
        {
          id: "t1",
          bookingDate: "2026-10-02",
          valueDate: null,
          currency: "EUR",
          amountMinor: -100n,
          description: "x",
          counterparty: null,
          pending: false,
        },
        {
          id: "t2",
          bookingDate: "2026-10-01",
          valueDate: null,
          currency: "RON",
          amountMinor: -200n,
          description: "y",
          counterparty: null,
          pending: false,
        },
      ],
    });
    expect(r.currencyMismatches).toBe(1);
    expect(r.parsed.lines).toHaveLength(1);
    expect(r.parsed.warnings).toEqual([
      "banking_currency_mismatch",
      "banking_no_declared_balances",
    ]);
  });
});
