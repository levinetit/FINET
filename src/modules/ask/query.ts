import { z } from "zod";

/**
 * „Întreabă FINET” (Faza 10, F10-C partea 2; ADR 0025): interogarea STRUCTURATĂ dintr-un set
 * ÎNCHIS de parametri. O întrebare în limbaj natural devine un obiect de forma de mai jos (prin
 * parserul din `parse.ts`; o variantă cu LLM ar produce exact aceeași formă), se validează strict
 * cu Zod, iar cifrele se calculează în cod din baza de date. Nu există text liber către SQL:
 * singurele valori libere sunt un id de categorie (uuid, verificat față de categoriile vizibile) și
 * numele unui comerciant (verificat față de comercianții gospodăriei, comparat exact).
 */

export const ASK_METRICS = [
  "expense_total",
  "income_total",
  "top_categories",
  "top_merchants",
] as const;
export type AskMetric = (typeof ASK_METRICS)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const askPeriodSchema = z
  .strictObject({ from: day, to: day })
  .refine((p) => p.from <= p.to, { message: "Perioada începe după ce se termină." });

export const askQuerySchema = z
  .strictObject({
    metric: z.enum(ASK_METRICS),
    period: askPeriodSchema,
    /** Categoria (și subcategoriile ei); doar pentru totaluri. */
    categoryId: z.uuid().optional(),
    /** Comerciantul, exact cum apare în tranzacții (fără diferența de majuscule); doar la cheltuieli. */
    merchant: z.string().min(2).max(120).optional(),
  })
  .refine((q) => !(q.metric.startsWith("top_") && (q.categoryId || q.merchant)), {
    message: "Clasamentele nu acceptă filtre.",
  })
  .refine((q) => !(q.metric === "income_total" && q.merchant), {
    message: "Comerciantul se filtrează doar la cheltuieli.",
  });

export type AskQuery = z.infer<typeof askQuerySchema>;

export const ASK_QUESTION_MAX = 300;
export const ASK_QUESTION_MIN = 3;

export const askBodySchema = z.strictObject({
  question: z.string().trim().min(ASK_QUESTION_MIN).max(ASK_QUESTION_MAX),
});
