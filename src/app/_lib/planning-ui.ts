/**
 * Ajutoarele interfeței de planificare (F3-C): luni, date, comparații, scalarea graficelor și
 * adresele exporturilor. Funcții pure, comune serverului și browserului, fără `Intl` dependent de
 * locale-ul serverului (lunile vin din `ro.planning.months`, datele se compun din cifre) și fără
 * float pe sume: scalarea trece prin `percentOf` din `src/lib/money.ts` (doar `bigint`).
 */

import { type Month, addMonths, isMonth } from "@/lib/calendar";
import { type Currency, formatMoney, fromJson, isNegative, negate, percentOf } from "@/lib/money";
import { ro } from "@/messages/ro";

// ---------------------------------------------------------------------------------------------
// Luni (ADR 0007: de la 60 de luni în urmă până la luna curentă inclusiv)
// ---------------------------------------------------------------------------------------------

/**
 * Câte luni în urmă acceptă paginile. Aceeași valoare ca `MONTH_WINDOW_BACK` din API (verificat
 * în `planning-ui.test.ts`), dar fără a importa modulul de server în browser.
 */
export const MONTH_WINDOW_BACK = 60;

/** Câte luni oferă selectorul (cea curentă inclusiv). */
export const MONTH_SELECTOR_COUNT = 12;

/** `2026-10` → `octombrie 2026`. Valorile invalide se întorc neschimbate. */
export function formatMonth(month: string): string {
  if (!isMonth(month)) return month;
  const [y, m] = month.split("-");
  return `${ro.planning.months[Number(m) - 1]} ${y}`;
}

/** `2026-10` → `oct` (axa graficului lunar). */
export function formatMonthAbbr(month: string): string {
  if (!isMonth(month)) return month;
  return ro.planning.months[Number(month.slice(5)) - 1]!.slice(0, 3);
}

/** Ultimele `count` luni, de la cea curentă spre trecut (pentru selector). */
export function monthOptions(current: Month, count = MONTH_SELECTOR_COUNT): Month[] {
  return Array.from({ length: count }, (_, i) => addMonths(current, -i));
}

/**
 * Luna din `?month=`: validă (format strict, în fereastra de 60 de luni, fără viitor) sau luna
 * curentă cu `invalid: true` (pagina arată un mesaj, nu o eroare). Lipsa parametrului nu e eroare.
 */
export function pickMonth(
  raw: string | string[] | undefined,
  current: Month,
): Readonly<{ month: Month; invalid: boolean }> {
  if (raw === undefined || raw === "") return { month: current, invalid: false };
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof value !== "string" ||
    !isMonth(value) ||
    value > current ||
    value < addMonths(current, -MONTH_WINDOW_BACK)
  ) {
    return { month: current, invalid: true };
  }
  return { month: value, invalid: false };
}

// ---------------------------------------------------------------------------------------------
// Sume
// ---------------------------------------------------------------------------------------------

/** Valoarea absolută formatată (de exemplu „Depășire: 12,00 lei”), prin `money.ts`. */
export function formatAbsMinor(amountMinor: number, currency: Currency): string {
  const m = fromJson({ amountMinor, currency });
  return formatMoney(isNegative(m) ? negate(m) : m);
}

// ---------------------------------------------------------------------------------------------
// Date (master prompt 5.3: `25.10.2026`)
// ---------------------------------------------------------------------------------------------

/** `2026-10-25` → `25.10.2026` (din cifre, fără fus și fără locale). */
export function formatDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
}

/** `2026-10-25` → `25.10` (etichetele scurte ale graficului zilnic). */
export function formatDayShort(value: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[2]}.${m[1]}` : value;
}

/** `2026-10` → `10.2026`. */
export function formatMonthShort(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${m[2]}.${m[1]}` : month;
}

// ---------------------------------------------------------------------------------------------
// Comparația cu luna anterioară
// ---------------------------------------------------------------------------------------------

export type DeltaJson = Readonly<{ diffMinor: number; percent: number | null }>;
export type DeltaView = Readonly<{
  direction: "up" | "down" | "flat" | "none";
  /** `+12%`, `−5%`, `0%` sau `—` (fără comparație: luna anterioară are 0). */
  text: string;
}>;

/** Săgeata și procentul unei comparații (procentul vine rotunjit de la server). */
export function deltaView(delta: DeltaJson): DeltaView {
  if (delta.percent === null) return { direction: "none", text: ro.dashboard.noComparison };
  if (delta.diffMinor > 0) return { direction: "up", text: `+${Math.abs(delta.percent)}%` };
  if (delta.diffMinor < 0) return { direction: "down", text: `−${Math.abs(delta.percent)}%` };
  return { direction: "flat", text: "0%" };
}

/**
 * Comparația numărului de tranzacții (un număr, nu o sumă): procentul ca la sume
 * (`percentOf`, rotunjire `half_away`, `null` dacă luna anterioară are 0).
 */
export function countDelta(current: number, previous: number): DeltaJson {
  const diff = current - previous;
  return { diffMinor: diff, percent: percentOf(BigInt(diff), BigInt(previous), "half_away") };
}

// ---------------------------------------------------------------------------------------------
// Grafice: scalare în întregi
// ---------------------------------------------------------------------------------------------

/**
 * Lungimea unei bare pe o scară 0–100 (`viewBox`): `floor(|valoare| × 100 / max)` calculat cu
 * `percentOf` (bigint), limitat la 100. O valoare nenulă primește cel puțin 1, ca să se vadă.
 * Maximul 0 (totul zero) dă 0.
 */
export function barLength(valueMinor: number, maxMinor: number): number {
  const v = BigInt(valueMinor < 0 ? -valueMinor : valueMinor);
  const max = BigInt(maxMinor < 0 ? -maxMinor : maxMinor);
  const pct = percentOf(v, max, "floor");
  if (pct === null) return 0;
  const capped = pct > 100 ? 100 : pct;
  return v > 0n && capped === 0 ? 1 : capped;
}

/** Cea mai mare valoare absolută dintr-o listă de sume (întregi JSON), 0 pentru o listă goală. */
export function maxAbs(values: readonly number[]): number {
  let max = 0;
  for (const v of values) {
    const a = v < 0 ? -v : v;
    if (a > max) max = a;
  }
  return max;
}

/** Progresul unei bare (buget, obiectiv) pe 0–100: procentul întreg limitat la [0, 100]. */
export function progressLength(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return percent > 100 ? 100 : Math.trunc(percent);
}

// ---------------------------------------------------------------------------------------------
// Exporturi
// ---------------------------------------------------------------------------------------------

export type ExportKind = "transactions" | "goals" | "budgets";

/**
 * Adresa unui export CSV, mereu cu `dialect=ro` (`;`, virgulă zecimală, BOM; decizia
 * coordonatorului). `search` sunt parametrii deja validați (fără `sort`/`cursor`/`limit`).
 */
export function exportPath(
  kind: ExportKind,
  search: Readonly<Record<string, string>> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== "") params.set(key, value);
  }
  params.set("dialect", "ro");
  return `/api/v1/exports/${kind}.csv?${params.toString()}`;
}
