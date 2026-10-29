import { type AmountStyle, type Row, centre, fold, isAmount } from "./text";
import { StatementError, type TextItem } from "./types";

/**
 * Coloanele unui tabel de extras, deduse din poziția antetelor (ADR 0018). Sumele sunt aliniate
 * la dreapta, deci x-ul din stânga variază cu lungimea; o sumă se atribuie coloanei cu CENTRUL
 * cel mai apropiat de centrul ei (x + w/2), în limita `MAX_COLUMN_DISTANCE`.
 */

export type Columns = Readonly<{ debit: number; credit: number; balance: number | null }>;

const MAX_COLUMN_DISTANCE = 90;

/** Centrul primului fragment al rândului al cărui text pliat începe cu una dintre etichete. */
function labelCentre(row: Row, labels: readonly string[]): number | null {
  for (const it of row.items) {
    const t = fold(it.s);
    if (labels.some((l) => t === l || t.startsWith(`${l} `))) return centre(it);
  }
  return null;
}

/** Antetul tabelului: rândul care conține TOATE etichetele obligatorii. */
export function findColumns(
  row: Row,
  debitLabels: readonly string[],
  creditLabels: readonly string[],
  balanceLabels: readonly string[] = [],
): Columns | null {
  const debit = labelCentre(row, debitLabels);
  const credit = labelCentre(row, creditLabels);
  if (debit === null || credit === null || !(credit > debit)) return null;
  const balance = balanceLabels.length ? labelCentre(row, balanceLabels) : null;
  return { debit, credit, balance };
}

export type ColumnName = "debit" | "credit" | "balance";

/** Coloana unei sume (sau `null` dacă e prea departe de orice antet). */
export function columnOf(item: TextItem, cols: Columns): ColumnName | null {
  const c = centre(item);
  const candidates: [ColumnName, number][] = [
    ["debit", Math.abs(c - cols.debit)],
    ["credit", Math.abs(c - cols.credit)],
  ];
  if (cols.balance !== null) candidates.push(["balance", Math.abs(c - cols.balance)]);
  candidates.sort((a, b) => a[1] - b[1]);
  const [best] = candidates;
  return best && best[1] <= MAX_COLUMN_DISTANCE ? best[0] : null;
}

/** Fragmentele-sumă ale unui rând (în stilul băncii), cu suffix-ul de monedă tolerat. */
export function amountItems(
  row: Row,
  style: AmountStyle,
  suffix: RegExp | null = null,
): TextItem[] {
  return row.items.filter((i) => isAmount(stripSuffix(i.s, suffix), style));
}

export function stripSuffix(s: string, suffix: RegExp | null): string {
  return suffix ? s.replace(suffix, "").trim() : s.trim();
}

/** Primul rând (după indexul dat) care satisface `pred`. */
export function findRow(rows: readonly Row[], pred: (r: Row) => boolean, from = 0): number {
  for (let i = from; i < rows.length; i++) if (pred(rows[i]!)) return i;
  return -1;
}

/** Rândul conține un fragment al cărui text pliat începe cu eticheta. */
export function hasLabel(row: Row, label: string): boolean {
  return row.items.some((i) => {
    const t = fold(i.s);
    return t === label || t.startsWith(label);
  });
}

/**
 * Valoarea unei etichete de sold („SOLD FINAL ZI”): suma de pe același rând sau, dacă lipsește
 * (sumele aliniate la dreapta ajung uneori pe un y vecin), cea de pe cel mai apropiat rând
 * vecin de pe aceeași pagină care conține DOAR o sumă, la cel mult `maxDy` unități. Rândurile
 * folosite se marchează, ca o valoare să nu fie atribuită de două ori.
 */
export function labelValue(
  rows: readonly Row[],
  index: number,
  style: AmountStyle,
  used: Set<number>,
  maxDy = 12,
  suffix: RegExp | null = null,
): TextItem | null {
  const row = rows[index]!;
  const own = amountItems(row, style, suffix);
  if (own.length >= 1) return own[own.length - 1]!;
  let best: { i: number; dy: number } | null = null;
  for (const j of [index - 1, index + 1, index - 2, index + 2]) {
    const r = rows[j];
    if (!r || r.p !== row.p || used.has(j)) continue;
    const amounts = amountItems(r, style, suffix);
    if (amounts.length !== 1 || r.items.length !== 1) continue;
    const dy = Math.abs(r.y - row.y);
    if (dy <= maxDy && (!best || dy < best.dy)) best = { i: j, dy };
  }
  if (!best) return null;
  used.add(best.i);
  return rows[best.i]!.items[0]!;
}

/** Rând de continuare: începe la x-ul descrierii rândului-ancoră și nu conține sume. */
export function isContinuation(row: Row, descX: number, style: AmountStyle): boolean {
  const first = row.items[0];
  if (!first || Math.abs(first.x - descX) > 6) return false;
  return amountItems(row, style).length === 0;
}

/** Plafonul de rânduri parsate dintr-un singur extras (ADR 0018). */
export function assertLineCap(n: number, max: number): void {
  if (n > max) throw new StatementError("too_many_lines");
}
