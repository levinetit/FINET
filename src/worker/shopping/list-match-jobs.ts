import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { ZodError, z } from "zod";

import type { DbOrTx } from "@/db";
import { SHOPPING_AI_MAX_ATTEMPTS, aiCalls, shoppingListAiRequests } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import {
  AiError,
  actualCostOf,
  aiCallResultOf,
  maxCostOf,
  parseModelJson,
  providerOf,
} from "@/lib/ai";
import type { Money } from "@/lib/money";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { normalizeProductName } from "@/modules/receipts/normalize";
import {
  LIST_MATCH_MAX_TOKENS,
  type ListMatchPlan,
  type ResolvedAnswer,
  buildListMatchRequest,
  listMatchJsonSchema,
  listMatchMessages,
  resolveAnswers,
} from "@/modules/shopping/ai-match";
import { effective, loadHistory, planComparison } from "@/modules/shopping/compare.service";
import { scorePair } from "@/modules/shopping/match";
import {
  selectItems,
  selectList,
  selectReceiptHeader,
  selectReceiptLines,
  updateItemRow,
} from "@/modules/shopping/shopping.repo";
import { hasActiveConsent, lockUserUsage } from "@/modules/usage/consents";

import { reserveAiBudget } from "../receipts/ai-budget";
import type { AiRuntime } from "../receipts/receipt-job";

/**
 * Pasul OPȚIONAL cu LLM al comparației listă ↔ bon în worker (Faza 10, F10-A; master prompt 3.6;
 * ADR 0022), legat de pg-boss în `src/worker/main.ts`, pe modelul bonurilor (ADR 0014):
 *
 * - `list-match.sweep` (cron la fiecare minut): cererile în așteptare (funcția SECURITY DEFINER
 *   `queued_list_matches`, doar identificatori) → câte un `list-match.process` pe cerere;
 * - `list-match.process`: datele jobului (`requestId`, `householdId`) se validează strict și se
 *   RE-CITESC prin `queued_list_match` (gospodăria trebuie să coincidă; membrul în numele căruia
 *   se lucrează e cel care a cerut comparația, încă membru activ). Nimic din conținut (nume de
 *   produse) nu ajunge în `pgboss.job` sau în jurnal.
 *
 * Reguli: dezactivat (`AI_LIST_MATCH=0`, implicit) sau AI neconfigurat → cererea se marchează
 * `skipped`, fără niciun apel. Consimțământul `external_ai` al celui care a cerut se verifică la
 * revendicare ȘI înaintea fiecărei încercări; bugetul AI lunar se rezervă înaintea fiecărei
 * încercări (aceleași funcții ca bonurile); fiecare apel lasă un rând `ai_calls` (`list_match`),
 * fără conținut. Perechile ambigue se REFAC din date (cod), iar modelul poate doar alege un
 * candidat al articolului sau „niciunul”; alegerile se aplică doar articolelor încă nedecise de
 * utilizator. Eșecul AI nu strică comparația din cod: cererea devine `failed` cu un cod fix.
 */

export const JOB_LIST_MATCH_SWEEP = "list-match.sweep";
export const JOB_LIST_MATCH_PROCESS = "list-match.process";
export const LIST_MATCH_SWEEP_CRON = "* * * * *";
export const LIST_MATCH_SWEEP_BATCH = 20;
/** Termenul de lucru: după el, o cerere `processing` e reluată (worker oprit brusc). */
export const LIST_MATCH_STALE_SECONDS = 15 * 60;
/** Termenul total al apelurilor AI ale unei cereri. */
export const LIST_MATCH_DEADLINE_MS = 3 * 60_000;

export const listMatchProcessSchema = z.strictObject({
  requestId: z.uuid(),
  householdId: z.uuid(),
});

export type ListMatchRef = Readonly<{
  requestId: string;
  householdId: string;
  actorUserId: string;
}>;

export type ListMatchDeps = LedgerDeps &
  Readonly<{
    /** `AI_LIST_MATCH=1`. */
    enabled: boolean;
    /** `null` = AI neconfigurat. */
    ai: AiRuntime | null;
    log?: (event: Readonly<Record<string, string | number | boolean>>) => void;
    now?: () => Date;
  }>;

export type ListMatchOutcome =
  | Readonly<{ outcome: "skipped" | "no_consent" | "nothing_to_ask" | "done" | "skip" }>
  | Readonly<{ outcome: "failed"; code: string }>;

type Row = Record<string, unknown>;

export async function listQueuedListMatches(db: DbOrTx, limit: number): Promise<ListMatchRef[]> {
  const rows = (await db.execute(
    sql`select request_id, household_id, actor_user_id
          from finet.queued_list_matches(${limit}::int, ${LIST_MATCH_STALE_SECONDS}::int)`,
  )) as unknown as Row[];
  return rows.map(toRef);
}

export async function selectQueuedListMatch(
  db: DbOrTx,
  requestId: string,
): Promise<ListMatchRef | null> {
  const rows = (await db.execute(
    sql`select request_id, household_id, actor_user_id from finet.queued_list_match(${requestId}::uuid)`,
  )) as unknown as Row[];
  return rows[0] ? toRef(rows[0]) : null;
}

const toRef = (r: Row): ListMatchRef => ({
  requestId: String(r.request_id),
  householdId: String(r.household_id),
  actorUserId: String(r.actor_user_id),
});

export type SendFn = (requestId: string, householdId: string) => Promise<unknown>;

export async function handleListMatchSweep(
  deps: Pick<ListMatchDeps, "db" | "log">,
  send: SendFn,
): Promise<number> {
  const queued = await listQueuedListMatches(deps.db, LIST_MATCH_SWEEP_BATCH);
  for (const q of queued) await send(q.requestId, q.householdId);
  deps.log?.({ job: JOB_LIST_MATCH_SWEEP, enqueued: queued.length });
  return queued.length;
}

export async function handleListMatchProcess(
  deps: ListMatchDeps,
  data: unknown,
): Promise<ListMatchOutcome | { rejected: "invalid_data" | "not_found" }> {
  const parsed = listMatchProcessSchema.safeParse(data);
  if (!parsed.success) {
    deps.log?.({ job: JOB_LIST_MATCH_PROCESS, rejected: "invalid_data" });
    return { rejected: "invalid_data" };
  }
  const ref = await selectQueuedListMatch(deps.db, parsed.data.requestId);
  if (!ref || ref.householdId.toLowerCase() !== parsed.data.householdId.toLowerCase()) {
    deps.log?.({ job: JOB_LIST_MATCH_PROCESS, rejected: "not_found" });
    return { rejected: "not_found" };
  }
  return processListMatch(deps, ref);
}

const actorOf = (ref: ListMatchRef): Actor => ({ userId: ref.actorUserId });

type Claimed =
  | Readonly<{ kind: "go"; listId: string; receiptId: string }>
  | Readonly<{ kind: "end"; outcome: ListMatchOutcome }>;

/** Pasul 1: revendicarea (o încercare numărată ÎNAINTE de lucru), dezactivarea și consimțământul. */
async function claim(deps: ListMatchDeps, ref: ListMatchRef): Promise<Claimed> {
  return inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    const staleBefore = new Date(
      (deps.now?.() ?? new Date()).getTime() - LIST_MATCH_STALE_SECONDS * 1000,
    ).toISOString();
    const [row] = await tx
      .select()
      .from(shoppingListAiRequests)
      .where(
        and(
          eq(shoppingListAiRequests.householdId, ref.householdId),
          eq(shoppingListAiRequests.id, ref.requestId),
          sql`${shoppingListAiRequests.attempts} < ${SHOPPING_AI_MAX_ATTEMPTS}`,
          sql`(${shoppingListAiRequests.status} = 'queued' or (${shoppingListAiRequests.status} = 'processing' and (${shoppingListAiRequests.processingStartedAt} is null or ${shoppingListAiRequests.processingStartedAt} < ${staleBefore}::timestamptz)))`,
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!row) return { kind: "end", outcome: { outcome: "skip" } };
    const finish = async (status: "skipped" | "failed", code: string | null) => {
      await tx
        .update(shoppingListAiRequests)
        .set({ status, errorCode: code, processingStartedAt: null, updatedAt: new Date() })
        .where(eq(shoppingListAiRequests.id, row.id));
    };
    if (!deps.enabled || deps.ai === null) {
      await finish("skipped", null);
      return { kind: "end", outcome: { outcome: "skipped" } };
    }
    await lockUserUsage(tx, ref.actorUserId);
    if (!(await hasActiveConsent(tx, ref.actorUserId, "external_ai"))) {
      await finish("skipped", "consent_missing");
      return { kind: "end", outcome: { outcome: "no_consent" } };
    }
    await tx
      .update(shoppingListAiRequests)
      .set({
        status: "processing",
        attempts: row.attempts + 1,
        processingStartedAt: deps.now?.() ?? new Date(),
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(eq(shoppingListAiRequests.id, row.id));
    return { kind: "go", listId: row.listId, receiptId: row.receiptId };
  });
}

async function setFinal(
  deps: ListMatchDeps,
  ref: ListMatchRef,
  status: "done" | "failed" | "skipped",
  code: string | null,
): Promise<void> {
  await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
    tx
      .update(shoppingListAiRequests)
      .set({ status, errorCode: code, processingStartedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(shoppingListAiRequests.householdId, ref.householdId),
          eq(shoppingListAiRequests.id, ref.requestId),
        ),
      ),
  );
}

const MAX_UNITS = 100_000_000;
const MAX_COST_MINOR = 10_000_000_000_000n;
const BUDGET_COUNTER_CAP = { amountMinor: 10_000_000_000_000n } as const;

class ConsentRevokedError extends Error {
  constructor() {
    super("consent_missing");
    this.name = "ConsentRevokedError";
  }
}

async function consentStillActive(deps: ListMatchDeps, ref: ListMatchRef): Promise<boolean> {
  return inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    await lockUserUsage(tx, ref.actorUserId);
    return hasActiveConsent(tx, ref.actorUserId, "external_ai");
  });
}

async function recordAiCall(
  deps: ListMatchDeps,
  ref: ListMatchRef,
  row: Readonly<{
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
      documentId: null,
      task: "list_match",
      modelAlias: row.model,
      provider: providerOf(row.model),
      units: row.units === null ? null : Math.min(MAX_UNITS, Math.max(0, Math.trunc(row.units))),
      unitsKind: row.units === null ? null : "tokens",
      costEstimateMinor: row.costMinor > MAX_COST_MINOR ? MAX_COST_MINOR : row.costMinor,
      costCurrency: row.currency,
      durationMs: Math.min(3_600_000, Math.max(0, Math.round(row.durationMs))),
      result: row.result,
    }),
  );
}

/** Pasul 3: apelul AI, în afara oricărei tranzacții, cu bugetul rezervat înaintea fiecărei încercări. */
async function callModel(
  deps: ListMatchDeps,
  ai: AiRuntime,
  ref: ListMatchRef,
  plan: ListMatchPlan,
): Promise<
  Readonly<{ ok: true; answers: ResolvedAnswer[] }> | Readonly<{ ok: false; code: string }>
> {
  const messages = listMatchMessages(plan.request);
  const maxCost = maxCostOf(ai.pricing, JSON.stringify(messages).length, 0, LIST_MATCH_MAX_TOKENS);
  const started = Date.now();
  const deadline = started + LIST_MATCH_DEADLINE_MS;
  let attempts = 0;
  try {
    const result = await ai.client.chat(
      {
        model: ai.textModel,
        messages,
        maxTokens: LIST_MATCH_MAX_TOKENS,
        jsonSchema: {
          name: "list_match",
          schema: listMatchJsonSchema(plan.request.lines.map((l) => l.c)),
        },
        responseFormat: ai.responseFormat,
      },
      {
        deadline,
        beforeAttempt: async () => {
          if (!(await consentStillActive(deps, ref))) throw new ConsentRevokedError();
          if (!(await reserveAiBudget(deps.db, maxCost, ai.monthlyBudget))) {
            throw new AiError("budget_exceeded");
          }
          attempts++;
        },
      },
    );
    const actual = actualCostOf(ai.pricing, result.usage, maxCost);
    const cost = actual + maxCost * BigInt(attempts - 1);
    if (actual > maxCost) {
      await reserveAiBudget(deps.db, actual - maxCost, {
        ...BUDGET_COUNTER_CAP,
        currency: ai.monthlyBudget.currency,
      });
    }
    let answers: ResolvedAnswer[] | null = null;
    try {
      answers = resolveAnswers(plan, parseModelJson(result.content));
    } catch (error) {
      if (!(error instanceof AiError || error instanceof ZodError)) throw error;
    }
    await recordAiCall(deps, ref, {
      model: ai.textModel,
      units: result.usage ? result.usage.promptTokens + result.usage.completionTokens : null,
      costMinor: cost,
      currency: ai.monthlyBudget.currency,
      durationMs: result.durationMs,
      result: answers ? "ok" : "failed_validation",
    });
    return answers ? { ok: true, answers } : { ok: false, code: "failed_validation" };
  } catch (error) {
    const code =
      error instanceof ConsentRevokedError
        ? "consent_missing"
        : error instanceof AiError
          ? error.code
          : null;
    if (code === null) throw error;
    if (attempts > 0) {
      await recordAiCall(deps, ref, {
        model: ai.textModel,
        units: null,
        costMinor: maxCost * BigInt(attempts),
        currency: ai.monthlyBudget.currency,
        durationMs: Date.now() - started,
        result: error instanceof AiError ? aiCallResultOf(error.code) : "error",
      });
    }
    return { ok: false, code };
  }
}

export async function processListMatch(
  deps: ListMatchDeps,
  ref: ListMatchRef,
): Promise<ListMatchOutcome> {
  const claimed = await claim(deps, ref);
  if (claimed.kind === "end") {
    deps.log?.({ job: JOB_LIST_MATCH_PROCESS, outcome: claimed.outcome.outcome });
    return claimed.outcome;
  }
  const ai = deps.ai!;

  // Pasul 2: perechile ambigue, refăcute din date (sub RLS-ul celui care a cerut).
  const prepared = await inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    const list = await selectList(tx, ref.householdId, claimed.listId);
    const receipt = await selectReceiptHeader(tx, ref.householdId, claimed.receiptId);
    if (!list || !receipt || receipt.status !== "saved") return "missing" as const;
    const lines = await selectReceiptLines(tx, ref.householdId, receipt.id);
    const items = await selectItems(tx, ref.householdId, list.id);
    const { plan } = planComparison(items, lines, await loadHistory(tx, ref.householdId));
    const itemName = new Map(items.map((i) => [i.id, i.normalizedName]));
    const lineName = new Map(
      lines.map((l) => [l.id, l.normalizedName ?? normalizeProductName(l.rawName) ?? ""]),
    );
    return buildListMatchRequest(
      plan.ambiguous,
      (id) => itemName.get(id) ?? "",
      (id) => lineName.get(id) ?? "",
    );
  });
  if (prepared === "missing") {
    await setFinal(deps, ref, "failed", "not_found");
    deps.log?.({ job: JOB_LIST_MATCH_PROCESS, outcome: "failed", code: "not_found" });
    return { outcome: "failed", code: "not_found" };
  }
  if (prepared === null) {
    await setFinal(deps, ref, "done", null);
    return { outcome: "nothing_to_ask" };
  }

  const called = await callModel(deps, ai, ref, prepared);
  if (!called.ok) {
    await setFinal(deps, ref, "failed", called.code);
    deps.log?.({ job: JOB_LIST_MATCH_PROCESS, outcome: "failed", code: called.code });
    return { outcome: "failed", code: called.code };
  }

  // Pasul 4: aplicarea, doar pe articolele încă nedecise de utilizator.
  await inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    const list = await selectList(tx, ref.householdId, claimed.listId, true);
    if (!list) throw new NotFoundError();
    const lines = await selectReceiptLines(tx, ref.householdId, claimed.receiptId);
    const lineNorm = new Map(
      lines.map((l) => [l.id, l.normalizedName ?? normalizeProductName(l.rawName) ?? ""]),
    );
    const items = await selectItems(tx, ref.householdId, list.id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const lineIds = new Set(lines.map((l) => l.id));
    const involved = new Set(called.answers.map((a) => a.itemId));
    const undecided = (id: string) => {
      const row = byId.get(id);
      if (!row) return false;
      const s = effective(row);
      return s === "none" || (s === "suggested" && row.matchSource !== "ai");
    };
    // Linii ținute de articole care NU participă la această aplicare (nu se iau).
    const heldByOthers = new Set(
      items
        .filter(
          (i) =>
            !involved.has(i.id) &&
            i.matchedReceiptLineId !== null &&
            (i.matchStatus === "suggested" || i.matchStatus === "confirmed"),
        )
        .map((i) => i.matchedReceiptLineId!),
    );
    const clear = [];
    const set: { id: string; lineId: string; score: number }[] = [];
    for (const a of called.answers) {
      if (!undecided(a.itemId)) continue;
      const row = byId.get(a.itemId)!;
      if (a.lineId === null) {
        // „Niciuna": dispare doar propunerea ambiguă a codului pentru acest bon.
        const here = row.matchedReceiptLineId !== null && lineIds.has(row.matchedReceiptLineId);
        if (row.matchStatus === "suggested" && row.matchSource === "code" && here) clear.push(row);
        continue;
      }
      if (!lineIds.has(a.lineId) || heldByOthers.has(a.lineId)) continue;
      if (row.matchStatus === "suggested") clear.push(row);
      set.push({
        id: row.id,
        lineId: a.lineId,
        score: scorePair(row.normalizedName, lineNorm.get(a.lineId) ?? ""),
      });
    }
    for (const row of clear) {
      await updateItemRow(tx, ref.householdId, list.id, row.id, {
        matchStatus: "none",
        matchedReceiptLineId: null,
        matchScore: null,
        matchSource: null,
      });
    }
    for (const s of set) {
      await updateItemRow(tx, ref.householdId, list.id, s.id, {
        matchStatus: "suggested",
        matchedReceiptLineId: s.lineId,
        matchScore: s.score,
        matchSource: "ai",
      });
    }
  });
  await setFinal(deps, ref, "done", null);
  deps.log?.({ job: JOB_LIST_MATCH_PROCESS, outcome: "done", answers: called.answers.length });
  return { outcome: "done" };
}
