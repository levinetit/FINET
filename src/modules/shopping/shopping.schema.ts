import { z } from "zod";

import {
  SHOPPING_ITEM_NAME_MAX,
  SHOPPING_ITEM_NOTE_MAX,
  SHOPPING_ITEM_UNIT_MAX,
  SHOPPING_LIST_NAME_MAX,
  SHOPPING_LIST_STATUSES,
  SHOPPING_MAX_ITEMS_PER_LIST,
} from "@/db/schema";
import { idSchema } from "@/modules/ledger/input";
import { cleanText, normalizeProductName } from "@/modules/receipts/normalize";

/**
 * Intrările și ieșirile listelor de cumpărături (Faza 10, F10-A; ADR 0022). Zod strict: o cheie
 * necunoscută (de exemplu `householdId`, `ownerUserId`) e respinsă. Cantitățile sunt ȘIRURI zecimale
 * (`numeric(9,3)`), niciodată `Number`: un număr JSON se acceptă doar dacă se scrie exact ca text.
 */

/** Textul curățat (fără caractere de control/bidi, spații comprimate); `null` dacă rămâne gol. */
function cleaned(max: number) {
  return z
    .string()
    .max(max * 4)
    .transform((v) => cleanText(v, max * 4))
    .refine((v): v is string => v !== null && Array.from(v).length <= max, {
      message: `Între 1 și ${max} caractere.`,
    });
}

/** Numele unei liste: 1..100 de caractere. */
export const listNameSchema = cleaned(SHOPPING_LIST_NAME_MAX);

/** Numele unui articol: 1..120 de caractere și măcar o literă sau cifră (altfel nu se poate potrivi). */
export const itemNameSchema = cleaned(SHOPPING_ITEM_NAME_MAX).refine(
  (v) => normalizeProductName(v) !== null,
  { message: "Numele trebuie să conțină litere sau cifre." },
);

const optionalCleaned = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((v) => cleanText(v, max * 4))
    .refine((v) => v === null || Array.from(v).length <= max, {
      message: `Cel mult ${max} caractere.`,
    })
    .nullable();

/** Unitatea (`buc`, `kg`, `l`…): text scurt opțional; golul devine `null`. */
export const unitSchema = optionalCleaned(SHOPPING_ITEM_UNIT_MAX);
/** Nota unui articol: text scurt opțional; golul devine `null`. */
export const noteSchema = optionalCleaned(SHOPPING_ITEM_NOTE_MAX);

const QUANTITY_RE = /^\d{1,6}(?:\.\d{1,3})?$/;

/**
 * Cantitatea: text zecimal (virgula se acceptă ca separator) sau număr JSON; > 0 și < 1.000.000,
 * cel mult 3 zecimale. Rezultatul e forma canonică (`"2"`, `"0.5"`), ca textul din bază.
 */
export const quantitySchema = z
  .union([z.string().max(14), z.number().finite()])
  .transform((v) => String(v).trim().replace(",", "."))
  .refine((v) => QUANTITY_RE.test(v) && /[1-9]/.test(v), {
    message: "Cantitatea e un număr pozitiv cu cel mult 3 zecimale.",
  })
  .transform(canonicalQuantity);

/** `"2.000"` → `"2"`, `"0.500"` → `"0.5"`, `"007"` → `"7"` (fără float, doar text). */
export function canonicalQuantity(value: string): string {
  const [int = "0", frac = ""] = value.split(".");
  const i = int.replace(/^0+(?=\d)/, "");
  const f = frac.replace(/0+$/, "");
  return f === "" ? i : `${i}.${f}`;
}

export const itemCreateSchema = z.strictObject({
  name: itemNameSchema,
  quantity: quantitySchema.optional(),
  unit: unitSchema.optional(),
  note: noteSchema.optional(),
});

export const itemUpdateSchema = z
  .strictObject({
    name: itemNameSchema.optional(),
    quantity: quantitySchema.optional(),
    unit: unitSchema.optional(),
    note: noteSchema.optional(),
    /** Starea EXPLICITĂ (nu un comutator): a doua cerere identică nu schimbă nimic. */
    checked: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const listCreateSchema = z.strictObject({
  name: listNameSchema,
  /** `true` = listă personală (o vezi doar tu); implicit comună. */
  personal: z.boolean().optional(),
  items: z.array(itemCreateSchema).max(SHOPPING_MAX_ITEMS_PER_LIST).optional(),
});

export const listUpdateSchema = z
  .strictObject({
    name: listNameSchema.optional(),
    status: z.enum(SHOPPING_LIST_STATUSES).optional(),
    /** Singura trecere permisă: o listă personală devine comună (`shared: true`). */
    shared: z.literal(true).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const listCopySchema = z.strictObject({
  name: listNameSchema.optional(),
  personal: z.boolean().optional(),
});

export const listFilterSchema = z
  .strictObject({ status: z.enum(SHOPPING_LIST_STATUSES).optional() })
  .optional();

export const reorderSchema = z.strictObject({
  itemIds: z.array(idSchema).min(1).max(SHOPPING_MAX_ITEMS_PER_LIST),
});

export const suggestionsQuerySchema = z
  .strictObject({ q: z.string().max(60).optional() })
  .optional();

/** Acțiunile utilizatorului asupra propunerii unui articol (ADR 0022 §4). */
export const matchActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("confirm") }),
  z.strictObject({ action: z.literal("reject") }),
  z.strictObject({ action: z.literal("clear") }),
  /** Corecția manuală: articolul e legat de o altă linie a unui bon confirmat. */
  z.strictObject({ action: z.literal("set"), receiptLineId: idSchema }),
]);
export type MatchAction = z.infer<typeof matchActionSchema>;

export const comparisonRunSchema = z.strictObject({ receiptId: idSchema });

// --- Ieșiri ------------------------------------------------------------------------------------

export type MatchState = Readonly<{
  status: "none" | "suggested" | "confirmed" | "rejected";
  score: number | null;
  source: "code" | "learned" | "ai" | "manual" | null;
  receiptLineId: string | null;
}>;

export type ListView = Readonly<{
  id: string;
  name: string;
  /** `true` = listă comună (toți membrii); `false` = personală (doar proprietarul). */
  shared: boolean;
  status: (typeof SHOPPING_LIST_STATUSES)[number];
  itemCount: number;
  checkedCount: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ItemView = Readonly<{
  id: string;
  listId: string;
  name: string;
  quantity: string;
  unit: string | null;
  note: string | null;
  checked: boolean;
  checkedAt: Date | null;
  /** `true` dacă l-a bifat utilizatorul curent, `false` dacă altcineva, `null` dacă nu e bifat. */
  checkedByMe: boolean | null;
  position: number;
  match: MatchState;
}>;

export type ListWithItems = Readonly<{ list: ListView; items: readonly ItemView[] }>;

export type ListJson = Omit<ListView, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};
export type ItemJson = Omit<ItemView, "checkedAt"> & { checkedAt: string | null };

export function listToJson(l: ListView): ListJson {
  return { ...l, createdAt: l.createdAt.toISOString(), updatedAt: l.updatedAt.toISOString() };
}

export function itemToJson(i: ItemView): ItemJson {
  return { ...i, checkedAt: i.checkedAt ? i.checkedAt.toISOString() : null };
}

export type ListWithItemsJson = { list: ListJson; items: ItemJson[] };

export function listWithItemsToJson(v: ListWithItems): ListWithItemsJson {
  return { list: listToJson(v.list), items: v.items.map(itemToJson) };
}
