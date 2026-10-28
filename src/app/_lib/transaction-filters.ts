/**
 * Filtrele listei de tranzacții (F2-C): din parametrii paginii (`/transactions?…`, scriși de
 * formularul GET) în interogarea API-ului `GET /api/v1/transactions` (nume exacte, parametri
 * goi eliminați, sumele ca întregi în unități minore). `readQuery` din API e strict: un parametru
 * necunoscut sau gol ar da 400, deci aici trec DOAR valorile completate și valide.
 *
 * Funcții pure, comune paginii (server) și butonului „Încarcă mai mult” (browser).
 */

import { parseAmountInput } from "./ledger-ui";

export const FILTER_TYPES = ["income", "expense", "transfer"] as const;
export const FILTER_SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"] as const;

/** Cel mult atâtea etichete într-un filtru (ca `MAX_TAGS_PER_TRANSACTION`). */
export const MAX_FILTER_TAGS = 10;

/** Valorile formularului (text, ca în URL). */
export type FilterValues = Readonly<{
  q: string;
  merchant: string;
  /** Etichetele bifate (parametrul `tagIds` repetat de formularul GET sau unul cu virgule). */
  tagIds: readonly string[];
  /** `any` (implicit) sau `all` (Faza 4). */
  tagMatch: string;
  accountId: string;
  categoryId: string;
  type: string;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  sort: string;
}>;

/** Interogarea API (numele din `TRANSACTION_QUERY`). */
export type TransactionApiQuery = Partial<
  Readonly<{
    q: string;
    merchant: string;
    accountId: string;
    categoryId: string;
    /** Serviciul primește lista; API-ul o primește într-un singur parametru, cu virgule. */
    tagIds: readonly string[];
    /** Trimis doar ca `all` și doar cu etichete (`any` e implicit în API). */
    tagMatch: "all";
    type: (typeof FILTER_TYPES)[number];
    dateFrom: string;
    dateTo: string;
    amountMinMinor: number;
    amountMaxMinor: number;
    sort: (typeof FILTER_SORTS)[number];
  }>
>;

export type ParsedFilters = Readonly<{
  values: FilterValues;
  query: TransactionApiQuery;
  /** Câmpurile respinse (de exemplu o sumă ambiguă), cu mesajul de afișat. */
  errors: Readonly<Record<string, string>>;
}>;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = [
  "q",
  "merchant",
  "accountId",
  "categoryId",
  "tagMatch",
  "type",
  "dateFrom",
  "dateTo",
  "amountMin",
  "amountMax",
  "sort",
] as const;

type RawParams = Readonly<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v.trim().slice(0, 200) : "";
}

/**
 * Etichetele din URL: parametrul repetat (`tagIds=a&tagIds=b`, scris de formularul GET) sau un
 * singur parametru cu virgule (`tagIds=a,b`, forma API-ului). Doar uuid-uri, fără duplicate, cel
 * mult `MAX_FILTER_TAGS` (restul se ignoră).
 */
export function parseTagIds(value: string | string[] | undefined): string[] {
  const list = (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => UUID.test(v));
  return [...new Set(list)].slice(0, MAX_FILTER_TAGS);
}

/**
 * Parametrii paginii → valori + interogare. Valorile invalide (id-uri, date, tipuri) se ignoră
 * în tăcere; sumele invalide sau ambigue apar în `errors` (utilizatorul le-a scris).
 */
export function parseFilters(params: RawParams): ParsedFilters {
  const text = Object.fromEntries(KEYS.map((k) => [k, first(params[k])])) as Record<
    (typeof KEYS)[number],
    string
  >;
  const tagIds = parseTagIds(params.tagIds);
  const values = { ...text, tagIds };
  const query: Record<string, string | number | readonly string[]> = {};
  const errors: Record<string, string> = {};
  if (values.q) query.q = values.q;
  if (values.merchant) query.merchant = values.merchant;
  if (tagIds.length > 0) query.tagIds = tagIds;
  // `tagMatch=all` fără etichete bifate se ignoră: API-ul l-ar refuza (400).
  if (tagIds.length > 0 && values.tagMatch === "all") query.tagMatch = "all";
  if (UUID.test(values.accountId)) query.accountId = values.accountId.toLowerCase();
  if (UUID.test(values.categoryId)) query.categoryId = values.categoryId.toLowerCase();
  if ((FILTER_TYPES as readonly string[]).includes(values.type)) query.type = values.type;
  if (DATE.test(values.dateFrom)) query.dateFrom = values.dateFrom;
  if (DATE.test(values.dateTo)) query.dateTo = values.dateTo;
  if ((FILTER_SORTS as readonly string[]).includes(values.sort)) query.sort = values.sort;
  // Toate monedele au două zecimale: intervalul de sume se parsează ca RON (decizia mea).
  for (const [field, key] of [
    ["amountMin", "amountMinMinor"],
    ["amountMax", "amountMaxMinor"],
  ] as const) {
    if (!values[field]) continue;
    const parsed = parseAmountInput(values[field], "RON", { positive: true });
    if (parsed.ok) query[key] = parsed.amountMinor;
    else errors[field] = parsed.message;
  }
  return { values, query: query as TransactionApiQuery, errors };
}

/** Interogarea → parametrii API (un singur `tagIds`, cu virgule: `readQuery` refuză repetiția). */
function apiParams(query: TransactionApiQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join(",");
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

/** Interogarea → șirul `?…` al API-ului, cu cursorul paginii următoare (dacă există). */
export function apiSearch(query: TransactionApiQuery, cursor?: string | null): string {
  const params = new URLSearchParams(apiParams(query));
  if (cursor) params.set("cursor", cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * Parametrii exportului CSV de tranzacții: aceleași filtre ca lista, FĂRĂ `sort` (exportul e
 * cronologic; ruta de export refuză `sort`, `cursor`, `limit`).
 */
export function exportSearch(query: TransactionApiQuery): Record<string, string> {
  const params = apiParams(query);
  delete params.sort;
  return params;
}

/** Adaugă rândurile noi fără duplicate (după `id`), păstrând ordinea. */
export function appendUnique<T extends Readonly<{ id: string }>>(
  current: readonly T[],
  next: readonly T[],
): T[] {
  const seen = new Set(current.map((r) => r.id));
  const out = [...current];
  for (const row of next) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** Există cel puțin un filtru activ (pentru mesajul de listă goală). */
export function hasActiveFilters(query: TransactionApiQuery): boolean {
  return Object.keys(query).some((k) => k !== "sort");
}
