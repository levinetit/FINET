import { z } from "zod";

import { DB_CURRENCIES } from "@/db/schema";
import { askBodySchema, askQuerySchema } from "@/modules/ask/query";

import type { Operation } from "./registry";
import { dataOf } from "./schemas";

/**
 * Operația OpenAPI „Întreabă FINET” (Faza 10, F10-C; ADR 0025), adăugată la `OPERATIONS` printr-o
 * singură linie. Răspunsul real vine din `askFinet`; testele API îl verifică cu schema de mai jos.
 */

const currency = z.enum(DB_CURRENCIES);
const minor = z.number().int().meta({ description: "Sumă în unități minore (întreg, sub 2^53)." });
const date = z.iso.date().meta({ description: "Dată calendaristică `YYYY-MM-DD`." });

const answerSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("total"),
    rows: z.array(z.strictObject({ currency, totalMinor: minor, count: z.number().int().min(1) })),
  }),
  z.strictObject({
    kind: z.literal("ranking"),
    rows: z.array(
      z.strictObject({
        currency,
        items: z.array(
          z.strictObject({
            name: z.string().nullable(),
            amountMinor: minor,
            count: z.number().int().min(1),
          }),
        ),
      }),
    ),
  }),
]);

export const askResultSchema = z.discriminatedUnion("understood", [
  z.strictObject({
    understood: z.literal(true),
    query: askQuerySchema,
    queryText: z.string(),
    period: z.strictObject({ from: date, to: date, label: z.string() }),
    notes: z.array(z.string()),
    answer: answerSchema,
    text: z.string(),
  }),
  z.strictObject({
    understood: z.literal(false),
    reason: z.enum(["empty", "metric", "period"]),
    message: z.string(),
  }),
]);

export const ASK_OPERATIONS: readonly Operation[] = [
  {
    method: "POST",
    path: "/api/v1/ask",
    operationId: "askFinet",
    tag: "reports",
    summary: "„Întreabă FINET”: o întrebare în română despre cheltuielile sau veniturile tale.",
    description:
      "Întrebarea (3–300 de caractere) se transformă în cod într-o interogare dintr-un set ÎNCHIS (total de cheltuieli sau venituri pe o perioadă, opțional pe o categorie sau la un comerciant; clasamentul categoriilor sau al comercianților), validată strict; cifrele se calculează din baza de date, sub aceleași reguli de vizibilitate ca restul aplicației (fără conturile personale ale altor membri). Răspunsul conține MEREU interogarea folosită (`query`, `queryText`) și perioada. O întrebare care nu poate fi transformată primește 200 cu `understood: false` și un motiv fix (`empty`, `metric`, `period`), nu o presupunere. Nu se folosește niciun model AI și nimic nu pleacă din aplicație; textul întrebării nu se păstrează (nici în baza de date, nici în audit sau loguri). Rate limit propriu: 30/min per utilizator.",
    body: { schema: askBodySchema },
    success: { status: 200, schema: dataOf(askResultSchema), description: "Răspunsul." },
    errors: [400, 403, 415, 413],
  },
];
