import { z } from "zod";

import type { ExtractedLine, ReceiptLineKind } from "./extraction.schema";

/**
 * Categorisirea liniilor de bon (master prompt 3.6; ADR 0014), în ordinea fixă:
 * 1. `product_aliases` (corecturile utilizatorului, după numele normalizat);
 * 2. reguli fixe în cod: garanția SGR, pungile/sacoșele, reducerile (schimbă `kind`, fără
 *    categorie: garanția e recuperabilă, reducerea scade din bon, punga rămâne necategorizată);
 * 3. LLM text cu lista ÎNCHISĂ a categoriilor de cheltuieli ale gospodăriei: modelul primește
 *    coduri scurte (`c1`…`cN`) și indici de linie, nu id-uri; răspunsul se validează strict, iar
 *    un cod inexistent devine „necategorizat” (`null`). Modelul nu poate crea categorii.
 * Regulile 1–2 rulează ÎNAINTEA verificărilor (tipul liniei schimbă suma bonului).
 */

export type CategoryOption = Readonly<{ id: string; name: string }>;

export type LineCategory = Readonly<{
  categoryId: string | null;
  source: "alias" | "rule" | "llm" | "none";
}>;

const RULES: ReadonlyArray<readonly [RegExp, ReceiptLineKind]> = [
  [/\b(?:sgr|garantie|garantii|ambalaj returnabil|deposit)\b/, "deposit_sgr"],
  [/\b(?:punga|pungi|sacosa|sacose|bag|plasa)\b/, "bag"],
  [/\b(?:reducere|reduceri|discount|lidl plus|cupon|voucher reducere)\b/, "discount"],
];

/** Tipul liniei după regulile fixe (pe numele normalizat), sau `null` dacă nicio regulă nu se aplică. */
export function ruleKind(normalizedName: string | null): ReceiptLineKind | null {
  if (normalizedName === null) return null;
  for (const [re, kind] of RULES) if (re.test(normalizedName)) return kind;
  return null;
}

/** Aplică regulile fixe pe tipul liniilor (pasul 2), înaintea verificărilor. */
export function applyKindRules(lines: readonly ExtractedLine[]): ExtractedLine[] {
  return lines.map((l) => {
    const kind = ruleKind(l.normalizedName);
    return kind === null || kind === l.kind ? l : { ...l, kind };
  });
}

/** Cererea către LLM: linii (indice + nume) și categoriile (cod + nume). */
export type CategorizeRequest = Readonly<{
  items: ReadonlyArray<Readonly<{ i: number; name: string }>>;
  categories: ReadonlyArray<Readonly<{ code: string; name: string }>>;
}>;

/** Răspunsul LLM-ului (după `parseModelJson`), validat strict. */
export const categorizeResponseSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({ i: z.number().int().min(0).max(1000), c: z.string().max(8).nullable() }),
    )
    .max(500),
});

export function categorizeJsonSchema(codes: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["i", "c"],
          properties: {
            i: { type: "integer", minimum: 0, maximum: 1000 },
            c: { type: ["string", "null"], enum: [...codes, null] },
          },
        },
      },
    },
  };
}

/** Pasul LLM, injectat (pipeline-ul îl leagă de clientul AI; testele, de o funcție falsă). */
export type CategorizeLlm = (request: CategorizeRequest) => Promise<unknown>;

export const MAX_LLM_ITEMS = 200;
export const MAX_LLM_CATEGORIES = 80;

export type CategorizeInput = Readonly<{
  lines: readonly ExtractedLine[];
  aliases: ReadonlyMap<string, string>;
  categories: readonly CategoryOption[];
  llm: CategorizeLlm | null;
}>;

/**
 * Categoria fiecărei linii (aceeași ordine ca `lines`). O eroare a LLM-ului (rețea, buget,
 * JSON invalid) lasă liniile rămase necategorizate: categorisirea nu blochează bonul.
 */
export async function categorizeLines(input: CategorizeInput): Promise<LineCategory[]> {
  const allowed = new Set(input.categories.map((c) => c.id));
  const out: LineCategory[] = input.lines.map(() => ({ categoryId: null, source: "none" }));
  const pending: number[] = [];
  input.lines.forEach((l, idx) => {
    if (l.kind !== "product" && l.kind !== "other") {
      out[idx] = { categoryId: null, source: "rule" };
      return;
    }
    const alias = l.normalizedName === null ? undefined : input.aliases.get(l.normalizedName);
    if (alias !== undefined && allowed.has(alias)) {
      out[idx] = { categoryId: alias, source: "alias" };
      return;
    }
    pending.push(idx);
  });
  if (pending.length === 0 || input.llm === null || input.categories.length === 0) return out;

  const categories = input.categories.slice(0, MAX_LLM_CATEGORIES);
  const codeToId = new Map(categories.map((c, k) => [`c${k + 1}`, c.id] as const));
  const asked = pending.slice(0, MAX_LLM_ITEMS);
  const request: CategorizeRequest = {
    items: asked.map((idx) => ({
      i: idx,
      name: input.lines[idx]!.normalizedName ?? input.lines[idx]!.rawName,
    })),
    categories: categories.map((c, k) => ({ code: `c${k + 1}`, name: c.name })),
  };
  let raw: unknown;
  try {
    raw = await input.llm(request);
  } catch {
    return out;
  }
  const parsed = categorizeResponseSchema.safeParse(raw);
  if (!parsed.success) return out;
  const askedSet = new Set(asked);
  for (const item of parsed.data.items) {
    if (!askedSet.has(item.i)) continue; // indice necerut: ignorat
    askedSet.delete(item.i); // un indice o singură dată
    const id = item.c === null ? undefined : codeToId.get(item.c);
    out[item.i] =
      id === undefined ? { categoryId: null, source: "none" } : { categoryId: id, source: "llm" };
  }
  return out;
}
