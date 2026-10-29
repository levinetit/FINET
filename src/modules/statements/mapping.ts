import { z } from "zod";

import type { Currency } from "@/lib/money";

import { STATEMENT_MAX_LINES } from "@/db/schema/statements";

import type { Table } from "./csv";
import { currencyFrom } from "./parsers/common";
import { assertLineCap } from "./table";
import { buildDescription, cleanReference, fold } from "./text";
import { type ParsedLine, type ParsedStatement, StatementError, type StatementBank } from "./types";

/**
 * Maparea manuală de coloane pentru CSV/XLSX (master prompt Faza 7; ADR 0018): utilizatorul
 * (sau o sugestie pe care o confirmă) spune care coloană e data, suma (cu semn) sau debit/credit,
 * descrierea, referința, moneda, soldul; formatul datei și al zecimalelor e EXPLICIT (fără
 * ghicit „1.004”). Rezultatul e un `ParsedStatement` obișnuit, care trece prin aceeași
 * previzualizare, deduplicare și verificare de sold ca PDF-urile.
 */

export const DATE_FORMATS = [
  "dmy_dot",
  "dmy_slash",
  "dmy_dash",
  "ymd_dash",
  "excel_serial",
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const col = z.number().int().min(0).max(49);

export const columnMappingSchema = z
  .strictObject({
    headerRow: z.number().int().min(-1).max(50),
    date: col,
    dateFormat: z.enum(DATE_FORMATS),
    amount: col.optional(),
    debit: col.optional(),
    credit: col.optional(),
    /** Doar pentru `amount`: semnul minus = debit (implicit) sau invers. */
    negativeIs: z.enum(["debit", "credit"]).default("debit"),
    decimal: z.enum([",", "."]),
    thousands: z.enum([".", ",", " ", ""]),
    description: z.array(col).min(1).max(5),
    reference: col.optional(),
    currency: col.optional(),
    balance: col.optional(),
  })
  .refine((m) => (m.amount !== undefined) !== (m.debit !== undefined || m.credit !== undefined), {
    message: "Alege fie coloana sumei, fie coloanele debit/credit.",
  })
  .refine((m) => m.amount !== undefined || (m.debit !== undefined && m.credit !== undefined), {
    message: "Debit și credit se aleg împreună.",
  })
  .refine((m) => m.decimal !== m.thousands, {
    message: "Separatorul zecimal diferă de cel de mii.",
  });

export type ColumnMapping = z.infer<typeof columnMappingSchema>;

// ---------------------------------------------------------------------------------------------
// Valori
// ---------------------------------------------------------------------------------------------

/**
 * Suma unei celule în formatul declarat; `null` pentru celula goală. În CSV: 1–2 zecimale. Valorile
 * numerice din XLSX (`maxDecimals` 15)
 * (`1234.5`, `12.300000000000001`: reprezentarea zecimală a unui double, până la 15 cifre
 * semnificative) se rotunjesc la 2 zecimale pe ȘIR (jumătate în sus), fără float (decizia mea).
 */
export function cellAmount(
  raw: string,
  decimal: "," | ".",
  thousands: "." | "," | " " | "",
  maxDecimals = 2,
): bigint | null {
  let s = raw.replace(/[  ]/g, " ").trim();
  if (s === "") return null;
  s = s.replace(/\s?(RON|LEI|EUR|USD|lei)$/i, "").trim();
  let negative = false;
  if (/^[-−]/.test(s)) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) s = s.slice(1).trim();
  else if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const t = thousands === "" ? "" : thousands === "." ? "\\." : thousands === " " ? " " : ",";
  const d = decimal === "." ? "\\." : ",";
  const grouped = t ? `\\d{1,3}(?:${t}\\d{3})+` : "(?!)";
  const re = new RegExp(`^(${grouped}|\\d+)(?:${d}(\\d{1,${maxDecimals}}))?$`);
  const m = re.exec(s);
  if (!m) throw new StatementError("invalid_amount");
  const integer = m[1]!.replace(/\D/g, "");
  const frac = m[2] ?? "";
  if (integer.length > 14) throw new StatementError("invalid_amount");
  let minor = BigInt(integer) * 100n + BigInt((frac + "00").slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) minor += 1n;
  if (minor > 10_000_000_000_000n) throw new StatementError("invalid_amount");
  return negative ? -minor : minor;
}

function iso(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2999 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new StatementError("invalid_date");
  }
  return dt.toISOString().slice(0, 10);
}

/** Data unei celule în formatul declarat (ora, dacă există după dată, e ignorată). */
export function cellDate(raw: string, format: DateFormat): string {
  const s = raw.trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?.*$/, "");
  const patterns: Record<Exclude<DateFormat, "excel_serial">, RegExp> = {
    dmy_dot: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
    dmy_slash: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    dmy_dash: /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
    ymd_dash: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  };
  if (format === "excel_serial") {
    const m = /^(\d{4,6})(?:\.\d+)?$/.exec(s);
    if (!m) throw new StatementError("invalid_date");
    // Sistemul 1900 al Excel: ziua 1 = 1900-01-01, cu ziua fictivă 29.02.1900 (serial 60).
    const serial = Number(m[1]);
    if (serial < 61) throw new StatementError("invalid_date");
    const dt = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const m = patterns[format].exec(s);
  if (!m) throw new StatementError("invalid_date");
  return format === "ymd_dash"
    ? iso(Number(m[1]), Number(m[2]), Number(m[3]))
    : iso(Number(m[3]), Number(m[2]), Number(m[1]));
}

// ---------------------------------------------------------------------------------------------
// Tabel → extras
// ---------------------------------------------------------------------------------------------

export type MapOptions = Readonly<{
  currency: Currency;
  format: "csv" | "xlsx";
  bank?: StatementBank;
  parserVersion?: number;
}>;

export function mapTable(table: Table, rawMapping: unknown, opts: MapOptions): ParsedStatement {
  const parsed = columnMappingSchema.safeParse(rawMapping);
  if (!parsed.success) throw new StatementError("csv_mapping_invalid");
  const m = parsed.data;
  const body = table.rows.slice(m.headerRow + 1);
  const dec = opts.format === "xlsx" ? 15 : 2;
  assertLineCap(body.length, STATEMENT_MAX_LINES);

  type Row = {
    date: string;
    signed: bigint;
    desc: string;
    ref: string | null;
    balance: bigint | null;
  };
  const rows: Row[] = [];
  let skipped = 0;
  let zero = 0;
  for (const r of body) {
    const at = (i: number | undefined) => (i === undefined ? "" : (r[i] ?? "").trim());
    const dateCell = at(m.date);
    let signed: bigint | null;
    if (m.amount !== undefined) {
      const v = cellAmount(at(m.amount), m.decimal, m.thousands, dec);
      signed = v === null ? null : m.negativeIs === "debit" ? v : -v;
    } else {
      const d = cellAmount(at(m.debit), m.decimal, m.thousands, dec);
      const c = cellAmount(at(m.credit), m.decimal, m.thousands, dec);
      if (d !== null && c !== null && d !== 0n && c !== 0n) throw new StatementError("corrupt_row");
      // Debitul poate fi scris pozitiv sau negativ; semnul îl dă coloana.
      signed = d !== null && d !== 0n ? -(d < 0n ? -d : d) : c !== null ? (c < 0n ? -c : c) : d;
    }
    // Rânduri de sumar/subsol fără dată și fără sumă: ignorate (numărate).
    if (dateCell === "" && signed === null) {
      skipped++;
      continue;
    }
    if (dateCell === "" || signed === null) throw new StatementError("corrupt_row");
    const date = cellDate(dateCell, m.dateFormat);
    if (m.currency !== undefined && at(m.currency) !== "") {
      let c: Currency;
      try {
        c = currencyFrom(at(m.currency));
      } catch {
        throw new StatementError("currency_mismatch");
      }
      if (c !== opts.currency) throw new StatementError("currency_mismatch");
    }
    if (signed === 0n) {
      zero++;
      continue;
    }
    const balanceCell = at(m.balance);
    rows.push({
      date,
      signed,
      desc: buildDescription(m.description.map((i) => at(i))),
      ref: cleanReference(at(m.reference) || null),
      balance: balanceCell === "" ? null : cellAmount(balanceCell, m.decimal, m.thousands, dec),
    });
  }
  // Exporturile „cele mai noi întâi” se întorc în ordine cronologică (soldurile pe rând depind
  // de ordine); ordinea în aceeași zi se păstrează inversată consecvent.
  if (rows.length > 1 && rows[0]!.date > rows[rows.length - 1]!.date) rows.reverse();

  const lines: ParsedLine[] = rows.map((r, i) => ({
    rowNo: i + 1,
    occurredOn: r.date,
    direction: r.signed < 0n ? "debit" : "credit",
    amountMinor: r.signed < 0n ? -r.signed : r.signed,
    description: r.desc,
    bankReference: r.ref,
    kind: "movement",
    fxAmountMinor: null,
    fxCurrency: null,
    balanceAfterMinor: r.balance,
  }));
  const first = lines[0];
  const last = lines[lines.length - 1];
  const opening =
    first && first.balanceAfterMinor !== null
      ? first.balanceAfterMinor -
        (first.direction === "credit" ? first.amountMinor : -first.amountMinor)
      : null;
  const warnings: string[] = [];
  if (skipped) warnings.push("rows_skipped");
  if (zero) warnings.push("zero_amount_skipped");
  return {
    bank: opts.bank ?? "generic",
    format: opts.format,
    parserVersion: opts.parserVersion ?? 1,
    currency: opts.currency,
    periodStart: first?.occurredOn ?? null,
    periodEnd: last?.occurredOn ?? null,
    openingBalanceMinor: opening,
    closingBalanceMinor: last?.balanceAfterMinor ?? null,
    declaredDebitMinor: null,
    declaredCreditMinor: null,
    dayBalances: [],
    lines,
    pendingCount: 0,
    zeroCount: zero,
    ibanLast4: null,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// Sugestia de mapare (o confirmă utilizatorul) și șabloanele băncilor fără extras real
// ---------------------------------------------------------------------------------------------

export type MappingSuggestion = Readonly<{
  mapping: Partial<ColumnMapping>;
  /** Câmpurile pe care utilizatorul trebuie să le aleagă (nu s-au putut deduce sigur). */
  missing: readonly string[];
  template: { bank: StatementBank; verified: false } | null;
}>;

const HEADER_WORDS: ReadonlyArray<[keyof ColumnMapping, RegExp]> = [
  ["date", /^(data|date|data tranzactiei|data operatiunii|data inregistrarii)$/],
  ["amount", /^(suma|amount|valoare)$/],
  ["debit", /^(debit|sume retrase|plati)$/],
  ["credit", /^(credit|sume adaugate|incasari)$/],
  ["reference", /^(referinta|reference|payment reference|id tranzactie|transferwise id)$/],
  ["currency", /^(moneda|valuta|currency)$/],
  ["balance", /^(sold|balance|running balance)$/],
];
const DESC_RE =
  /^(descriere|detalii|detalii tranzactie|description|explicatie|merchant|beneficiar)$/;

/**
 * Șablonul Wise (CSV-ul „Statement” din aplicație, după documentația publică): NEVERIFICAT fără
 * un extras real anonimizat — banca NU se declară suportată (master prompt Faza 7). ING și BCR:
 * fără șablon (formatul nu e cunoscut cu certitudine).
 */
function wiseTemplate(header: readonly string[]): Partial<ColumnMapping> | null {
  const h = header.map(fold);
  if (!h.includes("transferwise id")) return null;
  const idx = (name: string) => {
    const i = h.indexOf(name);
    return i < 0 ? undefined : i;
  };
  const date = idx("date");
  const amount = idx("amount");
  const description = idx("description");
  if (date === undefined || amount === undefined || description === undefined) return null;
  return {
    headerRow: 0,
    date,
    dateFormat: "dmy_dash",
    amount,
    negativeIs: "debit",
    decimal: ".",
    thousands: "",
    description: [description],
    reference: idx("transferwise id"),
    currency: idx("currency"),
    balance: idx("running balance"),
  };
}

export function suggestMapping(table: Table): MappingSuggestion {
  const headerRow = table.rows.findIndex(
    (r) => r.filter((c) => c !== "" && !/^[-\d.,\s]+$/.test(c)).length >= 3,
  );
  if (headerRow < 0) return { mapping: {}, missing: ["headerRow"], template: null };
  const header = table.rows[headerRow]!;
  const wise = wiseTemplate(header);
  if (wise) return { mapping: wise, missing: [], template: { bank: "wise", verified: false } };
  const mapping: Record<string, unknown> = { headerRow };
  const folded = header.map(fold);
  for (const [key, re] of HEADER_WORDS) {
    const i = folded.findIndex((h) => re.test(h));
    if (i >= 0) mapping[key] = i;
  }
  const desc = folded.flatMap((h, i) => (DESC_RE.test(h) ? [i] : []));
  if (desc.length) mapping.description = desc.slice(0, 5);
  // Zecimalele: doar dacă eșantionul e neambiguu (`…,dd` sau `…\.dd` la final, fără conflicte).
  const amountCols = ["amount", "debit", "credit", "balance"]
    .map((k) => mapping[k])
    .filter((v): v is number => typeof v === "number");
  const samples = table.rows
    .slice(headerRow + 1, headerRow + 50)
    .flatMap((r) => amountCols.map((c) => (r[c] ?? "").trim()))
    .filter((s) => s !== "");
  const comma = samples.filter((s) => /,\d{2}$/.test(s)).length;
  const dot = samples.filter((s) => /\.\d{2}$/.test(s)).length;
  if (comma > 0 && dot === 0) {
    mapping.decimal = ",";
    mapping.thousands = samples.some((s) => /\d\.\d{3}/.test(s)) ? "." : "";
  } else if (dot > 0 && comma === 0) {
    mapping.decimal = ".";
    mapping.thousands = samples.some((s) => /\d,\d{3}/.test(s)) ? "," : "";
  }
  const dateCol = mapping.date as number | undefined;
  const dateSample = dateCol === undefined ? "" : (table.rows[headerRow + 1]?.[dateCol] ?? "");
  const fmt = DATE_FORMATS.find((f) => {
    try {
      cellDate(dateSample, f);
      return f !== "excel_serial" || /^\d{5}$/.test(dateSample.trim());
    } catch {
      return false;
    }
  });
  if (fmt) mapping.dateFormat = fmt;
  const required = ["date", "dateFormat", "decimal", "description"];
  const missing = required.filter((k) => mapping[k] === undefined);
  if (
    mapping.amount === undefined &&
    (mapping.debit === undefined || mapping.credit === undefined)
  ) {
    missing.push("amount");
  }
  return { mapping: mapping as Partial<ColumnMapping>, missing, template: null };
}
