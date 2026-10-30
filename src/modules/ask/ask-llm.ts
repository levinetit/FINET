import { z } from "zod";

import type { ChatMessage } from "@/lib/ai";

import { type AskContext, normalizeText } from "./parse";
import { periodSpecSchema, resolvePeriod } from "./period";
import { ASK_METRICS, type AskQuery, askQuerySchema } from "./query";

/**
 * Traducerea întrebării cu LLM (F10-C, pasul LLM; ADR 0026), partea PURĂ: cererea, schema ieșirii
 * și validarea răspunsului. Se folosește DOAR când parserul din cod nu a înțeles întrebarea.
 *
 * Ce pleacă către model: textul întrebării, data de azi și NUMELE categoriilor vizibile. Nu pleacă
 * sume, tranzacții, comercianți sau conturi. Modelul nu face aritmetică de date și nu vede id-uri:
 * răspunde cu o interogare din SETUL ÎNCHIS (metrică, perioadă ca specificație, nume de categorie și
 * de comerciant), iar CODUL rezolvă perioada, potrivește numele cu categoriile și comercianții
 * gospodăriei (egalitate după normalizare) și validează totul cu aceeași schemă strictă ca parserul.
 * Un nume care nu se potrivește cu nimic NU se ignoră în tăcere: întrebarea e refuzată. Modelul
 * doar PROPUNE; răspunsul arată mereu interogarea folosită.
 */

export const ASK_LLM_MAX_TOKENS = 300;
export const ASK_LLM_MAX_CATEGORIES = 80;

const SYSTEM = [
  "Transformi o întrebare despre cheltuielile sau veniturile cuiva într-o interogare structurată. You convert a Romanian question about personal spending into a structured query.",
  "Primești JSON: today (data de azi), question (întrebarea) și categories (numele categoriilor existente).",
  'Răspunde DOAR cu JSON: {"understood":bool,"metric":"expense_total"|"income_total"|"top_categories"|"top_merchants"|null,"period":{...}|null,"category":string|null,"merchant":string|null}.',
  "metric: expense_total = cât s-a cheltuit; income_total = cât s-a încasat; top_categories = pe ce categorii s-a cheltuit cel mai mult; top_merchants = la ce comercianți.",
  'period (obiect, nu date): {"kind":"today"|"yesterday"|"this_week"|"last_week"|"this_month"|"last_month"|"this_year"|"last_year"} sau {"kind":"last_n_months","n":1-24} sau {"kind":"last_n_days","n":1-366} sau {"kind":"month","month":"AAAA-LL"} sau {"kind":"year","year":AAAA}. Nu calcula date; dacă întrebarea nu spune perioada, folosește null.',
  "category: EXACT unul dintre numele din categories, sau null. merchant: numele comerciantului așa cum e scris în întrebare, sau null. Pentru top_categories și top_merchants, category și merchant sunt null.",
  "Dacă întrebarea nu e despre cheltuieli sau venituri, răspunde understood=false și restul null. Nu inventa. Nu răspunde la întrebare, doar o transformi.",
].join("\n");

export type AskLlmRequest = Readonly<{
  today: string;
  question: string;
  categories: readonly string[];
}>;

export function buildAskRequest(
  question: string,
  ctx: Pick<AskContext, "today" | "categories">,
): AskLlmRequest {
  return {
    today: ctx.today,
    question,
    categories: ctx.categories.slice(0, ASK_LLM_MAX_CATEGORIES).map((c) => c.name),
  };
}

export function askLlmMessages(request: AskLlmRequest): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: JSON.stringify(request) },
  ];
}

export const askLlmResponseSchema = z.strictObject({
  understood: z.boolean(),
  metric: z.enum(ASK_METRICS).nullable(),
  period: periodSpecSchema.nullable(),
  category: z.string().max(100).nullable(),
  merchant: z.string().max(120).nullable(),
});
export type AskLlmResponse = z.infer<typeof askLlmResponseSchema>;

/** Schema JSON a ieșirii (pentru `AI_RESPONSE_FORMAT=json_schema`). */
export function askLlmJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["understood", "metric", "period", "category", "merchant"],
    properties: {
      understood: { type: "boolean" },
      metric: { type: ["string", "null"], enum: [...ASK_METRICS, null] },
      period: { type: ["object", "null"] },
      category: { type: ["string", "null"], maxLength: 100 },
      merchant: { type: ["string", "null"], maxLength: 120 },
    },
  };
}

export type AskLlmResolution =
  | Readonly<{
      ok: true;
      query: AskQuery;
      periodLabel: string;
      notes: readonly string[];
    }>
  | Readonly<{ ok: false; reason: "metric" | "period" | "name" }>;

/**
 * Răspunsul modelului → interogare validată. Aruncă `ZodError` dacă răspunsul nu respectă schema
 * (apelantul îl socotește `failed_validation`). Un nume de categorie sau de comerciant fără
 * potrivire → `{ ok: false, reason: "name" }` (nu se ignoră în tăcere).
 */
export function resolveAskLlm(
  raw: unknown,
  ctx: Pick<AskContext, "today" | "categories" | "merchants">,
): AskLlmResolution {
  const a = askLlmResponseSchema.parse(raw);
  if (!a.understood || a.metric === null) return { ok: false, reason: "metric" };
  const notes: string[] = [];
  let label = "luna curentă";
  let period = resolvePeriod({ kind: "this_month" }, ctx.today)!;
  if (a.period === null) {
    notes.push("Perioada nu a fost menționată: am folosit luna curentă.");
  } else {
    const resolved = resolvePeriod(a.period, ctx.today);
    if (resolved === null) return { ok: false, reason: "period" };
    period = resolved;
    label = resolved.label;
  }

  const query: { -readonly [K in keyof AskQuery]: AskQuery[K] } = {
    metric: a.metric,
    period: { from: period.from, to: period.to },
  };
  if (a.metric.startsWith("top_")) {
    if (a.category !== null || a.merchant !== null) {
      notes.push("Clasamentele nu au filtre: am ignorat categoria și comerciantul.");
    }
  } else {
    if (a.category !== null) {
      const wanted = normalizeText(a.category);
      const found = ctx.categories.find((c) => normalizeText(c.name) === wanted);
      if (!found) return { ok: false, reason: "name" };
      query.categoryId = found.id;
    }
    if (a.merchant !== null) {
      if (a.metric !== "expense_total") {
        notes.push("Comerciantul se filtrează doar la cheltuieli: l-am ignorat.");
      } else {
        const wanted = normalizeText(a.merchant);
        const found = ctx.merchants.find((m) => normalizeText(m) === wanted);
        if (!found) return { ok: false, reason: "name" };
        query.merchant = found;
      }
    }
  }
  // Aceeași schemă strictă ca la parser.
  return { ok: true, query: askQuerySchema.parse(query), periodLabel: label, notes };
}
