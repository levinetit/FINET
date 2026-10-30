import { z } from "zod";

import { normalizeProductName } from "@/modules/receipts/normalize";

import {
  DEFAULT_KINDS,
  LINE_KINDS,
  MAX_FILTER_IDS,
  MAX_TERMS,
  MAX_TERM_LENGTH,
  MIN_TERM_LENGTH,
  RULE_COMBINES,
  RULE_TYPES,
  RULE_VERSION,
  type LineKindFilter,
  type RuleType,
} from "./rule-constants";

export {
  DEFAULT_KINDS,
  LINE_KINDS,
  MAX_FILTER_IDS,
  MAX_TERMS,
  MAX_TERM_LENGTH,
  MIN_TERM_LENGTH,
  RULE_COMBINES,
  RULE_TYPES,
  RULE_VERSION,
  type LineKindFilter,
  type RuleType,
};

/**
 * Regulile de potrivire ale rapoartelor de micro-cheltuieli (Faza 10, F10-B; ADR 0023). Funcții
 * PURE, fără acces la bază: textul regulilor nu ajunge niciodată în SQL (interogarea aduce
 * liniile gospodăriei după tip/categorie/etichetă, iar potrivirea pe nume se face AICI), deci
 * nu există interpolare de SQL, `LIKE` sau expresii regulate construite din date de utilizator.
 *
 * Forma (JSON versionat, `report_definitions.rules`):
 *   { v: 1, combine: "all" | "any", include: Term[], exclude: Term[],
 *     kinds: LineKind[], categoryIds: uuid[], tagIds: uuid[] }
 * - `include`: potrivire dacă TOATE (`all`, ȘI) sau CEL PUȚIN UNUL (`any`, SAU) dintre termeni se
 *   potrivesc; listă goală = orice nume (rămân filtrele de tip/categorie/etichetă);
 * - `exclude`: dacă ORICARE termen se potrivește, linia iese (SAU plat);
 * - fără paranteze și fără combinații imbricate: un singur nivel, cel mult `MAX_TERMS` termeni pe listă.
 * Un termen: `{ type: "exact" | "prefix" | "contains" | "token", value }` pe numele NORMALIZAT al
 * produsului (litere mici, fără diacritice; `normalizeProductName`). `token` = cuvânt întreg
 * (numele se desparte după spații).
 */

export type RuleTerm = Readonly<{ type: RuleType; value: string }>;

export type ReportRules = Readonly<{
  v: typeof RULE_VERSION;
  combine: (typeof RULE_COMBINES)[number];
  include: readonly RuleTerm[];
  exclude: readonly RuleTerm[];
  kinds: readonly LineKindFilter[];
  categoryIds: readonly string[];
  tagIds: readonly string[];
}>;

/** Valoarea normalizată a unui termen: aceeași normalizare ca la numele produselor de pe bonuri. */
export function normalizeRuleValue(raw: string): string | null {
  const n = normalizeProductName(raw);
  if (n === null || n.length > MAX_TERM_LENGTH) return null;
  return n;
}

const SAFE_VALUE = /^[a-z0-9.% ]+$/;

const termSchema = z
  .strictObject({
    type: z.enum(RULE_TYPES),
    value: z
      .string()
      .min(1)
      .max(MAX_TERM_LENGTH * 2),
  })
  .transform((t, ctx): RuleTerm => {
    const value = normalizeRuleValue(t.value);
    if (value === null || !SAFE_VALUE.test(value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Valoare nepermisă." });
      return z.NEVER;
    }
    if (t.type !== "exact" && value.length < MIN_TERM_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `Cel puțin ${MIN_TERM_LENGTH} caractere.`,
      });
      return z.NEVER;
    }
    if (t.type === "token" && value.includes(" ")) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Un cuvânt întreg nu poate conține spații.",
      });
      return z.NEVER;
    }
    return { type: t.type, value };
  });

const uniqueBy = <T>(list: readonly T[], key: (x: T) => string) =>
  new Set(list.map(key)).size === list.length;

const termsSchema = z
  .array(termSchema)
  .max(MAX_TERMS)
  .refine((l) => uniqueBy(l, (t) => `${t.type}:${t.value}`), {
    message: "Termeni repetați.",
  });

const idsSchema = z
  .array(z.uuid().transform((v) => v.toLowerCase()))
  .max(MAX_FILTER_IDS)
  .refine((l) => uniqueBy(l, (x) => x), { message: "Valori repetate." });

export const reportRulesSchema = z.strictObject({
  v: z.literal(RULE_VERSION),
  combine: z.enum(RULE_COMBINES),
  include: termsSchema,
  exclude: termsSchema,
  kinds: z
    .array(z.enum(LINE_KINDS))
    .min(1)
    .max(LINE_KINDS.length)
    .refine((l) => uniqueBy(l, (x) => x), { message: "Valori repetate." }),
  categoryIds: idsSchema,
  tagIds: idsSchema,
});

// ---------------------------------------------------------------------------------------------
// Potrivirea (funcții pure)
// ---------------------------------------------------------------------------------------------

/** Cuvintele unui nume normalizat (despărțit după spații, fără goluri). */
export function tokensOf(normalizedName: string): string[] {
  return normalizedName.split(" ").filter((t) => t !== "");
}

/** Un termen se potrivește cu un nume normalizat? */
export function termMatches(term: RuleTerm, normalizedName: string): boolean {
  switch (term.type) {
    case "exact":
      return normalizedName === term.value;
    case "prefix":
      return normalizedName.startsWith(term.value);
    case "contains":
      return normalizedName.includes(term.value);
    case "token":
      return tokensOf(normalizedName).includes(term.value);
  }
}

/**
 * Numele (normalizat) intră în raport? `include` cu `combine` (gol = orice nume), apoi `exclude`
 * (niciun termen nu trebuie să se potrivească). Nu verifică tipul/categoria/eticheta liniei
 * (filtrele se aplică la citirea liniilor).
 */
export function matchesName(rules: ReportRules, normalizedName: string): boolean {
  // Cuvintele numelui se despart o singură dată, doar dacă un termen `token` le cere.
  let words: Set<string> | null = null;
  const test = (term: RuleTerm): boolean => {
    if (term.type !== "token") return termMatches(term, normalizedName);
    words ??= new Set(tokensOf(normalizedName));
    return words.has(term.value);
  };
  if (rules.include.length > 0) {
    const hit = rules.combine === "all" ? rules.include.every(test) : rules.include.some(test);
    if (!hit) return false;
  }
  return !rules.exclude.some(test);
}

/** Aceleași reguli, ca JSON stabil (chei în ordine fixă) pentru comparații și stocare. */
export function canonicalRules(rules: ReportRules): ReportRules {
  return {
    v: rules.v,
    combine: rules.combine,
    include: rules.include.map((t) => ({ type: t.type, value: t.value })),
    exclude: rules.exclude.map((t) => ({ type: t.type, value: t.value })),
    kinds: [...rules.kinds],
    categoryIds: [...rules.categoryIds],
    tagIds: [...rules.tagIds],
  };
}
