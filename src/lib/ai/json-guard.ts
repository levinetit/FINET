import { AiError } from "./errors";

/**
 * Parsarea prudentă a JSON-ului întors de un model (Faza 6, F6-B; ADR 0014). Ieșirea modelului
 * e o dată NEÎNCREZĂTOARE: înainte de `JSON.parse` se aplică plafoane pe lungime, pe adâncime și
 * pe numărul de valori (o singură trecere, liniară, care ține cont de șiruri și de escape-uri),
 * ca un răspuns uriaș sau adânc imbricat să nu consume memorie sau stivă. Forma reală (câmpuri,
 * tipuri, lungimi) o verifică apoi Zod strict, în modulul care folosește rezultatul.
 *
 * Nimic din conținut nu ajunge în erori: doar coduri fixe.
 */

export type JsonLimits = Readonly<{
  /** Caractere maxime ale textului (după eliminarea gardului de cod). */
  maxChars: number;
  /** Adâncimea maximă a obiectelor/listelor imbricate. */
  maxDepth: number;
  /** Numărul maxim de valori (scalari, obiecte, liste) din tot documentul. */
  maxValues: number;
}>;

/** Elimină cel mult UN gard de cod Markdown, exact la început și la sfârșit. */
export function stripCodeFence(text: string): string {
  const t = text.trim();
  for (const open of ["```json\n", "```JSON\n", "```\n"]) {
    if (t.startsWith(open) && t.endsWith("```") && t.length >= open.length + 3) {
      return t.slice(open.length, t.length - 3).trim();
    }
  }
  return t;
}

/**
 * Verifică forma brută a unui text JSON înainte de parsare: lungimea, adâncimea și numărul de
 * valori. Nu validează gramatica (o face `JSON.parse`); doar oprește intrările costisitoare.
 */
export function checkJsonShape(text: string, limits: JsonLimits): void {
  if (text.length > limits.maxChars) throw new AiError("response_too_large", "content_chars");
  let depth = 0;
  let values = 0;
  let inString = false;
  let inScalar = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) i++;
      else if (c === 0x22 /* " */) inString = false;
      continue;
    }
    switch (c) {
      case 0x22: // "
        inString = true;
        inScalar = false;
        values++;
        break;
      case 0x7b: // {
      case 0x5b: // [
        depth++;
        values++;
        inScalar = false;
        if (depth > limits.maxDepth) throw new AiError("failed_validation", "json_depth");
        break;
      case 0x7d: // }
      case 0x5d: // ]
        depth--;
        inScalar = false;
        break;
      case 0x2c: // ,
      case 0x3a: // :
      case 0x20:
      case 0x0a:
      case 0x0d:
      case 0x09:
        inScalar = false;
        break;
      default:
        // Începutul unui scalar (număr, true, false, null).
        if (!inScalar) {
          inScalar = true;
          values++;
        }
    }
    if (values > limits.maxValues) throw new AiError("failed_validation", "json_values");
  }
}

/** Plafoane + `JSON.parse`; orice eroare devine `failed_validation`. */
export function parseJsonGuarded(text: string, limits: JsonLimits): unknown {
  checkJsonShape(text, limits);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AiError("failed_validation", "json_syntax");
  }
}
