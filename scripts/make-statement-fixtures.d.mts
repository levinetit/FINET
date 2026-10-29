// Tipuri pentru scripts/make-statement-fixtures.mjs (folosite de teste).
export type FixtureItem = { p: number; x: number; y: number; w: number; s: string };
export type FixtureLine = {
  occurredOn: string;
  direction: "debit" | "credit";
  amountMinor: string;
  reference: string | null;
  kind?: "fx";
  fxCurrency?: "RON" | "EUR" | "USD";
  fxAmountMinor?: string;
};
export type FixtureExpected = {
  bank: "bt" | "brd" | "raiffeisen" | "revolut";
  currency: "RON" | "EUR" | "USD";
  periodStart: string;
  periodEnd: string;
  openingBalanceMinor: string;
  closingBalanceMinor: string;
  pendingCount: number;
  ibanLast4: string;
  balanceStatus: "ok";
  lines: FixtureLine[];
};
export type StatementFixture = { items: FixtureItem[]; expected: FixtureExpected };
export function buildStatementFixtures(): Record<
  "bt" | "brd" | "raiffeisen" | "revolut",
  StatementFixture
>;
export function serializeItems(items: FixtureItem[]): string;
export function fmtCommaDot(minor: bigint | number): string;
export function fmtDotComma(minor: bigint | number): string;
