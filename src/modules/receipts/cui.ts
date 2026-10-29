/**
 * Codul unic de înregistrare (CUI/CIF) românesc (master prompt 5.5; ADR 0014): forma și cifra de
 * control. Funcții pure, fără dependențe.
 *
 * Algoritmul (cel publicat de ANAF): cifrele fără cifra de control, completate la stânga cu zero
 * până la 9, se înmulțesc cu cheia `753217532`; suma × 10 mod 11 (10 → 0) trebuie să fie egală cu
 * ultima cifră. CUI-ul are 2–10 cifre, cu sau fără prefixul `RO` (plătitor de TVA).
 */

const KEY = "753217532";

/** Forma canonică: `RO` opțional + cifre, fără spații/puncte/cratime; `null` dacă nu are forma. */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .toUpperCase()
    .replace(/[\s.\-]/g, "")
    .replace(/^R\.?O\.?/, "RO");
  if (!/^(RO)?[0-9]{2,10}$/.test(s)) return null;
  return s;
}

/** Doar cifrele CUI-ului (fără `RO`). */
export function taxIdDigits(normalized: string): string {
  return normalized.startsWith("RO") ? normalized.slice(2) : normalized;
}

/** `true` dacă CUI-ul are forma corectă și cifra de control potrivită. */
export function isValidCui(raw: string | null | undefined): boolean {
  const normalized = normalizeTaxId(raw);
  if (normalized === null) return false;
  const digits = taxIdDigits(normalized);
  const body = digits.slice(0, -1).padStart(9, "0");
  if (body.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(body[i]) * Number(KEY[i]);
  let control = (sum * 10) % 11;
  if (control === 10) control = 0;
  return control === Number(digits[digits.length - 1]);
}
