import { z } from "zod";

import { DB_CURRENCIES } from "@/db/schema";
import { askBodySchema, askQuerySchema } from "@/modules/ask/query";
import { SUMMARY_LABEL } from "@/modules/summary/summary";

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
    source: z.enum(["rules", "ai"]).meta({
      description: "`rules` = parserul din cod; `ai` = tradusă de un model extern (ADR 0026).",
    }),
    query: askQuerySchema,
    queryText: z.string(),
    period: z.strictObject({ from: date, to: date, label: z.string() }),
    notes: z.array(z.string()),
    answer: answerSchema,
    text: z.string(),
  }),
  z.strictObject({
    understood: z.literal(false),
    reason: z.enum(["empty", "metric", "period", "name"]),
    message: z.string(),
    aiHint: z
      .enum(["consent", "budget", "error"])
      .nullable()
      .meta({ description: "De ce n-a ajutat pasul cu AI (când e pornit)." }),
  }),
]);

const summarySchema = z.strictObject({
  month: z.string().regex(/^[0-9]{4}-[0-9]{2}$/),
  label: z.literal(SUMMARY_LABEL),
  lines: z.array(
    z.strictObject({
      code: z.enum(["empty", "totals", "change", "top_categories", "top_merchant", "budgets"]),
      currency: currency.nullable(),
      text: z.string(),
    }),
  ),
});

export const ASK_OPERATIONS: readonly Operation[] = [
  {
    method: "POST",
    path: "/api/v1/ask",
    operationId: "askFinet",
    tag: "reports",
    summary: "„Întreabă FINET”: o întrebare în română despre cheltuielile sau veniturile tale.",
    description:
      "Întrebarea (3–300 de caractere) se transformă în cod într-o interogare dintr-un set ÎNCHIS (total de cheltuieli sau venituri pe o perioadă, opțional pe o categorie sau la un comerciant; clasamentul categoriilor sau al comercianților), validată strict; cifrele se calculează din baza de date, sub aceleași reguli de vizibilitate ca restul aplicației (fără conturile personale ale altor membri). Răspunsul conține MEREU interogarea folosită (`query`, `queryText`) și perioada. O întrebare care nu poate fi transformată primește 200 cu `understood: false` și un motiv fix (`empty`, `metric`, `period`), nu o presupunere. Implicit nu se folosește niciun model AI și nimic nu pleacă din aplicație. Cu `AI_ASK=1` (ADR 0026), o întrebare pe care parserul din cod n-a înțeles-o se poate traduce cu un model extern, DOAR cu consimțământul `external_ai` și în bugetul AI: pleacă textul întrebării și numele categoriilor (nu sume, comercianți sau tranzacții); răspunsul are `source` = `ai`, iar un nume necunoscut sau o ieșire invalidă se refuză. Textul întrebării nu se păstrează (nici în baza de date, nici în audit sau loguri); `ai_calls` păstrează doar metadate. Rate limit propriu: 30/min per utilizator.",
    body: { schema: askBodySchema },
    success: { status: 200, schema: dataOf(askResultSchema), description: "Răspunsul." },
    errors: [400, 403, 415, 413],
  },
  {
    method: "GET",
    path: "/api/v1/summary/monthly",
    operationId: "getMonthlySummary",
    tag: "reports",
    summary: "Rezumatul lunii: propoziții construite în cod din cifrele agregate.",
    description:
      "Luna cerută (implicit cea curentă, aceleași limite ca raportul lunar) comparată cu cea precedentă: totaluri, variația cheltuielilor, primele categorii, primul comerciant, starea bugetelor. Fiecare cifră din text e inserată din baza de date; nu se folosește niciun model AI. Etichetă fixă: „Rezumat automat, nu sfat financiar.” Vizibilitate ca la raportul lunar (fără conturile personale ale altor membri).",
    query: [
      {
        name: "month",
        schema: z.string().regex(/^[0-9]{4}-[0-9]{2}$/),
        description: "Luna `YYYY-MM` (implicit luna curentă).",
      },
    ],
    success: { status: 200, schema: dataOf(summarySchema), description: "Rezumatul." },
    errors: [400],
  },
];
