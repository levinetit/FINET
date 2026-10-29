import { parseBrd } from "./parsers/brd";
import { parseBt } from "./parsers/bt";
import { parseRaiffeisen } from "./parsers/raiffeisen";
import { parseRevolut } from "./parsers/revolut";
import { cleanItems, fold } from "./text";
import { type ParsedStatement, StatementError, type TextItem } from "./types";

/**
 * Detectarea băncii pe antetul primei pagini (ADR 0018): cuvinte-cheie FĂRĂ diacritice (textul
 * Raiffeisen nu e încă reparat) plus structura coloanelor. Fiecare bancă cere TOATE semnele ei;
 * zero potriviri → `unknown_bank` (maparea manuală nu se aplică PDF-urilor), mai multe →
 * `ambiguous_bank` (fail-closed: nu ghicim).
 */

export type PdfBank = "bt" | "brd" | "raiffeisen" | "revolut";

const SIGNS: Readonly<Record<PdfBank, readonly (readonly string[])[]>> = {
  // Fiecare grup: cel puțin unul dintre șiruri trebuie să apară.
  bt: [["banca transilvania"], ["extras cont"], ["sold anterior"], ["descriere"]],
  brd: [["brderobu", "brd-groupe"], ["extras de cont / statement"], ["start balance"]],
  raiffeisen: [["rzbrrobu", "raiffeisen bank"], ["extras de cont"], ["rulaj debitor"]],
  revolut: [["revolut bank uab"], ["rezumatul soldului"], ["sume retrase"], ["sume ad"]],
};

export function detectBank(items: readonly TextItem[]): PdfBank {
  const firstPage = items.filter((i) => i.p === 1);
  const text = fold(firstPage.map((i) => i.s).join("\n"));
  const matches = (Object.keys(SIGNS) as PdfBank[]).filter((bank) =>
    SIGNS[bank].every((group) => group.some((s) => text.includes(s))),
  );
  if (matches.length === 0) throw new StatementError("unknown_bank");
  if (matches.length > 1) throw new StatementError("ambiguous_bank");
  return matches[0]!;
}

const PARSERS: Readonly<Record<PdfBank, (items: readonly TextItem[]) => ParsedStatement>> = {
  bt: parseBt,
  brd: parseBrd,
  raiffeisen: parseRaiffeisen,
  revolut: parseRevolut,
};

/** PDF → extras parsat: curățare, detectare, parserul băncii. Erorile sunt coduri fixe. */
export function parsePdfItems(raw: readonly TextItem[]): ParsedStatement {
  const items = cleanItems(raw);
  if (items.length === 0) throw new StatementError("empty_statement");
  const bank = detectBank(items);
  // Un extras fără mișcări e valid (acoperă luna pentru tabelul „Acoperire extrase”).
  return PARSERS[bank](items);
}
