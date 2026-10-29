import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AiClient,
  type Pricing,
  costOfTokens,
  createAiClient,
  parseModelJson,
} from "@/lib/ai";
import { type MockAiServer, startMockAiServer } from "@/lib/ai/mock-server";
import {
  applyKindRules,
  categorizeJsonSchema,
  categorizeLines,
} from "@/modules/receipts/categorize";
import { checkReceipt, confidenceScore } from "@/modules/receipts/checks";
import { normalizeTaxId } from "@/modules/receipts/cui";
import {
  type ExtractedReceipt,
  RECEIPT_JSON_SCHEMA,
  parseModelReceipt,
  toExtractedReceipt,
} from "@/modules/receipts/extraction.schema";
import { mergeReceiptParts } from "@/modules/receipts/merge";
import { normalizeProductName } from "@/modules/receipts/normalize";
import {
  CATEGORIZE_MAX_TOKENS,
  RECEIPT_MAX_TOKENS,
  categorizeMessages,
  pdfTextForPrompt,
  receiptTextMessages,
  receiptVisionMessages,
} from "@/modules/receipts/prompts";
import { RO_VAT_RATES_FALLBACK } from "@/modules/receipts/vat";
import { preprocessDocument } from "@/worker/receipts/preprocess";

import { type Fixture, FIXTURES, fontsAvailable, renderFixture } from "./make-receipt-fixtures.mjs";

/**
 * `pnpm eval:receipts` (Faza 6, F6-B; ADR 0014): rulează pipeline-ul (preprocesare → extragere →
 * unire → verificări → scor → categorisire) pe bonurile SINTETICE din
 * `scripts/make-receipt-fixtures.mjs` și raportează acuratețea pe total, dată, CUI, linii,
 * categorii, rata „De verificat”, timpul mediu și costul estimat.
 *
 * - Implicit: serverul AI FALS (modul „mock”; răspunsuri deterministe derivate din adevăr, cu o
 *   eroare intenționată pe `zgomot-estompat`): verifică traseul, NU calitatea unui model.
 * - `AI_EVAL=1` + `AI_BASE_URL` + `AI_API_KEY_FILE` (+ `AI_ALLOWED_HOSTS`, modelele): LiteLLM
 *   REAL. Fiecare bon = 1–3 apeluri vision/text + 1 de categorisire; costul se afișează.
 * Acuratețea pe date sintetice NU înlocuiește evaluarea pe bonuri reale (de făcut de operator).
 * Nu atinge baza de date. Raportul: stdout + `fixtures/receipts/generated/eval-report.json`.
 */

const REAL = process.env.AI_EVAL === "1";
const CATEGORIES = ["Alimente", "Igienă și cosmetice", "Casă și reparații", "Altele"].map(
  (name, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i + 1}`,
    name,
  }),
);
const PRICING: Pricing = { inputPerMTokMinor: 50n, outputPerMTokMinor: 300n };
const TODAY = "2026-10-29";
const THRESHOLD = 80;

/** Răspunsul „modelului” fals: adevărul în forma cerută, cu o eroare intenționată pe un bon. */
function mockReceiptJson(gt: Fixture, part: number | null, parts: number): string {
  const lines = gt.lines.map((l) => ({
    name: l.name,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
    vatRate: l.vatRate,
    type: l.type,
  }));
  let chunk = lines;
  let header = true;
  let total = true;
  if (part !== null) {
    const per = Math.ceil(lines.length / parts);
    const from = Math.max(0, part * per - (part > 0 ? (gt.variant.overlap ?? 0) : 0));
    chunk = lines.slice(from, (part + 1) * per);
    header = part === 0;
    total = part === parts - 1;
  }
  const wrongTotal = gt.id === "zgomot-estompat";
  return JSON.stringify({
    merchantName: header ? gt.merchantName : null,
    merchantTaxId: header ? gt.merchantTaxId : null,
    storeAddress: header ? gt.storeAddress : null,
    receiptNumber: total ? gt.receiptNumber : null,
    date: total ? gt.date : null,
    paymentMethod: total ? gt.paymentMethod : null,
    currency: "RON",
    total: total
      ? wrongTotal
        ? (Number.parseInt(gt.total, 10) + 1).toString() + gt.total.slice(gt.total.indexOf("."))
        : gt.total
      : null,
    vatTotal: total ? gt.vatTotal : null,
    lines: chunk,
  });
}

type Metrics = {
  id: string;
  total: boolean;
  date: boolean;
  taxId: boolean;
  linesF1: number;
  categories: number | null;
  needsReview: boolean;
  issues: string[];
  ms: number;
  costMinor: bigint;
};

const minor = (s: string) => {
  const [i, f = ""] = s.split(".");
  return BigInt(i!) * 100n + BigInt(f.padEnd(2, "0"));
};

describe("evaluarea bonurilor sintetice", () => {
  let mock: MockAiServer | null = null;
  let client: AiClient;
  let vision = "finet-vision-external";
  let text = "finet-text-external";
  const results: Metrics[] = [];
  let usage = { prompt: 0, completion: 0 };

  beforeAll(async () => {
    if (REAL) {
      const keyFile = process.env.AI_API_KEY_FILE;
      if (!process.env.AI_BASE_URL || !keyFile)
        throw new Error("AI_EVAL=1 cere AI_BASE_URL și AI_API_KEY_FILE");
      client = createAiClient({
        baseUrl: process.env.AI_BASE_URL,
        apiKey: readFileSync(keyFile, "utf8").trim(),
        allowedHosts: (process.env.AI_ALLOWED_HOSTS ?? "172.88.88.4:4000").split(","),
        timeoutMs: 90_000,
        maxRetries: 1,
      });
      vision = process.env.AI_VISION_MODEL ?? vision;
      text = process.env.AI_TEXT_MODEL ?? text;
    } else {
      mock = await startMockAiServer();
      client = createAiClient({
        baseUrl: mock.baseUrl,
        apiKey: "sk-mock-eval-0000000000",
        allowedHosts: [mock.host],
        timeoutMs: 5_000,
        maxRetries: 0,
      });
    }
  });
  afterAll(async () => {
    await mock?.close();
  });

  it("rulează pipeline-ul pe toate bonurile și scrie raportul", { timeout: 900_000 }, async () => {
    const fonts = await fontsAvailable();
    for (const gt of FIXTURES) {
      const started = Date.now();
      const files = await renderFixture(gt);
      const parts: ExtractedReceipt[] = [];
      let cost = 0n;
      for (const [p, file] of files.entries()) {
        const pre = await preprocessDocument(file.data, file.mime, {
          maxImagePixels: 50_000_000,
          maxPdfPages: 6,
          timeoutMs: 60_000,
        });
        if (mock) {
          mock.enqueue({
            kind: "content",
            content: mockReceiptJson(gt, files.length > 1 ? p : null, files.length),
          });
        }
        const r = await client.chat({
          model: pre.kind === "text" ? text : vision,
          messages:
            pre.kind === "text"
              ? receiptTextMessages(pdfTextForPrompt(pre.text))
              : receiptVisionMessages(pre.images.map((i) => i.jpeg)),
          maxTokens: RECEIPT_MAX_TOKENS,
          jsonSchema: { name: "receipt", schema: RECEIPT_JSON_SCHEMA },
        });
        if (r.usage) {
          usage = {
            prompt: usage.prompt + r.usage.promptTokens,
            completion: usage.completion + r.usage.completionTokens,
          };
          cost += costOfTokens(PRICING, r.usage.promptTokens, r.usage.completionTokens);
        }
        try {
          parts.push(toExtractedReceipt(parseModelReceipt(parseModelJson(r.content))));
        } catch {
          // Răspuns invalid: bonul intră la „De verificat” fără date.
        }
      }
      let receipt: ExtractedReceipt | null = null;
      const issues: string[] = [];
      if (parts.length === files.length) {
        if (parts.length === 1) receipt = parts[0]!;
        else {
          const m = mergeReceiptParts(parts);
          if (m.ok) receipt = m.receipt;
          else issues.push("long_receipt_order");
        }
      } else issues.push("extraction_failed");

      let categoriesScore: number | null = null;
      let linesF1 = 0;
      if (receipt) {
        receipt = { ...receipt, lines: applyKindRules(receipt.lines) };
        const found = checkReceipt(receipt, { today: TODAY, vatRates: RO_VAT_RATES_FALLBACK });
        issues.push(...found.map((i) => i.code));
        if (confidenceScore(found) < THRESHOLD) issues.push("low_confidence");
        const byName = new Map(gt.lines.map((l) => [normalizeProductName(l.name), l] as const));
        const cats = await categorizeLines({
          lines: receipt.lines,
          aliases: new Map(),
          categories: CATEGORIES,
          llm: async (request) => {
            if (mock) {
              const codes = new Map(request.categories.map((c) => [c.name, c.code] as const));
              mock.enqueue({
                kind: "content",
                content: JSON.stringify({
                  items: request.items.map((it) => ({
                    i: it.i,
                    c: codes.get(byName.get(it.name)?.category ?? "") ?? null,
                  })),
                }),
              });
            }
            const r = await client.chat({
              model: text,
              messages: categorizeMessages(request),
              maxTokens: CATEGORIZE_MAX_TOKENS,
              jsonSchema: {
                name: "categories",
                schema: categorizeJsonSchema(request.categories.map((c) => c.code)),
              },
            });
            if (r.usage)
              cost += costOfTokens(PRICING, r.usage.promptTokens, r.usage.completionTokens);
            return parseModelJson(r.content);
          },
        });
        // Liniile: potrivire după nume normalizat + total (F1); categoriile pe liniile potrivite.
        const remaining = [...gt.lines];
        let matched = 0;
        let catOk = 0;
        let catTotal = 0;
        receipt.lines.forEach((l, idx) => {
          const k = remaining.findIndex(
            (g) =>
              normalizeProductName(g.name) === l.normalizedName &&
              minor(g.lineTotal) === l.lineTotalMinor,
          );
          if (k < 0) return;
          const [g] = remaining.splice(k, 1);
          matched++;
          if (g!.category) {
            catTotal++;
            const name = CATEGORIES.find((c) => c.id === cats[idx]?.categoryId)?.name;
            if (name === g!.category) catOk++;
          }
        });
        const precision = receipt.lines.length ? matched / receipt.lines.length : 0;
        const recall = gt.lines.length ? matched / gt.lines.length : 0;
        linesF1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
        categoriesScore = catTotal ? catOk / catTotal : null;
      }
      results.push({
        id: gt.id,
        total: receipt?.totalMinor === minor(gt.total),
        date: receipt?.occurredOn === gt.date,
        taxId: receipt !== null && receipt.merchantTaxId === normalizeTaxId(gt.merchantTaxId),
        linesF1,
        categories: categoriesScore,
        needsReview: issues.length > 0,
        issues,
        ms: Date.now() - started,
        costMinor: cost,
      });
    }

    const n = results.length;
    const rate = (f: (m: Metrics) => boolean) => results.filter(f).length / n;
    const cats = results.map((r) => r.categories).filter((x): x is number => x !== null);
    const report = {
      mode: REAL ? "real (LiteLLM)" : "mock (server AI fals; NU măsoară un model)",
      fontsAvailable: fonts,
      warning:
        "Bonuri SINTETICE: acuratețea de aici NU înlocuiește evaluarea pe bonuri reale (de făcut de operator).",
      receipts: n,
      accuracy: {
        total: rate((m) => m.total),
        date: rate((m) => m.date),
        taxId: rate((m) => m.taxId),
        linesF1: results.reduce((s, m) => s + m.linesF1, 0) / n,
        categories: cats.length ? cats.reduce((s, x) => s + x, 0) / cats.length : null,
      },
      needsReviewRate: rate((m) => m.needsReview),
      avgMs: Math.round(results.reduce((s, m) => s + m.ms, 0) / n),
      estimatedCostMinor: results.reduce((s, m) => s + m.costMinor, 0n).toString(),
      estimatedCostCurrency: "USD (tarifele implicite din config, per 1M tokeni)",
      tokens: usage,
      perReceipt: results.map((m) => ({ ...m, costMinor: m.costMinor.toString() })),
    };
    const out = join(process.cwd(), "fixtures/receipts/generated");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "eval-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));

    if (!REAL) {
      // În modul mock traseul trebuie să fie exact: doar bonul cu eroarea intenționată pică.
      expect(results.filter((m) => !m.total).map((m) => m.id)).toEqual(["zgomot-estompat"]);
      expect(results.filter((m) => m.needsReview).map((m) => m.id)).toEqual(["zgomot-estompat"]);
      expect(report.accuracy.linesF1).toBe(1);
      expect(report.accuracy.categories).toBe(1);
    }
  });
});
