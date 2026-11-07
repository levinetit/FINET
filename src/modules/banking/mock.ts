import type {
  BankAccount,
  BankBalance,
  BankTransaction,
  BankingProvider,
  Consent,
  ConsentRequest,
  FetchWindow,
  Institution,
} from "./provider";
import { registerBankingProvider } from "./provider";

/**
 * Furnizorul `mock` (ADR 0050): determinist, fără rețea, cu două instituții fictive și un cont
 * cu tranzacții sintetice (nu sunt date reale). Pentru teste, demo și pentru a dovedi că nucleul
 * nu depinde de un furnizor anume. Consimțământul se „autorizează” la `getConsent` după creare.
 */

export const MOCK_INSTITUTIONS: readonly Institution[] = [
  { id: "mock-bank-ro", name: "Banca Fictivă RO", country: "RO", consentDays: 90, logoUrl: null },
  { id: "mock-bank-eu", name: "Fictive Bank EU", country: "DE", consentDays: 180, logoUrl: null },
];

const ACCOUNTS: readonly BankAccount[] = [
  { id: "mock-acc-ron", ibanMasked: "RO**************1234", name: "Cont curent", currency: "RON" },
  { id: "mock-acc-eur", ibanMasked: "RO**************5678", name: "Economii EUR", currency: "EUR" },
];

/** Tranzacțiile sintetice ale contului RON: salariu, chirie, cumpărături, una în așteptare. */
const TRANSACTIONS: readonly BankTransaction[] = [
  {
    id: "mock-tx-1",
    bookingDate: "2026-10-01",
    valueDate: "2026-10-01",
    currency: "RON",
    amountMinor: 500000n,
    description: "Salariu octombrie",
    counterparty: "ANGAJATOR SRL",
    pending: false,
  },
  {
    id: "mock-tx-2",
    bookingDate: "2026-10-05",
    valueDate: "2026-10-05",
    currency: "RON",
    amountMinor: -150000n,
    description: "Chirie",
    counterparty: "PROPRIETAR",
    pending: false,
  },
  {
    id: "mock-tx-3",
    bookingDate: "2026-10-12",
    valueDate: "2026-10-12",
    currency: "RON",
    amountMinor: -23450n,
    description: "POS LIDL",
    counterparty: "LIDL",
    pending: false,
  },
  {
    id: "mock-tx-4",
    bookingDate: "2026-10-20",
    valueDate: null,
    currency: "RON",
    amountMinor: -9900n,
    description: "POS in asteptare",
    counterparty: "CARREFOUR",
    pending: true,
  },
  {
    id: "mock-tx-5",
    bookingDate: "2026-10-25",
    valueDate: "2026-10-25",
    currency: "RON",
    amountMinor: 0n,
    description: "Comision zero",
    counterparty: null,
    pending: false,
  },
];

export function createMockBankingProvider(): BankingProvider {
  const consents = new Map<string, Consent>();
  let seq = 0;
  return {
    id: "mock",
    async listInstitutions(country) {
      return MOCK_INSTITUTIONS.filter((i) => i.country === country.toUpperCase());
    },
    async createConsent(input: ConsentRequest) {
      if (!MOCK_INSTITUTIONS.some((i) => i.id === input.institutionId)) {
        throw new Error("banking_institution_unknown");
      }
      const id = `mock-consent-${++seq}`;
      const consent: Consent = {
        id,
        institutionId: input.institutionId,
        status: "pending",
        authorizeUrl: `https://bank.invalid/authorize?ref=${encodeURIComponent(input.reference)}&redirect=${encodeURIComponent(input.redirectUrl)}`,
        expiresAt: "2027-01-28",
      };
      consents.set(id, consent);
      return consent;
    },
    async getConsent(consentId) {
      const c = consents.get(consentId);
      if (!c) throw new Error("banking_consent_unknown");
      // Simulare: la prima citire după creare, banca a autorizat.
      const authorized: Consent =
        c.status === "pending" ? { ...c, status: "authorized", authorizeUrl: null } : c;
      consents.set(consentId, authorized);
      return authorized;
    },
    async revokeConsent(consentId) {
      const c = consents.get(consentId);
      if (!c) throw new Error("banking_consent_unknown");
      consents.set(consentId, { ...c, status: "revoked", authorizeUrl: null });
    },
    async listAccounts(consentId) {
      const c = consents.get(consentId);
      if (!c || c.status !== "authorized") throw new Error("banking_consent_not_authorized");
      return ACCOUNTS;
    },
    async fetchBalances(consentId, accountId) {
      const c = consents.get(consentId);
      if (!c || c.status !== "authorized") throw new Error("banking_consent_not_authorized");
      const acc = ACCOUNTS.find((a) => a.id === accountId);
      if (!acc) throw new Error("banking_account_unknown");
      const balances: BankBalance[] = [
        {
          accountId,
          currency: acc.currency,
          amountMinor: acc.currency === "RON" ? 326550n : 120000n,
          kind: "booked",
          referenceDate: "2026-10-28",
        },
        {
          accountId,
          currency: acc.currency,
          amountMinor: acc.currency === "RON" ? 316650n : 120000n,
          kind: "available",
          referenceDate: "2026-10-28",
        },
      ];
      return balances;
    },
    async fetchTransactions(consentId, accountId, window: FetchWindow) {
      const c = consents.get(consentId);
      if (!c || c.status !== "authorized") throw new Error("banking_consent_not_authorized");
      if (!ACCOUNTS.some((a) => a.id === accountId)) throw new Error("banking_account_unknown");
      if (accountId !== "mock-acc-ron") return [];
      return TRANSACTIONS.filter((t) => t.bookingDate >= window.from && t.bookingDate <= window.to);
    },
  };
}

registerBankingProvider("mock", createMockBankingProvider);
