import "server-only";

import { createHash } from "node:crypto";

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import {
  documents,
  processingBatches,
  productAliases,
  receiptLines,
  receipts,
  aiCalls,
  vatRates,
} from "@/db/schema";
import {
  type AiClient,
  AiError,
  type ChatMessage,
  type Pricing,
  actualCostOf,
  aiCallResultOf,
  maxCostOf,
  parseModelJson,
  providerOf,
} from "@/lib/ai";
import { type Actor, NotFoundError } from "@/lib/authz";
import { localDateOf } from "@/lib/calendar";
import type { Money } from "@/lib/money";
import { selectCategories } from "@/modules/categories/categories.repo";
import { lockHouseholdDocuments, type QueuedDocument } from "@/modules/documents/documents.repo";
import { inHousehold } from "@/modules/ledger/context";
import {
  type CategorizeRequest,
  type CategoryOption,
  applyKindRules,
  categorizeJsonSchema,
  categorizeLines,
  categorizeResponseSchema,
} from "@/modules/receipts/categorize";
import {
  type ReceiptIssue,
  checkReceipt,
  confidenceScore,
  dedupSource,
} from "@/modules/receipts/checks";
import {
  ExtractionInvalidError,
  type ExtractedReceipt,
  RECEIPT_JSON_SCHEMA,
  parseModelReceipt,
  toExtractedReceipt,
} from "@/modules/receipts/extraction.schema";
import { type MergeResult, mergeReceiptParts } from "@/modules/receipts/merge";
import {
  CATEGORIZE_MAX_TOKENS,
  RECEIPT_MAX_TOKENS,
  categorizeMessages,
  pdfTextForPrompt,
  receiptTextMessages,
  receiptVisionMessages,
} from "@/modules/receipts/prompts";
import type { VatRateRow } from "@/modules/receipts/vat";
import { hasActiveConsent, lockUserUsage } from "@/modules/usage/consents";

import { reserveAiBudget } from "./ai-budget";
import { type DocumentJobDeps, PROCESSING_STALE_SECONDS, prepareDocument } from "./documents-job";
import type { Preprocessed } from "./preprocess";

/**
 * Pipeline-ul unui bon în worker (Faza 6, F6-B; master prompt 3.6, 5.5; ADR 0014). Ordinea:
 *
 * 1. **Consimțământul** `external_ai` al celui care a încărcat (sub `lockUserUsage`, în aceeași
 *    tranzacție cu trecerea în `awaiting_consent`): fără el, NIMIC nu pleacă (nici preprocesarea
 *    nu rulează); dacă workerul lucrează în numele altui membru (cel care a încărcat a plecat din
 *    gospodărie), se tratează ca fără consimțământ.
 * 2. **Revendicarea + preprocesarea** (F6-A, `prepareDocument`), fiecare poză a unui bon lung.
 * 3. **Extragerea**: PDF cu text → modelul text; poze/PDF scanat → modelul vision; prompt fix;
 *    înaintea FIECĂREI încercări se rezervă din bugetul global plafonul estimat al încercării
 *    (fail-closed: buget 0 sau epuizat → nimic nu pleacă). Răspunsul: plafoane, JSON, Zod strict,
 *    sume bigint (`extraction.schema.ts`). Fiecare apel → un rând `ai_calls` FĂRĂ conținut.
 * 4. **Bonul lung**: unirea în cod (`merge.ts`).
 * 5. **Regulile fixe** pe tipul liniilor, **verificările** și **scorul** în cod (`checks.ts`).
 * 6. **Categorisirea** (alias → reguli → LLM cu listă închisă).
 * 7. **Salvarea** într-o singură tranzacție: bonul (`needs_review` MEREU: nicio tranzacție nu se
 *    creează automat în Faza 6), liniile, cheia de deduplicare (același bon din nou → legătură
 *    cu originalul, fără cheie), documentele și lotul → `needs_review`. Rularea a doua oară nu mai
 *    revendică documentul (nu mai e `queued`), iar bonul e unic pe document/lot: un singur rezultat.
 *
 * Apelurile AI se fac în afara oricărei tranzacții SQL. Logurile: doar coduri și contoare.
 */

export type AiRuntime = Readonly<{
  client: AiClient;
  visionModel: string;
  textModel: string;
  pricing: Pricing;
  monthlyBudget: Money;
  confidenceThreshold: number;
}>;

export type ReceiptJobDeps = DocumentJobDeps &
  Readonly<{
    /** `null` = AI neconfigurat (bonul ajunge „De verificat” pentru introducere manuală). */
    ai: AiRuntime | null;
    now?: () => Date;
  }>;

export type ReceiptOutcome =
  | Readonly<{ outcome: "skipped" | "awaiting_consent" }>
  | Readonly<{ outcome: "rejected"; code: string }>
  | Readonly<{
      outcome: "needs_review";
      receiptId: string;
      confidence: number;
      issues: number;
      duplicate: boolean;
    }>;

const actorOf = (ref: QueuedDocument): Actor => ({ userId: ref.actorUserId });

type ExtractFailure = "budget_exceeded" | "extraction_failed";
type PartResult =
  | Readonly<{ ok: true; receipt: ExtractedReceipt }>
  | Readonly<{ ok: false; reason: ExtractFailure }>;

/** Pasul 1: consimțământul (și trecerea în `awaiting_consent`, atomic). */
async function consentGate(
  deps: ReceiptJobDeps,
  ref: QueuedDocument,
): Promise<"ok" | "no_consent" | "skip"> {
  return inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    const [doc] = await tx
      .select({
        uploadedBy: documents.uploadedByUserId,
        batchId: documents.batchId,
        status: documents.status,
      })
      .from(documents)
      .where(and(eq(documents.householdId, ref.householdId), eq(documents.id, ref.documentId)))
      .limit(1);
    if (!doc || (doc.status !== "queued" && doc.status !== "processing")) return "skip";
    let consent = false;
    if (doc.uploadedBy !== null && doc.uploadedBy === ref.actorUserId) {
      await lockUserUsage(tx, doc.uploadedBy);
      consent = await hasActiveConsent(tx, doc.uploadedBy, "external_ai");
    }
    if (consent) return "ok";
    const staleBefore = new Date(Date.now() - PROCESSING_STALE_SECONDS * 1000).toISOString();
    const target =
      doc.batchId === null ? eq(documents.id, ref.documentId) : eq(documents.batchId, doc.batchId);
    await tx
      .update(documents)
      .set({ status: "awaiting_consent", processingStartedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(documents.householdId, ref.householdId),
          target,
          sql`(${documents.status} = 'queued' or (${documents.status} = 'processing' and (${documents.processingStartedAt} is null or ${documents.processingStartedAt} < ${staleBefore}::timestamptz)))`,
        ),
      );
    return "no_consent";
  });
}

/** Un rând `ai_calls`: DOAR metadate (fără imagini, text sau răspuns). */
async function recordAiCall(
  deps: ReceiptJobDeps,
  ref: QueuedDocument,
  row: Readonly<{
    documentId: string | null;
    task: "receipt_extract" | "categorize";
    model: string;
    units: number | null;
    costMinor: bigint;
    currency: Money["currency"];
    durationMs: number;
    result: "ok" | "failed_validation" | "timeout" | "error";
  }>,
): Promise<void> {
  await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
    tx.insert(aiCalls).values({
      householdId: ref.householdId,
      documentId: row.documentId,
      task: row.task,
      modelAlias: row.model,
      provider: providerOf(row.model),
      units: row.units,
      unitsKind: row.units === null ? null : "tokens",
      costEstimateMinor: row.costMinor,
      costCurrency: row.currency,
      durationMs: Math.min(3_600_000, Math.max(0, Math.round(row.durationMs))),
      result: row.result,
    }),
  );
}

/**
 * Un apel AI cu bugetul rezervat înaintea fiecărei încercări și jurnalul `ai_calls`. Întoarce
 * conținutul (text neîncrezător) sau codul eșecului.
 */
async function callAi<T>(
  deps: ReceiptJobDeps,
  ai: AiRuntime,
  ref: QueuedDocument,
  call: Readonly<{
    task: "receipt_extract" | "categorize";
    documentId: string | null;
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
    schema: Readonly<{ name: string; schema: Readonly<Record<string, unknown>> }>;
    textChars: number;
    images: number;
    /** Parsarea + validarea conținutului (aruncă la date invalide); rezultatul în `ai_calls`. */
    validate: (content: string) => T;
  }>,
): Promise<Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: AiError["code"] }>> {
  const maxCost = maxCostOf(ai.pricing, call.textChars, call.images, call.maxTokens);
  let attempts = 0;
  const started = Date.now();
  try {
    const result = await ai.client.chat(
      {
        model: call.model,
        messages: call.messages,
        maxTokens: call.maxTokens,
        jsonSchema: call.schema,
      },
      {
        beforeAttempt: async () => {
          if (!(await reserveAiBudget(deps.db, maxCost, ai.monthlyBudget))) {
            throw new AiError("budget_exceeded");
          }
          attempts++;
        },
      },
    );
    // Costul real (din tokeni) al încercării reușite + plafonul celor eșuate (pesimist).
    const cost = actualCostOf(ai.pricing, result.usage, maxCost) + maxCost * BigInt(attempts - 1);
    let value: T;
    let valid = true;
    try {
      value = call.validate(result.content);
    } catch (error) {
      if (!(error instanceof AiError || error instanceof ExtractionInvalidError)) throw error;
      valid = false;
      value = undefined as T;
    }
    await recordAiCall(deps, ref, {
      documentId: call.documentId,
      task: call.task,
      model: call.model,
      units: result.usage ? result.usage.promptTokens + result.usage.completionTokens : null,
      costMinor: cost,
      currency: ai.monthlyBudget.currency,
      durationMs: result.durationMs,
      result: valid ? "ok" : "failed_validation",
    });
    return valid ? { ok: true, value } : { ok: false, code: "failed_validation" };
  } catch (error) {
    const code: AiError["code"] = error instanceof AiError ? error.code : "provider_error";
    // Fără nicio încercare pornită (bugetul a refuzat prima), nimic nu a plecat: fără rând.
    if (attempts > 0) {
      await recordAiCall(deps, ref, {
        documentId: call.documentId,
        task: call.task,
        model: call.model,
        units: null,
        costMinor: maxCost * BigInt(attempts),
        currency: ai.monthlyBudget.currency,
        durationMs: Date.now() - started,
        result: aiCallResultOf(code),
      });
    }
    if (!(error instanceof AiError)) throw error;
    return { ok: false, code };
  }
}

/** Pasul 3: extragerea unei poze sau a unui PDF. */
async function extractPart(
  deps: ReceiptJobDeps,
  ai: AiRuntime,
  ref: QueuedDocument,
  documentId: string,
  pre: Preprocessed,
): Promise<PartResult> {
  const text = pre.kind === "text" ? pdfTextForPrompt(pre.text) : "";
  const call =
    pre.kind === "text"
      ? { model: ai.textModel, messages: receiptTextMessages(text), images: 0 }
      : {
          model: ai.visionModel,
          messages: receiptVisionMessages(pre.images.map((i) => i.jpeg)),
          images: pre.images.length,
        };
  const r = await callAi(deps, ai, ref, {
    task: "receipt_extract",
    documentId,
    model: call.model,
    messages: call.messages,
    maxTokens: RECEIPT_MAX_TOKENS,
    schema: { name: "receipt", schema: RECEIPT_JSON_SCHEMA },
    textChars: text.length + 2000,
    images: call.images,
    validate: (content) => toExtractedReceipt(parseModelReceipt(parseModelJson(content))),
  });
  if (!r.ok) {
    deps.log?.({ job: "receipt.process", step: "extract", error: r.code });
    return {
      ok: false,
      reason: r.code === "budget_exceeded" ? "budget_exceeded" : "extraction_failed",
    };
  }
  return { ok: true, receipt: r.value };
}

function vatRateText(bp: number | null): string | null {
  if (bp === null) return null;
  return `${Math.trunc(bp / 100)}.${String(bp % 100).padStart(2, "0")}`;
}

function ocrTextOf(
  receipt: ExtractedReceipt | null,
  parts: readonly Preprocessed[],
): string | null {
  const pdf = parts.flatMap((p) => (p.kind === "text" ? p.text : []));
  const text =
    pdf.length > 0
      ? pdf.join("\n")
      : receipt
        ? [receipt.merchantName, receipt.storeAddress, ...receipt.lines.map((l) => l.rawName)]
            .filter((x): x is string => x !== null)
            .join("\n")
        : "";
  if (text.trim() === "") return null;
  return text.length > 20_000 ? text.slice(0, 20_000) : text;
}

type Prepared = Readonly<{ documentId: string; pre: Preprocessed; possibleDuplicate: boolean }>;

/** Pasul 2 pentru un lot: revendică și preprocesează pozele în ordine (sau nimic). */
async function prepareBatch(
  deps: ReceiptJobDeps,
  ref: QueuedDocument,
  batchId: string,
): Promise<
  Readonly<{ ok: true; parts: Prepared[] }> | Readonly<{ ok: false; outcome: ReceiptOutcome }>
> {
  const docs = await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
    tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.householdId, ref.householdId), eq(documents.batchId, batchId)))
      .orderBy(asc(documents.documentOrder)),
  );
  const parts: Prepared[] = [];
  const claimed: string[] = [];
  const release = async (status: "queued" | "failed", code: string | null) => {
    if (claimed.length === 0) return;
    await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
      tx
        .update(documents)
        .set({ status, errorCode: code, processingStartedAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(documents.householdId, ref.householdId),
            inArray(documents.id, claimed),
            eq(documents.status, "processing"),
          ),
        ),
    );
  };
  for (const d of docs) {
    const r = await prepareDocument(deps, { ...ref, documentId: d.id });
    if (r.outcome === "skipped") {
      await release("queued", null);
      return { ok: false, outcome: { outcome: "skipped" } };
    }
    if (r.outcome === "rejected") {
      await release("failed", "batch_part_rejected");
      await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
        tx
          .update(processingBatches)
          .set({ status: "failed", updatedAt: new Date() })
          .where(
            and(
              eq(processingBatches.householdId, ref.householdId),
              eq(processingBatches.id, batchId),
            ),
          ),
      );
      return { ok: false, outcome: { outcome: "rejected", code: r.code } };
    }
    claimed.push(d.id);
    parts.push({
      documentId: d.id,
      pre: r.preprocessed,
      possibleDuplicate: r.possibleDuplicateOfId !== null,
    });
  }
  return { ok: true, parts };
}

type Draft = Readonly<{
  receipt: ExtractedReceipt | null;
  issues: ReceiptIssue[];
  providerUsed: "none" | "local" | "external";
  fallbackReason:
    "no_local_model" | "budget_exceeded" | "external_failed" | "ai_unconfigured" | null;
  mergeReport: Record<string, unknown> | null;
}>;

/** Procesează documentul (sau lotul lui) până la `needs_review`. Vezi antetul modulului. */
export async function processReceiptDocument(
  deps: ReceiptJobDeps,
  ref: QueuedDocument,
): Promise<ReceiptOutcome> {
  let gate: "ok" | "no_consent" | "skip";
  try {
    gate = await consentGate(deps, ref);
  } catch (error) {
    if (error instanceof NotFoundError) return { outcome: "skipped" };
    throw error;
  }
  if (gate === "skip") return { outcome: "skipped" };
  if (gate === "no_consent") {
    deps.log?.({ job: "receipt.process", outcome: "awaiting_consent" });
    return { outcome: "awaiting_consent" };
  }

  const [docRow] = await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
    tx
      .select({ batchId: documents.batchId })
      .from(documents)
      .where(and(eq(documents.householdId, ref.householdId), eq(documents.id, ref.documentId)))
      .limit(1),
  );
  const batchId = docRow?.batchId ?? null;

  let parts: Prepared[];
  if (batchId === null) {
    const r = await prepareDocument(deps, ref);
    if (r.outcome === "skipped") return { outcome: "skipped" };
    if (r.outcome === "rejected") return { outcome: "rejected", code: r.code };
    parts = [
      {
        documentId: ref.documentId,
        pre: r.preprocessed,
        possibleDuplicate: r.possibleDuplicateOfId !== null,
      },
    ];
  } else {
    const r = await prepareBatch(deps, ref, batchId);
    if (!r.ok) return r.outcome;
    parts = r.parts;
  }

  const draft = await extractAll(deps, ref, parts, batchId !== null);
  return persist(deps, ref, parts, batchId, draft);
}

async function extractAll(
  deps: ReceiptJobDeps,
  ref: QueuedDocument,
  parts: readonly Prepared[],
  isBatch: boolean,
): Promise<Draft> {
  const ai = deps.ai;
  if (ai === null) {
    return {
      receipt: null,
      issues: [{ code: "ai_unavailable" }],
      providerUsed: "none",
      fallbackReason: "ai_unconfigured",
      mergeReport: null,
    };
  }
  const extracted: ExtractedReceipt[] = [];
  for (const p of parts) {
    const r = await extractPart(deps, ai, ref, p.documentId, p.pre);
    if (!r.ok) {
      return r.reason === "budget_exceeded" && extracted.length === 0
        ? {
            receipt: null,
            issues: [{ code: "budget_exceeded" }],
            providerUsed: "none",
            fallbackReason: "budget_exceeded",
            mergeReport: null,
          }
        : {
            receipt: null,
            issues: [{ code: r.reason }],
            providerUsed: providerOf(ai.visionModel),
            fallbackReason: r.reason === "budget_exceeded" ? "budget_exceeded" : "external_failed",
            mergeReport: null,
          };
    }
    extracted.push(r.receipt);
  }
  const provider = providerOf(parts[0]!.pre.kind === "text" ? ai.textModel : ai.visionModel);
  // Faza 6 nu are model local: extern pentru că nu există unul local (3.6: motivul se păstrează).
  const fallbackReason = provider === "external" ? "no_local_model" : null;
  const issues: ReceiptIssue[] = [];
  let receipt: ExtractedReceipt;
  let mergeReport: Record<string, unknown> | null = null;
  if (!isBatch) {
    receipt = extracted[0]!;
  } else {
    const merged: MergeResult = mergeReceiptParts(extracted);
    if (!merged.ok) {
      const suggestedOrder = merged.error === "order" ? merged.suggestedOrder : null;
      return {
        receipt: null,
        issues: [{ code: "long_receipt_order" }],
        providerUsed: provider,
        fallbackReason,
        mergeReport: {
          error: merged.error,
          suggestedOrder: suggestedOrder?.map((i) => i + 1) ?? null,
        },
      };
    }
    receipt = merged.receipt;
    if (merged.mismatch) issues.push({ code: "long_receipt_mismatch" });
    mergeReport = {
      removed: merged.removed.map((r) => ({
        part: r.part + 1,
        position: r.position,
        reason: r.reason,
      })),
      difference: merged.difference === null ? null : merged.difference.toString(),
    };
  }
  receipt = { ...receipt, lines: applyKindRules(receipt.lines) };
  return { receipt, issues, providerUsed: provider, fallbackReason, mergeReport };
}

async function loadVatRates(tx: Tx): Promise<VatRateRow[]> {
  const rows = await tx
    .select({ rateBp: vatRates.rateBp, validFrom: vatRates.validFrom, validTo: vatRates.validTo })
    .from(vatRates)
    .where(eq(vatRates.country, "RO"));
  return rows;
}

async function persist(
  deps: ReceiptJobDeps,
  ref: QueuedDocument,
  parts: readonly Prepared[],
  batchId: string | null,
  draft: Draft,
): Promise<ReceiptOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const today = localDateOf(now);
  const ai = deps.ai;

  // Categoriile (închise) și alias-urile, apoi pasul LLM — în afara tranzacției de salvare.
  const context = await inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    const cats = await selectCategories(tx, ref.householdId);
    const options: CategoryOption[] = cats
      .filter((c) => c.kind === "expense" && !(c.visibilityHidden ?? c.hidden))
      .map((c) => ({ id: c.id, name: c.name }));
    const names = (draft.receipt?.lines ?? [])
      .map((l) => l.normalizedName)
      .filter((n): n is string => n !== null);
    const aliasRows =
      names.length === 0
        ? []
        : await tx
            .select({ name: productAliases.normalizedName, categoryId: productAliases.categoryId })
            .from(productAliases)
            .where(
              and(
                eq(productAliases.householdId, ref.householdId),
                inArray(productAliases.normalizedName, [...new Set(names)]),
              ),
            );
    return {
      options,
      aliases: new Map(aliasRows.map((a) => [a.name, a.categoryId] as const)),
      vat: await loadVatRates(tx),
    };
  });

  const issues: ReceiptIssue[] = [...draft.issues];
  let confidence = 0;
  let categories: { categoryId: string | null }[] = [];
  if (draft.receipt !== null) {
    issues.push(...checkReceipt(draft.receipt, { today, vatRates: context.vat }));
    confidence = confidenceScore(issues);
    if (ai !== null && confidence < ai.confidenceThreshold) issues.push({ code: "low_confidence" });
    categories = await categorizeLines({
      lines: draft.receipt.lines,
      aliases: context.aliases,
      categories: context.options,
      llm:
        ai === null
          ? null
          : async (request: CategorizeRequest) => {
              const codes = request.categories.map((c) => c.code);
              const r = await callAi(deps, ai, ref, {
                task: "categorize",
                documentId: parts[0]!.documentId,
                model: ai.textModel,
                messages: categorizeMessages(request),
                maxTokens: CATEGORIZE_MAX_TOKENS,
                schema: { name: "categories", schema: categorizeJsonSchema(codes) },
                textChars: JSON.stringify(request).length,
                images: 0,
                validate: (content) => {
                  const v = categorizeResponseSchema.safeParse(parseModelJson(content));
                  if (!v.success) throw new AiError("failed_validation", "schema");
                  return v.data;
                },
              });
              if (!r.ok) throw new AiError(r.code);
              return r.value;
            },
    });
  }
  if (parts.some((p) => p.possibleDuplicate)) issues.push({ code: "possible_duplicate_image" });

  const receipt = draft.receipt;
  const source = receipt === null ? null : dedupSource(receipt);
  const dedupKey = source === null ? null : createHash("sha256").update(source).digest("hex");
  const docIds = parts.map((p) => p.documentId);

  return inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    // Serializat cu încărcările și cu alte workere pe aceeași gospodărie (cheia de deduplicare).
    await lockHouseholdDocuments(tx, ref.householdId);
    let duplicateOf: string | null = null;
    if (dedupKey !== null) {
      const [orig] = await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(and(eq(receipts.householdId, ref.householdId), eq(receipts.dedupKey, dedupKey)))
        .limit(1);
      duplicateOf = orig?.id ?? null;
    }
    const finalIssues =
      duplicateOf === null ? issues : [...issues, { code: "duplicate_receipt" as const }];
    const [row] = await tx
      .insert(receipts)
      .values({
        householdId: ref.householdId,
        documentId: batchId === null ? docIds[0]! : null,
        batchId,
        merchantName: receipt?.merchantName ?? null,
        merchantTaxId: receipt?.merchantTaxId ?? null,
        storeAddress: receipt?.storeAddress ?? null,
        receiptNumber: receipt?.receiptNumber ?? null,
        occurredOn: receipt?.occurredOn ?? null,
        paymentMethod: receipt?.paymentMethod ?? null,
        totalMinor: receipt?.totalMinor ?? null,
        currency: receipt?.currency ?? "RON",
        vatTotalMinor: receipt?.vatTotalMinor ?? null,
        status: "needs_review",
        confidence: receipt === null ? 0 : confidence,
        providerUsed: draft.providerUsed,
        fallbackReason: draft.fallbackReason,
        dedupKey: duplicateOf === null ? dedupKey : null,
        duplicateOfReceiptId: duplicateOf,
        ocrText: ocrTextOf(
          receipt,
          parts.map((p) => p.pre),
        ),
        issues: finalIssues.slice(0, 100),
        mergeReport: draft.mergeReport,
      })
      .onConflictDoNothing()
      .returning({ id: receipts.id });
    if (!row) {
      // Bonul acestui document/lot există deja (rulare repetată): un singur rezultat.
      const [existing] = await tx
        .select({ id: receipts.id, confidence: receipts.confidence })
        .from(receipts)
        .where(
          and(
            eq(receipts.householdId, ref.householdId),
            batchId === null ? eq(receipts.documentId, docIds[0]!) : eq(receipts.batchId, batchId),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("receipt insert conflict");
      await markDocuments(tx, ref.householdId, docIds, batchId);
      return {
        outcome: "needs_review",
        receiptId: existing.id,
        confidence: existing.confidence ?? 0,
        issues: 0,
        duplicate: false,
      };
    }
    if (receipt !== null && receipt.lines.length > 0) {
      await tx.insert(receiptLines).values(
        receipt.lines.map((l, i) => ({
          receiptId: row.id,
          householdId: ref.householdId,
          position: i + 1,
          rawName: l.rawName,
          normalizedName: l.normalizedName,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          lineTotalMinor: l.lineTotalMinor,
          vatRate: vatRateText(l.vatRateBp),
          categoryId: categories[i]?.categoryId ?? null,
          kind: l.kind,
        })),
      );
    }
    await markDocuments(tx, ref.householdId, docIds, batchId);
    deps.log?.({
      job: "receipt.process",
      outcome: "needs_review",
      parts: parts.length,
      lines: receipt?.lines.length ?? 0,
      issues: finalIssues.length,
      confidence: receipt === null ? 0 : confidence,
      duplicate: duplicateOf !== null,
    });
    return {
      outcome: "needs_review",
      receiptId: row.id,
      confidence: receipt === null ? 0 : confidence,
      issues: finalIssues.length,
      duplicate: duplicateOf !== null,
    };
  });
}

async function markDocuments(
  tx: Tx,
  householdId: string,
  ids: readonly string[],
  batchId: string | null,
) {
  const now = new Date();
  await tx
    .update(documents)
    .set({ status: "needs_review", processingStartedAt: null, errorCode: null, updatedAt: now })
    .where(
      and(
        eq(documents.householdId, householdId),
        inArray(documents.id, [...ids]),
        or(eq(documents.status, "processing"), eq(documents.status, "queued")),
      ),
    );
  if (batchId !== null) {
    await tx
      .update(processingBatches)
      .set({ status: "needs_review", updatedAt: now })
      .where(
        and(eq(processingBatches.householdId, householdId), eq(processingBatches.id, batchId)),
      );
  }
}
