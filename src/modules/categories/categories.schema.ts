import { z } from "zod";

import { CATEGORY_KINDS } from "@/db/schema";
import { idSchema, requiredName } from "@/modules/ledger/input";

/** Categoriile (5.4): de sistem (doar citire, ascundere per gospodărie) și personalizate. */

export const CATEGORY_NAME_MAX = 60;

const iconSchema = z
  .string()
  .refine((v) => /^[a-z0-9-]{1,40}$/.test(v), { message: "Pictogramă invalidă." })
  .nullable()
  .optional();
const colorSchema = z
  .string()
  .transform((v) => v.toLowerCase())
  .refine((v) => /^#[0-9a-f]{6}$/.test(v), { message: "Culoarea are forma #rrggbb." })
  .nullable()
  .optional();

export const categoryCreateSchema = z.strictObject({
  name: requiredName(CATEGORY_NAME_MAX),
  kind: z.enum(CATEGORY_KINDS),
  parentId: idSchema.nullable().optional(),
  icon: iconSchema,
  color: colorSchema,
});

/** Pentru o categorie de sistem se acceptă doar `hidden`. */
export const categoryUpdateSchema = z
  .strictObject({
    name: requiredName(CATEGORY_NAME_MAX).optional(),
    parentId: idSchema.nullable().optional(),
    icon: iconSchema,
    color: colorSchema,
    hidden: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Nimic de modificat.",
  });

export const categoryDeleteSchema = z
  .strictObject({
    // Categoria care preia tranzacțiile; obligatorie dacă categoria e folosită (5.6).
    reassignTo: idSchema.optional(),
  })
  .optional();

export const categoryListSchema = z
  .strictObject({
    kind: z.enum(CATEGORY_KINDS).optional(),
    includeHidden: z.boolean().optional(),
  })
  .optional();

export type CategoryView = Readonly<{
  id: string;
  name: string;
  kind: (typeof CATEGORY_KINDS)[number];
  parentId: string | null;
  icon: string | null;
  color: string | null;
  hidden: boolean;
  isSystem: boolean;
  systemKey: string | null;
}>;

export type CategoryJson = CategoryView;

export function categoryToJson(c: CategoryView): CategoryJson {
  return { ...c };
}
