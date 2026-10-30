/**
 * Ajutoarele interfeței «Rapoarte inteligente» (Faza 10, F10-B; ADR 0023), comune serverului și
 * browserului. Funcții pure, fără React: procentele vin ca întregi în puncte de bază (1 pb =
 * 0,01 %) și se scriu prin șiruri (fără împărțiri), sumele prin `formatMinor` (bigint în
 * `money.ts`), niciodată float.
 */

import { type Currency, isCurrency } from "@/lib/money";
import { REPORT_PERIODS, type ReportPeriod } from "@/lib/periods";
import { ro } from "@/messages/ro";

import { formatMinor } from "./ledger-ui";

/** Puncte de bază → procent românesc cu semn: `1250` → `+12,50 %`, `-123` → `−1,23 %`, `0` → `0,00 %`. */
export function formatBps(bps: number, options: Readonly<{ sign?: boolean }> = {}): string {
  const digits = String(Math.abs(Math.trunc(bps))).padStart(3, "0");
  const text = `${digits.slice(0, -2)},${digits.slice(-2)} %`;
  if (bps < 0) return `−${text}`;
  return options.sign && bps > 0 ? `+${text}` : text;
}

/** Cantitatea în miimi → text românesc fără zerouri inutile: `3000` → `3`, `1254` → `1,254`. */
export function formatPieces(milli: number): string {
  const digits = String(Math.abs(Math.trunc(milli))).padStart(4, "0");
  const frac = digits.slice(-3).replace(/0+$/, "");
  const text = frac === "" ? digits.slice(0, -3) : `${digits.slice(0, -3)},${frac}`;
  return milli < 0 ? `−${text}` : text;
}

export type PriceUnit = "kg" | "l" | "buc" | "unit";

/** `4,20 lei / kg` (sau doar suma pentru «unitatea de pe bon»). */
export function formatUnitPrice(amountMinor: number, currency: Currency, unit: PriceUnit): string {
  const text = formatMinor(amountMinor, currency);
  return unit === "unit" ? text : `${text} / ${unit === "buc" ? "buc" : unit}`;
}

/** `?period=` validat (lipsa sau o valoare necunoscută → toată arhiva). */
export function pickPeriod(raw: string | string[] | undefined): ReportPeriod {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (REPORT_PERIODS as readonly string[]).includes(value ?? "")
    ? (value as ReportPeriod)
    : "all";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un id din URL: uuid valid sau `null` (un parametru invalid se ignoră, nu strică pagina). */
export function pickId(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && UUID.test(value) ? value.toLowerCase() : null;
}

/** Textul unei căutări din URL: scurt, fără caractere de control. */
export function pickText(raw: string | string[] | undefined, max: number): string {
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

export function pickCurrency(raw: string | string[] | undefined): Currency {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isCurrency(value) ? value : "RON";
}

export type InsightsQuery = Readonly<{
  report?: string | null;
  period?: ReportPeriod;
  copy?: string | null;
  q?: string;
  product?: string;
  currency?: Currency;
  months?: number;
  baseline?: "previous" | "year_ago";
}>;

/** Adresa paginii cu parametrii dați (doar cei nenuli; ordinea fixă, deci adrese stabile). */
export function insightsHref(query: InsightsQuery, hash?: string): string {
  const params = new URLSearchParams();
  if (query.report) params.set("report", query.report);
  if (query.period && query.period !== "all") params.set("period", query.period);
  if (query.copy) params.set("copy", query.copy);
  if (query.q) params.set("q", query.q);
  if (query.product) params.set("product", query.product);
  if (query.currency && query.currency !== "RON") params.set("cur", query.currency);
  if (query.months && query.months !== 3) params.set("im", String(query.months));
  if (query.baseline && query.baseline !== "year_ago") params.set("ib", query.baseline);
  const search = params.toString();
  return `/insights${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`;
}

export function periodLabel(period: ReportPeriod): string {
  return ro.insights.periods[period];
}

/** Exportul CSV al unui raport (cale API, dialect românesc). */
export function reportExportPath(id: string, period: ReportPeriod): string {
  const params = new URLSearchParams();
  if (period !== "all") params.set("period", period);
  params.set("dialect", "ro");
  return `/api/v1/report-definitions/${id}/export.csv?${params.toString()}`;
}
