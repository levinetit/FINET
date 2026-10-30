/**
 * Constantele regulilor, FĂRĂ dependențe (nici `zod`): componentele de client le importă de aici,
 * ca schema `zod` din `rules.ts` să nu intre în pachetul JavaScript al paginii (bugetul CI).
 */

/**
 * Fără import din `@/db/schema` (modulul se folosește și în componentele de client): copiile
 * lui `LINE_KINDS` și `RULE_VERSION` sunt verificate de teste.
 */
export const RULE_VERSION = 1;
export const LINE_KINDS = ["product", "discount", "deposit_sgr", "bag", "other"] as const;

export const RULE_TYPES = ["exact", "prefix", "contains", "token"] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export const RULE_COMBINES = ["all", "any"] as const;

/** Plafoanele (decizia mea, ADR 0023). */
export const MAX_TERMS = 20;
export const MAX_TERM_LENGTH = 60;
export const MIN_TERM_LENGTH = 2;
export const MAX_FILTER_IDS = 10;

export type LineKindFilter = (typeof LINE_KINDS)[number];

/**
 * Tipurile de linii implicite ale unui raport nou: produsele, pungile și „altele”. Reducerile și
 * garanțiile SGR se aleg explicit (scad din total, respectiv sunt altceva decât o cumpărătură).
 */
export const DEFAULT_KINDS: readonly LineKindFilter[] = ["product", "bag", "other"];
