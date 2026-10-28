import { z } from "zod";

import { idSchema, requiredName } from "@/modules/ledger/input";

/**
 * Etichetele (5.4, Faza 3): a doua dimensiune, liberă, a tranzacțiilor. De sistem (doar citire,
 * ascundere per gospodărie) sau ale gospodăriei. Zod strict: `householdId` e respins.
 */

export const TAG_NAME_MAX = 40;
/** Cel mult atâtea etichete pe o tranzacție (și într-un filtru). */
export const MAX_TAGS_PER_TRANSACTION = 10;

const colorSchema = z
  .string()
  .max(20)
  .transform((v) => v.toLowerCase())
  .refine((v) => /^#[0-9a-f]{6}$/.test(v), { message: "Culoarea are forma #rrggbb." })
  .nullable()
  .optional();

export const tagCreateSchema = z.strictObject({
  name: requiredName(TAG_NAME_MAX),
  color: colorSchema,
});

/** Pentru o etichetă de sistem se acceptă doar `hidden`. */
export const tagUpdateSchema = z
  .strictObject({
    name: requiredName(TAG_NAME_MAX).optional(),
    color: colorSchema,
    hidden: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const tagListSchema = z.strictObject({ includeHidden: z.boolean().optional() }).optional();

/** Lista de etichete a unei tranzacții (sau a unui filtru): id-uri distincte, cel mult 10. */
export const tagIdsSchema = z
  .array(idSchema)
  .max(MAX_TAGS_PER_TRANSACTION, `Cel mult ${MAX_TAGS_PER_TRANSACTION} etichete.`)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Etichete repetate." });

export type TagView = Readonly<{
  id: string;
  name: string;
  color: string | null;
  hidden: boolean;
  isSystem: boolean;
  systemKey: string | null;
  /** Numărul de tranzacții ale gospodăriei care au eticheta. */
  usageCount: number;
}>;

export type TagJson = TagView;

export function tagToJson(t: TagView): TagJson {
  return { ...t };
}
