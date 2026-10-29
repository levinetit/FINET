import "server-only";

import { z } from "zod";

import type { Config } from "@/lib/config";
import { createAiClient } from "@/lib/ai";
import { selectQueuedDocument } from "@/modules/documents/documents.repo";

import { listQueuedDocuments } from "./documents-job";
import {
  type AiRuntime,
  type ReceiptJobDeps,
  type ReceiptOutcome,
  processReceiptDocument,
} from "./receipt-job";

/**
 * Joburile bonurilor (Faza 6, F6-B; ADR 0014), legate de pg-boss în `src/worker/main.ts`:
 * - `receipt.sweep` (cron la fiecare minut): documentele în așteptare (funcția SECURITY DEFINER
 *   `queued_documents`, doar identificatori) → câte un `receipt.process` pe document, cu
 *   `singletonKey` = documentul (coada `exclusive`: cel mult un job în așteptare sau activ per
 *   document). Serverul web nu e legat de pg-boss: o încărcare ajunge la procesare în ≤ 1 minut.
 * - `receipt.process`: datele jobului (`documentId`, `householdId`) sunt validate cu Zod strict,
 *   apoi documentul e RE-CITIT prin `queued_document` (gospodăria trebuie să coincidă; membrul în
 *   numele căruia se lucrează vine din bază). Un job străin sau vechi se termină fără efect.
 */

export const JOB_RECEIPT_SWEEP = "receipt.sweep";
export const JOB_RECEIPT_PROCESS = "receipt.process";
export const RECEIPT_SWEEP_CRON = "* * * * *";
export const RECEIPT_SWEEP_BATCH = 20;

export const receiptProcessSchema = z.strictObject({
  documentId: z.uuid(),
  householdId: z.uuid(),
});

export type SendFn = (documentId: string, householdId: string) => Promise<unknown>;

export async function handleReceiptSweep(
  deps: Pick<ReceiptJobDeps, "db" | "log">,
  send: SendFn,
): Promise<number> {
  const queued = await listQueuedDocuments(deps.db, RECEIPT_SWEEP_BATCH);
  for (const q of queued) await send(q.documentId, q.householdId);
  deps.log?.({ job: JOB_RECEIPT_SWEEP, enqueued: queued.length });
  return queued.length;
}

export async function handleReceiptProcess(
  deps: ReceiptJobDeps,
  data: unknown,
): Promise<ReceiptOutcome | { rejected: "invalid_data" | "not_found" }> {
  const parsed = receiptProcessSchema.safeParse(data);
  if (!parsed.success) {
    deps.log?.({ job: JOB_RECEIPT_PROCESS, rejected: "invalid_data" });
    return { rejected: "invalid_data" };
  }
  const ref = await selectQueuedDocument(deps.db, parsed.data.documentId);
  if (!ref || ref.householdId.toLowerCase() !== parsed.data.householdId.toLowerCase()) {
    deps.log?.({ job: JOB_RECEIPT_PROCESS, rejected: "not_found" });
    return { rejected: "not_found" };
  }
  return processReceiptDocument(deps, ref);
}

/** Furnizorul AI din configurație; `null` dacă lipsește URL-ul sau cheia (AI neconfigurat). */
export function aiRuntimeFromConfig(config: Pick<Config, "ai">): AiRuntime | null {
  const ai = config.ai;
  if (ai.baseUrl === null || ai.apiKey === null) return null;
  return {
    client: createAiClient({
      baseUrl: ai.baseUrl,
      apiKey: ai.apiKey,
      allowedHosts: ai.allowedHosts,
      timeoutMs: ai.timeoutMs,
      maxRetries: ai.maxRetries,
    }),
    visionModel: ai.visionModel,
    textModel: ai.textModel,
    pricing: ai.pricing,
    monthlyBudget: ai.monthlyBudget,
    confidenceThreshold: ai.confidenceThreshold,
    responseFormat: ai.responseFormat,
  };
}
