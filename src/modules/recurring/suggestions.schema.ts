import { z } from "zod";

import { dateSchema } from "@/modules/ledger/input";

/** Intrările propunerilor de plăți recurente (Zod strict; ADR 0019). Fără dependențe de server. */

export const signatureSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const acceptSuggestionSchema = z.strictObject({
  /** Prima scadență a regulii; implicit următoarea dată așteptată. */
  startOn: dateSchema.optional(),
});
