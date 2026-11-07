import { createHash } from "node:crypto";

import type { CalendarDate } from "@/lib/calendar";
import { type Currency, isCurrency } from "@/lib/money";
import type { ParsedLine, ParsedStatement } from "@/modules/statements/types";

/**
 * Open Banking (modernizare 2026, pasul L; ADR 0050): interfața MODULARĂ a unui furnizor PSD2
 * (agregator licențiat: GoCardless Bank Account Data, Salt Edge, Enable Banking, Tink…), astfel
 * încât nucleul financiar să nu cunoască API-ul niciunui furnizor. Fluxul: instituții → consimțământ
 * (OAuth/redirect la bancă, 90–180 de zile) → conturi → tranzacții și solduri. Tranzacțiile NU
 * intră direct în registru: devin un `ParsedStatement` (banca `generic`, format `csv`) și trec prin
 * același flux de previzualizare, deduplicare (`bankReference`) și confirmare ca extrasele (ADR 0018).
 *
 * Fără scraping: doar furnizori autorizați. În acest branch există DOAR furnizorul `mock`
 * (determinist, pentru teste și demo); furnizorul real, cheile, tabela de consimțăminte și
 * sincronizarea programată vin după alegerea operatorului (docs/research/open-banking-ro-eu.md).
 */

export const BANKING_PROVIDER_IDS = ["mock", "gocardless", "saltedge", "enablebanking"] as const;
export type BankingProviderId = (typeof BANKING_PROVIDER_IDS)[number];

export type Institution = Readonly<{
  id: string;
  name: string;
  /** Țara ISO 3166-1 alpha-2 (`RO`). */
  country: string;
  /** Cât ține consimțământul la această bancă (zile), dacă furnizorul o spune. */
  consentDays: number | null;
  logoUrl: string | null;
}>;

export type ConsentRequest = Readonly<{
  institutionId: string;
  /** Unde revine utilizatorul după autorizarea la bancă (URL-ul aplicației). */
  redirectUrl: string;
  /** Referința noastră opacă (fără date personale), ca furnizorul s-o întoarcă la redirect. */
  reference: string;
}>;

export type Consent = Readonly<{
  id: string;
  institutionId: string;
  status: "pending" | "authorized" | "expired" | "revoked";
  authorizeUrl: string | null;
  expiresAt: string | null;
}>;

export type BankAccount = Readonly<{
  id: string;
  /** IBAN-ul mascat (doar ultimele 4 caractere în clar) — nu se stochează întreg. */
  ibanMasked: string;
  name: string | null;
  currency: Currency;
}>;

export type BankBalance = Readonly<{
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  /** `booked` (contabil) sau `available` (disponibil). */
  kind: "booked" | "available";
  referenceDate: CalendarDate;
}>;

export type BankTransaction = Readonly<{
  /** Id-ul stabil al furnizorului/băncii (pentru deduplicare la reimport). */
  id: string;
  bookingDate: CalendarDate;
  valueDate: CalendarDate | null;
  currency: Currency;
  /** Semnată: pozitivă = intrare, negativă = ieșire. */
  amountMinor: bigint;
  description: string;
  counterparty: string | null;
  /** Tranzacție în așteptare (neconfirmată): nu se importă. */
  pending: boolean;
}>;

export type FetchWindow = Readonly<{ from: CalendarDate; to: CalendarDate }>;

export type BankingProvider = Readonly<{
  id: BankingProviderId;
  listInstitutions(country: string): Promise<readonly Institution[]>;
  createConsent(input: ConsentRequest): Promise<Consent>;
  getConsent(consentId: string): Promise<Consent>;
  revokeConsent(consentId: string): Promise<void>;
  listAccounts(consentId: string): Promise<readonly BankAccount[]>;
  fetchBalances(consentId: string, accountId: string): Promise<readonly BankBalance[]>;
  fetchTransactions(
    consentId: string,
    accountId: string,
    window: FetchWindow,
  ): Promise<readonly BankTransaction[]>;
}>;

/** Registrul furnizorilor: cei reali se înregistrează doar când există chei (ADR 0050). */
const registry = new Map<BankingProviderId, () => BankingProvider>();

export function registerBankingProvider(
  id: BankingProviderId,
  factory: () => BankingProvider,
): void {
  registry.set(id, factory);
}

export function bankingProvider(id: BankingProviderId): BankingProvider {
  const factory = registry.get(id);
  if (!factory) throw new Error(`banking_provider_unavailable:${id}`);
  return factory();
}

export function availableBankingProviders(): BankingProviderId[] {
  return [...registry.keys()];
}

/** Versiunea „parserului” pentru importurile Open Banking (în intervalul acceptat de serviciu). */
export const BANKING_PARSER_VERSION = 1;
export const BANKING_MAX_LINES = 5000;

export type MappingResult = Readonly<{
  parsed: ParsedStatement;
  /** Amprenta stabilă a lotului (furnizor, cont, fereastră, id-uri), în locul SHA-256 al unui fișier. */
  sourceSha256: string;
  pendingSkipped: number;
  zeroSkipped: number;
  currencyMismatches: number;
}>;

/**
 * Tranzacțiile furnizorului → `ParsedStatement` (banca `generic`, format `csv`): rândurile în
 * ordinea datei, doar cele confirmate, în moneda contului; `bankReference` = id-ul furnizorului
 * (deduplicarea la reimport o face serviciul extraselor). Soldurile declarate lipsesc (`null`):
 * verificarea soldului e `unknown`, ca la CSV-urile mapate.
 */
export function toParsedStatement(
  input: Readonly<{
    providerId: BankingProviderId;
    account: BankAccount;
    window: FetchWindow;
    transactions: readonly BankTransaction[];
    closingBalance?: BankBalance | null;
  }>,
): MappingResult {
  if (!isCurrency(input.account.currency)) throw new Error("banking_unsupported_currency");
  const confirmed = input.transactions.filter((t) => !t.pending);
  const pendingSkipped = input.transactions.length - confirmed.length;
  const sameCurrency = confirmed.filter((t) => t.currency === input.account.currency);
  const currencyMismatches = confirmed.length - sameCurrency.length;
  const nonZero = sameCurrency.filter((t) => t.amountMinor !== 0n);
  const zeroSkipped = sameCurrency.length - nonZero.length;
  const sorted = [...nonZero].sort(
    (a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id),
  );
  if (sorted.length > BANKING_MAX_LINES) throw new Error("banking_too_many_lines");
  const lines: ParsedLine[] = sorted.map((t, i) => ({
    rowNo: i + 1,
    occurredOn: t.bookingDate,
    direction: t.amountMinor < 0n ? "debit" : "credit",
    amountMinor: t.amountMinor < 0n ? -t.amountMinor : t.amountMinor,
    description: [t.counterparty, t.description]
      .filter((x): x is string => !!x)
      .join(" · ")
      .slice(0, 500),
    bankReference: t.id.slice(0, 100),
    kind: "movement",
    fxAmountMinor: null,
    fxCurrency: null,
    balanceAfterMinor: null,
  }));
  const hash = createHash("sha256");
  hash.update(
    `${input.providerId}\n${input.account.id}\n${input.window.from}\n${input.window.to}\n`,
  );
  for (const l of lines) hash.update(`${l.bankReference}\n`);
  const closing =
    input.closingBalance && input.closingBalance.kind === "booked"
      ? input.closingBalance.amountMinor
      : null;
  return {
    parsed: {
      bank: "generic",
      format: "csv",
      parserVersion: BANKING_PARSER_VERSION,
      currency: input.account.currency,
      periodStart: input.window.from,
      periodEnd: input.window.to,
      openingBalanceMinor: null,
      closingBalanceMinor: closing,
      declaredDebitMinor: null,
      declaredCreditMinor: null,
      dayBalances: [],
      lines,
      pendingCount: pendingSkipped,
      zeroCount: zeroSkipped,
      ibanLast4: input.account.ibanMasked.slice(-4),
      warnings: [
        ...(currencyMismatches > 0 ? ["banking_currency_mismatch"] : []),
        "banking_no_declared_balances",
      ],
    },
    sourceSha256: hash.digest("hex"),
    pendingSkipped,
    zeroSkipped,
    currencyMismatches,
  };
}
