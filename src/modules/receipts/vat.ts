/**
 * Cotele de TVA (master prompt 5.5: „se citesc de pe bon, nu se presupun”; valorile pentru
 * validare stau în DATE, tabelul `finet.vat_rates` din migrația 0009, nu în cod). Aici doar
 * logica pură: o cotă e plauzibilă dacă e valabilă la data bonului. Cotele în puncte de bază
 * (21% = 2100), ca întregi.
 */

export type VatRateRow = Readonly<{
  /** Cota, în puncte de bază (21,00% = 2100). */
  rateBp: number;
  validFrom: string;
  /** Inclusiv; `null` = în vigoare. */
  validTo: string | null;
}>;

/** `"21"`, `"21.00"`, `"9.5"` → puncte de bază; `null` dacă forma nu e validă. */
export function parseRateBp(raw: string): number | null {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Cotele valabile la data dată. */
export function ratesOn(rows: readonly VatRateRow[], date: string): Set<number> {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.validFrom <= date && (r.validTo === null || date <= r.validTo)) out.add(r.rateBp);
  }
  return out;
}

/**
 * Cotele folosite de teste și de evaluare când nu există bază (aceleași valori ca seed-ul din
 * 0009; testul `vat.test.ts` le compară cu migrația). Surse: Legea 141/2025 (21% și 11% de la
 * 1 august 2025; 5% și 9% contopite în 11%); 19%/9%/5% între 2017-01-01 și 2025-07-31.
 */
export const RO_VAT_RATES_FALLBACK: readonly VatRateRow[] = [
  { rateBp: 0, validFrom: "2000-01-01", validTo: null },
  { rateBp: 2000, validFrom: "2016-01-01", validTo: "2016-12-31" },
  { rateBp: 1900, validFrom: "2017-01-01", validTo: "2025-07-31" },
  { rateBp: 900, validFrom: "2016-01-01", validTo: "2025-07-31" },
  { rateBp: 500, validFrom: "2016-01-01", validTo: "2025-07-31" },
  { rateBp: 2100, validFrom: "2025-08-01", validTo: null },
  { rateBp: 1100, validFrom: "2025-08-01", validTo: null },
];
