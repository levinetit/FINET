import type { ExportTable, TableCell, TableColumn } from "@/lib/export-table";
import { type Currency, money, toDecimalString } from "@/lib/money";
import { parseRateBp } from "@/modules/receipts/vat";

/**
 * Exportul pentru contabil (Faza 10, F10-C; ADR 0024): o linie per bon confirmat, într-un format
 * FIX și documentat, la fel în Excel și CSV. Funcții pure, fără acces la bază.
 *
 * Ce se află pe bon și ce se calculează. Bonul păstrează TVA-ul TOTAL (`vat_total_minor`), iar
 * fiecare linie păstrează cota ei (`vat_rate`) și valoarea BRUTĂ (cu TVA). Defalcarea pe cote nu e
 * stocată; se calculează aici:
 * - pe fiecare bon, liniile se grupează pe cotă și se însumează valorile brute (reducerile sunt
 *   linii negative și intră în grupul lor);
 * - TVA-ul unui grup = `brut × cotă / (100% + cotă)`, rotunjit la cel mai apropiat ban (jumătățile
 *   în sus, în valoare absolută), O SINGURĂ DATĂ pe grup (nu pe linie); baza = brut − TVA;
 * - liniile fără cotă citită NU se estimează: valoarea lor brută merge în coloana „Fără cotă”;
 * - coloane fixe pentru cotele 0, 5, 9, 11, 19 și 21 %; orice altă cotă merge în „Altă cotă”.
 *
 * Verificările (coloane de control, nu corecții): „Diferență TVA” = TVA calculat − TVA de pe bon
 * (gol dacă bonul nu are TVA total sau are linii fără cotă) și „Diferență total” = total bon −
 * total linii. Nicio valoare nu se ajustează ca să iasă diferența zero.
 */

/** Cotele cu coloane proprii, în puncte de bază (21% = 2100). */
export const ACCOUNTING_RATES_BP = [0, 500, 900, 1100, 1900, 2100] as const;

export type AccountingReceipt = Readonly<{
  id: string;
  occurredOn: string;
  number: string | null;
  merchantName: string | null;
  merchantTaxId: string | null;
  currency: Currency;
  totalMinor: bigint | null;
  vatTotalMinor: bigint | null;
  accountName: string | null;
  categoryName: string | null;
  /** Grupuri de linii: cota (text `numeric`, ex. `"19.00"`, sau `null`) și valoarea brută. */
  groups: readonly Readonly<{ rate: string | null; grossMinor: bigint }>[];
}>;

/** TVA-ul inclus într-o valoare brută la o cotă (puncte de bază), rotunjit; semnul se păstrează. */
export function vatIncluded(grossMinor: bigint, rateBp: number): bigint {
  if (rateBp === 0 || grossMinor === 0n) return 0n;
  const sign = grossMinor < 0n ? -1n : 1n;
  const numerator = grossMinor * sign * BigInt(rateBp);
  const denominator = BigInt(10_000 + rateBp);
  let q = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) q += 1n;
  return sign * q;
}

const pct = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2));

export const ACCOUNTING_COLUMNS: readonly TableColumn[] = [
  { key: "occurred_on", label: "Data", kind: "date" },
  { key: "receipt_number", label: "Număr bon", kind: "text" },
  { key: "merchant", label: "Comerciant", kind: "text" },
  { key: "tax_id", label: "CUI", kind: "text" },
  { key: "currency", label: "Moneda", kind: "text" },
  ...ACCOUNTING_RATES_BP.flatMap((bp) => [
    { key: `base_${bp}`, label: `Bază TVA ${pct(bp)}%`, kind: "money" as const },
    { key: `vat_${bp}`, label: `TVA ${pct(bp)}%`, kind: "money" as const },
  ]),
  { key: "base_other", label: "Bază altă cotă", kind: "money" },
  { key: "vat_other", label: "TVA altă cotă", kind: "money" },
  { key: "gross_no_rate", label: "Brut fără cotă", kind: "money" },
  { key: "vat_computed", label: "TVA total calculat", kind: "money" },
  { key: "vat_receipt", label: "TVA pe bon", kind: "money" },
  { key: "vat_diff", label: "Diferență TVA", kind: "money" },
  { key: "lines_total", label: "Total linii", kind: "money" },
  { key: "total", label: "Total bon", kind: "money" },
  { key: "total_diff", label: "Diferență total", kind: "money" },
  { key: "account", label: "Cont", kind: "text" },
  { key: "category", label: "Categorie", kind: "text" },
  { key: "receipt_id", label: "Id FINET", kind: "text" },
];

const dec = (minor: bigint, currency: Currency): string => toDecimalString(money(minor, currency));

/** Valorile unui bon în ordinea `ACCOUNTING_COLUMNS` (sume ca bigint, `null` = celulă goală). */
export function accountingValues(r: AccountingReceipt): (bigint | string | null)[] {
  const known = new Map<number, bigint>(); // cotă (bp) → brut
  let other = 0n;
  let otherVat = 0n;
  let noRate = 0n;
  let hasNoRate = false;
  for (const g of r.groups) {
    const bp = g.rate === null ? null : parseRateBp(g.rate);
    if (bp === null) {
      noRate += g.grossMinor;
      hasNoRate = true;
    } else if ((ACCOUNTING_RATES_BP as readonly number[]).includes(bp)) {
      known.set(bp, (known.get(bp) ?? 0n) + g.grossMinor);
    } else {
      other += g.grossMinor;
      otherVat += vatIncluded(g.grossMinor, bp);
    }
  }
  const cells: (bigint | string | null)[] = [
    r.occurredOn,
    r.number,
    r.merchantName,
    r.merchantTaxId,
    r.currency,
  ];
  let vatComputed = 0n;
  for (const bp of ACCOUNTING_RATES_BP) {
    const gross = known.get(bp);
    if (gross === undefined) {
      cells.push(null, null);
      continue;
    }
    const vat = vatIncluded(gross, bp);
    vatComputed += vat;
    cells.push(gross - vat, vat);
  }
  vatComputed += otherVat;
  cells.push(other === 0n ? null : other - otherVat, other === 0n ? null : otherVat);
  cells.push(hasNoRate ? noRate : null);
  cells.push(vatComputed);
  cells.push(r.vatTotalMinor);
  const comparable = r.vatTotalMinor !== null && !hasNoRate;
  cells.push(comparable ? vatComputed - r.vatTotalMinor! : null);
  const linesTotal = r.groups.reduce((s, g) => s + g.grossMinor, 0n);
  cells.push(linesTotal);
  cells.push(r.totalMinor);
  cells.push(r.totalMinor === null ? null : r.totalMinor - linesTotal);
  cells.push(r.accountName, r.categoryName, r.id);
  return cells;
}

const MONEY_START = 5; // prima coloană de sumă (după Data, Număr, Comerciant, CUI, Moneda)
const MONEY_END = ACCOUNTING_COLUMNS.length - 3; // ultima sumă: „Diferență total”

/** Tabelul de export. Rândul de totaluri apare doar dacă toate bonurile au aceeași monedă. */
export function accountingTable(
  receipts: readonly AccountingReceipt[],
  contextLines: readonly string[],
): ExportTable {
  const rows: TableCell[][] = [];
  const sums: bigint[] = ACCOUNTING_COLUMNS.map(() => 0n);
  const seen: boolean[] = ACCOUNTING_COLUMNS.map(() => false);
  for (const r of receipts) {
    const values = accountingValues(r);
    rows.push(
      values.map((v, i) => {
        if (typeof v === "bigint") {
          sums[i] = sums[i]! + v;
          seen[i] = true;
          return dec(v, r.currency);
        }
        return v;
      }),
    );
  }
  const currencies = new Set(receipts.map((r) => r.currency));
  let totals: TableCell[] | undefined;
  if (receipts.length > 0 && currencies.size === 1) {
    const currency = receipts[0]!.currency;
    totals = ACCOUNTING_COLUMNS.map((_, i) => {
      if (i === 2) return "Total";
      if (i >= MONEY_START && i <= MONEY_END && seen[i]) return dec(sums[i]!, currency);
      return null;
    });
  }
  return {
    title: "Export pentru contabil",
    context: [...contextLines, `Bonuri: ${receipts.length}`],
    columns: ACCOUNTING_COLUMNS,
    rows,
    ...(totals ? { totals } : {}),
  };
}

/** Variantă fără cote, pentru exportul simplu al bonurilor (Excel/PDF). */
export const RECEIPT_LIST_KEYS = [
  "occurred_on",
  "receipt_number",
  "merchant",
  "tax_id",
  "currency",
  "vat_receipt",
  "total",
  "account",
  "category",
] as const;

export function receiptListTable(
  receipts: readonly AccountingReceipt[],
  contextLines: readonly string[],
): ExportTable {
  const full = accountingTable(receipts, contextLines);
  const idx = RECEIPT_LIST_KEYS.map((k) => ACCOUNTING_COLUMNS.findIndex((c) => c.key === k));
  const pick = (cells: readonly TableCell[]) => idx.map((i) => cells[i]!);
  return {
    title: "Bonuri",
    context: full.context,
    columns: idx.map((i) => ACCOUNTING_COLUMNS[i]!),
    rows: full.rows.map(pick),
    ...(full.totals ? { totals: pick(full.totals) } : {}),
  };
}
