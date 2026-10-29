/**
 * Potrivirea bon ↔ tranzacție din extras (Faza 7, F7-B; ADR 0019): funcții PURE, deterministe, în
 * întregi (fără float, fără AI). O pereche e candidată DOAR cu suma exactă, aceeași monedă și cel
 * mult 3 zile între date; scorul (0–100) și motivele (coduri fixe) se văd în interfață, decizia o
 * ia utilizatorul.
 *
 * Scorul: suma exactă 30; data: aceeași zi 30, ±1 zi 22, ±2 zile 15, ±3 zile 7; comerciantul: CUI-ul
 * bonului găsit în descrierea tranzacției 40, numele normalizat al comerciantului cuprins în
 * descriere 30, cel puțin un cuvânt semnificativ comun 20, altfel 0. Probabil ≥ 60; ambiguu =
 * cel puțin doi candidați cu diferența dintre primii doi < 15 puncte.
 */

export const MATCH_MAX_DAYS = 3;
export const MATCH_PROBABLE = 60;
export const MATCH_AMBIGUOUS_GAP = 15;

export type MatchReason =
  | "amount_exact"
  | "date_same_day"
  | "date_diff_1"
  | "date_diff_2"
  | "date_diff_3"
  | "merchant_tax_id"
  | "merchant_name"
  | "merchant_partial"
  | "merchant_unknown";

export type ReceiptSide = Readonly<{
  totalMinor: bigint;
  currency: string;
  occurredOn: string;
  merchantName: string | null;
  merchantTaxId: string | null;
}>;

export type TransactionSide = Readonly<{
  amountMinor: bigint;
  currency: string;
  occurredOn: string;
  description: string | null;
  merchant: string | null;
}>;

export type Score = Readonly<{ score: number; reasons: readonly MatchReason[] }>;

const DATE_POINTS = [30, 22, 15, 7] as const;

/** Zilele (întregi) dintre două date `AAAA-LL-ZZ`, în valoare absolută. */
export function dayDistance(a: string, b: string): number {
  const ms = Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`);
  return Math.abs(Math.round(ms / 86_400_000));
}

// Cuvinte fără valoare de identificare (forme juridice, termeni bancari, monede).
const STOP = new Set([
  "srl",
  "sa",
  "sc",
  "snc",
  "pfa",
  "ii",
  "ro",
  "si",
  "de",
  "la",
  "cu",
  "din",
  "the",
  "and",
  "plata",
  "pos",
  "epos",
  "card",
  "visa",
  "mastercard",
  "maestro",
  "tid",
  "valoare",
  "tranzactie",
  "tranzactiei",
  "ron",
  "lei",
  "eur",
  "usd",
  "non",
  "bt",
  "debit",
  "credit",
  "online",
  "comerciant",
  "utilizare",
  "cumparare",
  "magazin",
  "market",
  "store",
  "shop",
]);

/** Textul pliat (fără diacritice, litere mici), doar litere și cifre. */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Cuvintele semnificative ale unui nume de comerciant (≥ 3 litere, fără termeni generici). */
export function merchantTokens(s: string | null): string[] {
  if (!s) return [];
  return foldText(s)
    .split(" ")
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Cifrele CUI-ului (fără `RO`), dacă au cel puțin 4 cifre. */
export function taxDigits(taxId: string | null): string | null {
  if (!taxId) return null;
  const d = taxId.replace(/^RO/i, "").replace(/\D/g, "");
  return d.length >= 4 && d.length <= 10 ? d : null;
}

function merchantScore(r: ReceiptSide, t: TransactionSide): [number, MatchReason] {
  const text = foldText(`${t.description ?? ""} ${t.merchant ?? ""}`);
  const digits = taxDigits(r.merchantTaxId);
  if (digits && new RegExp(`(^|\\D)${digits}(\\D|$)`).test(text)) {
    return [40, "merchant_tax_id"];
  }
  const tokens = merchantTokens(r.merchantName);
  if (tokens.length === 0) return [0, "merchant_unknown"];
  const words = new Set(text.split(" "));
  const full = tokens.join(" ");
  if (full.length >= 4 && ` ${text} `.includes(` ${full} `)) return [30, "merchant_name"];
  if (tokens.some((w) => w.length >= 4 && words.has(w))) return [20, "merchant_partial"];
  return [0, "merchant_unknown"];
}

/** Scorul perechii, sau `null` dacă nu e candidată (sumă/monedă/dată). */
export function scoreMatch(r: ReceiptSide, t: TransactionSide): Score | null {
  if (r.totalMinor <= 0n || t.amountMinor !== r.totalMinor || t.currency !== r.currency)
    return null;
  const d = dayDistance(r.occurredOn, t.occurredOn);
  if (!(d <= MATCH_MAX_DAYS)) return null;
  const [m, reason] = merchantScore(r, t);
  const dateReason: MatchReason = d === 0 ? "date_same_day" : (`date_diff_${d}` as MatchReason);
  return { score: 30 + DATE_POINTS[d]! + m, reasons: ["amount_exact", dateReason, reason] };
}

export type Ranked<T> = Readonly<{ item: T; score: number; reasons: readonly MatchReason[] }>;

/**
 * Candidații ordonați determinist (scor desc., apoi distanța în zile, apoi id) și dacă alegerea e
 * ambiguă (cel puțin doi candidați apropiați ca scor).
 */
export function rankCandidates<T extends TransactionSide & { id: string }>(
  r: ReceiptSide,
  txs: readonly T[],
): { ranked: Ranked<T>[]; ambiguous: boolean } {
  const ranked: Ranked<T>[] = [];
  for (const t of txs) {
    const s = scoreMatch(r, t);
    if (s) ranked.push({ item: t, score: s.score, reasons: s.reasons });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      dayDistance(r.occurredOn, a.item.occurredOn) - dayDistance(r.occurredOn, b.item.occurredOn) ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  const ambiguous = ranked.length >= 2 && ranked[0]!.score - ranked[1]!.score < MATCH_AMBIGUOUS_GAP;
  return { ranked, ambiguous };
}
