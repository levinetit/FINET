import "server-only";

import { ZodError } from "zod";

import { DEFAULT_TIME_ZONE, addMonths, localDateOf, monthBounds } from "@/lib/calendar";
import {
  AiError,
  actualCostOf,
  aiCallResultOf,
  maxCostOf,
  parseModelJson,
  providerOf,
} from "@/lib/ai";
import { aiCalls } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { type Currency, formatMoney, money, toJson } from "@/lib/money";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { selectCategories } from "@/modules/categories/categories.repo";
import { selectExpenseByCategory, selectTopMerchants } from "@/modules/dashboard/dashboard.repo";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";
import { hasActiveConsent, lockUserUsage } from "@/modules/usage/consents";
import { reserveAiBudget } from "@/worker/receipts/ai-budget";

import { selectAskTotals, selectKnownMerchants } from "./ask.repo";
import {
  ASK_LLM_MAX_TOKENS,
  askLlmJsonSchema,
  askLlmMessages,
  buildAskRequest,
  resolveAskLlm,
} from "./ask-llm";
import type { AskAi } from "./ask-runtime";
import { type AskNamed, parseQuestion } from "./parse";
import { type AskQuery, askBodySchema, askQuerySchema } from "./query";

/**
 * „Întreabă FINET” (F10-C; ADR 0025): întrebarea se transformă în cod într-o interogare din setul
 * închis (`query.ts`), se validează cu Zod, iar cifrele se calculează din baza de date sub RLS.
 * Răspunsul arată MEREU interogarea folosită. Dacă întrebarea nu se poate transforma, răspunsul
 * spune că nu a înțeles (nu ghicește). Textul întrebării nu se păstrează: nu intră în baza de date,
 * în audit, în loguri sau în erori; la ieșire e doar interogarea structurată.
 */

export const TOP_LIMIT = 5;

export type AskItem = Readonly<{ name: string | null; amountMinor: number; count: number }>;

export type AskAnswer =
  | Readonly<{
      kind: "total";
      rows: readonly Readonly<{
        currency: Currency;
        totalMinor: number;
        count: number;
      }>[];
    }>
  | Readonly<{
      kind: "ranking";
      rows: readonly Readonly<{ currency: Currency; items: readonly AskItem[] }>[];
    }>;

export type AskResult =
  | Readonly<{
      understood: true;
      /** `rules` = parserul din cod; `ai` = tradusă de un model extern (cu consimțământ, ADR 0026). */
      source: "rules" | "ai";
      query: AskQuery;
      /** Interogarea descrisă pe înțelesul utilizatorului (aceeași ca `query`, în cuvinte). */
      queryText: string;
      period: Readonly<{ from: string; to: string; label: string }>;
      notes: readonly string[];
      answer: AskAnswer;
      text: string;
    }>
  | Readonly<{
      understood: false;
      reason: "empty" | "metric" | "period" | "name";
      message: string;
      /** De ce n-a ajutat pasul cu AI (când e pornit): lipsa consimțământului, bugetul sau o eroare. */
      aiHint: "consent" | "budget" | "error" | null;
    }>;

const NOT_UNDERSTOOD = {
  empty: "Scrie o întrebare despre cheltuielile sau veniturile tale.",
  metric:
    "Nu am înțeles întrebarea. Pot răspunde la: cât ai cheltuit sau încasat într-o perioadă (opțional pe o categorie sau la un comerciant) și care sunt categoriile sau comercianții cu cele mai mari cheltuieli.",
  name: "Nu am găsit categoria sau comerciantul din întrebare printre ale tale. Verifică numele sau întreabă fără filtru.",
  period:
    "Nu am înțeles perioada. Folosește de exemplu „luna trecută”, „în martie”, „anul acesta” sau „ultimele 3 luni”.",
} as const;

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const fmt = (minor: number, currency: Currency) => formatMoney(money(BigInt(minor), currency));

function describe(q: AskQuery, label: string, categoryName: string | null): string {
  const what: Record<AskQuery["metric"], string> = {
    expense_total: "total cheltuieli",
    income_total: "total venituri",
    top_categories: "clasament categorii (cheltuieli)",
    top_merchants: "clasament comercianți (cheltuieli)",
  };
  const parts = [what[q.metric], `${q.period.from} – ${q.period.to} (${label})`];
  if (categoryName) parts.push(`categoria ${categoryName}`);
  if (q.merchant) parts.push(`comerciantul ${q.merchant}`);
  return parts.join(" · ");
}

function sentence(
  q: AskQuery,
  label: string,
  answer: AskAnswer,
  categoryName: string | null,
): string {
  const where = [
    categoryName ? ` la categoria ${categoryName}` : "",
    q.merchant ? ` la ${q.merchant}` : "",
  ].join("");
  if (answer.kind === "total") {
    if (answer.rows.length === 0) {
      return q.metric === "income_total"
        ? `Nu ai niciun venit înregistrat${where} în perioada ${label}.`
        : `Nu ai nicio cheltuială înregistrată${where} în perioada ${label}.`;
    }
    const verb = q.metric === "income_total" ? "Ai încasat" : "Ai cheltuit";
    const parts = answer.rows.map(
      (r) => `${fmt(r.totalMinor, r.currency)} (${plural(r.count, "tranzacție", "tranzacții")})`,
    );
    return `${verb} ${parts.join(" și ")}${where} în perioada ${label}.`;
  }
  if (answer.rows.length === 0) return `Nu ai cheltuieli înregistrate în perioada ${label}.`;
  const heading =
    q.metric === "top_categories"
      ? `Categoriile cu cele mai mari cheltuieli în perioada ${label}`
      : `Comercianții cu cele mai mari cheltuieli în perioada ${label}`;
  const lists = answer.rows.map(
    (r) =>
      `${r.currency}: ` +
      r.items
        .map((i) => `${i.name ?? "Fără categorie"} ${fmt(i.amountMinor, r.currency)}`)
        .join("; "),
  );
  return `${heading}: ${lists.join(" | ")}.`;
}

const AI_HINT_TEXT = {
  consent:
    " Pentru întrebări formulate liber poți activa „Întreabă FINET cu AI” în Profil (se trimite doar textul întrebării și numele categoriilor).",
  budget: " Bugetul lunar pentru AI a fost atins.",
  error: " Serviciul AI nu a răspuns acum.",
} as const;

const ASK_DEADLINE_MS = 25_000;
const MAX_UNITS = 100_000_000;
const MAX_COST_MINOR = 10_000_000_000_000n;

class ConsentRevokedError extends Error {
  constructor() {
    super("consent_missing");
    this.name = "ConsentRevokedError";
  }
}

export type AskOptions = Readonly<{
  /** Furnizorul AI al web-ului (`null`/lipsă = pasul LLM oprit; ADR 0026). */
  ai?: AskAi | null;
}>;

type Prepared = Readonly<{
  today: string;
  named: AskNamed[];
  merchants: string[];
}>;

async function consentActive(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
): Promise<boolean> {
  return inHousehold(deps, actor, householdId, async (tx) => {
    await lockUserUsage(tx, actor.userId);
    return hasActiveConsent(tx, actor.userId, "external_ai_ask");
  });
}

async function recordAiCall(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  ai: AskAi,
  row: Readonly<{
    units: number | null;
    costMinor: bigint;
    durationMs: number;
    result: "ok" | "failed_validation" | "timeout" | "error";
  }>,
): Promise<void> {
  await inHousehold(deps, actor, householdId, (tx) =>
    tx.insert(aiCalls).values({
      householdId,
      documentId: null,
      task: "ask_finet",
      modelAlias: ai.textModel,
      provider: providerOf(ai.textModel),
      units: row.units === null ? null : Math.min(MAX_UNITS, Math.max(0, Math.trunc(row.units))),
      unitsKind: row.units === null ? null : "tokens",
      costEstimateMinor: row.costMinor > MAX_COST_MINOR ? MAX_COST_MINOR : row.costMinor,
      costCurrency: ai.monthlyBudget.currency,
      durationMs: Math.min(3_600_000, Math.max(0, Math.round(row.durationMs))),
      result: row.result,
    }),
  );
}

type Translation =
  | Readonly<{ ok: true; query: AskQuery; periodLabel: string; notes: readonly string[] }>
  | Readonly<{
      ok: false;
      reason: "metric" | "period" | "name";
      aiHint: "consent" | "budget" | "error" | null;
    }>;

/**
 * Pasul cu LLM (ADR 0026): doar când parserul din cod n-a înțeles. Cu consimțământul `external_ai`
 * (verificat înainte de fiecare încercare), în bugetul AI (rezervat înainte de fiecare încercare),
 * în afara oricărei tranzacții. Către model pleacă doar întrebarea, data de azi și numele
 * categoriilor. Ieșirea e validată strict; orice abatere → „nu am înțeles”.
 */
async function translateWithAi(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  ai: AskAi,
  question: string,
  prepared: Prepared,
): Promise<Translation> {
  if (!(await consentActive(deps, actor, householdId))) {
    return { ok: false, reason: "metric", aiHint: "consent" };
  }
  const context = {
    today: prepared.today,
    categories: prepared.named,
    merchants: prepared.merchants,
  };
  const messages = askLlmMessages(buildAskRequest(question, context));
  const maxCost = maxCostOf(ai.pricing, JSON.stringify(messages).length, 0, ASK_LLM_MAX_TOKENS);
  const started = Date.now();
  let attempts = 0;
  try {
    const result = await ai.client.chat(
      {
        model: ai.textModel,
        messages,
        maxTokens: ASK_LLM_MAX_TOKENS,
        jsonSchema: { name: "ask_finet", schema: askLlmJsonSchema() },
        responseFormat: ai.responseFormat,
      },
      {
        deadline: started + ASK_DEADLINE_MS,
        beforeAttempt: async () => {
          if (!(await consentActive(deps, actor, householdId))) throw new ConsentRevokedError();
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
        amountMinor: MAX_COST_MINOR,
        currency: ai.monthlyBudget.currency,
      });
    }
    let resolved: ReturnType<typeof resolveAskLlm> | null = null;
    try {
      resolved = resolveAskLlm(parseModelJson(result.content), context);
    } catch (error) {
      if (!(error instanceof AiError || error instanceof ZodError)) throw error;
    }
    await recordAiCall(deps, actor, householdId, ai, {
      units: result.usage ? result.usage.promptTokens + result.usage.completionTokens : null,
      costMinor: cost,
      durationMs: result.durationMs,
      result: resolved ? "ok" : "failed_validation",
    });
    if (!resolved) return { ok: false, reason: "metric", aiHint: "error" };
    if (!resolved.ok) return { ok: false, reason: resolved.reason, aiHint: null };
    return {
      ok: true,
      query: resolved.query,
      periodLabel: resolved.periodLabel,
      notes: [
        "Întrebarea a fost interpretată de un model AI extern; verifică interogarea de mai jos.",
        ...resolved.notes,
      ],
    };
  } catch (error) {
    const hint =
      error instanceof ConsentRevokedError
        ? "consent"
        : error instanceof AiError
          ? error.code === "budget_exceeded"
            ? "budget"
            : "error"
          : null;
    if (hint === null) throw error;
    if (attempts > 0) {
      await recordAiCall(deps, actor, householdId, ai, {
        units: null,
        costMinor: maxCost * BigInt(attempts),
        durationMs: Date.now() - started,
        result: error instanceof AiError ? aiCallResultOf(error.code) : "error",
      });
    }
    return { ok: false, reason: "metric", aiHint: hint };
  }
}

export async function askFinet(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawBody: unknown,
  options: AskOptions = {},
): Promise<AskResult> {
  const body = parseInput(askBodySchema, rawBody);
  const now = deps.now ?? (() => new Date());

  // Pasul 1 (tranzacție): contextul și parserul din cod.
  const first = await inHousehold(deps, actor, householdId, async (tx, m) => {
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const today = localDateOf(now(), tz);
    const cats = (await selectCategories(tx, m.householdId)).filter((c) => !c.visibilityHidden);
    const named: AskNamed[] = cats.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }));
    const merchants = await selectKnownMerchants(
      tx,
      m.householdId,
      monthBounds(addMonths(today.slice(0, 7), -36)).from,
    );
    const prepared: Prepared = { today, named, merchants };
    return {
      prepared,
      parsed: parseQuestion(body.question, { today, categories: named, merchants }),
    };
  });

  let query: AskQuery;
  let periodLabel: string;
  let notes: readonly string[];
  let source: "rules" | "ai" = "rules";
  if (first.parsed.ok) {
    query = parseInput(askQuerySchema, first.parsed.query);
    periodLabel = first.parsed.periodLabel;
    notes = first.parsed.notes;
  } else {
    const failure = first.parsed.reason;
    // Pasul 2 (fără tranzacție): modelul, doar dacă e pornit și întrebarea nu e goală.
    if (options.ai && failure !== "empty") {
      const tr = await translateWithAi(
        deps,
        actor,
        householdId,
        options.ai,
        body.question,
        first.prepared,
      );
      if (!tr.ok) {
        return {
          understood: false,
          reason: tr.reason,
          message: NOT_UNDERSTOOD[tr.reason] + (tr.aiHint ? AI_HINT_TEXT[tr.aiHint] : ""),
          aiHint: tr.aiHint,
        };
      }
      query = parseInput(askQuerySchema, tr.query);
      periodLabel = tr.periodLabel;
      notes = tr.notes;
      source = "ai";
    } else {
      return {
        understood: false,
        reason: failure,
        message: NOT_UNDERSTOOD[failure],
        aiHint: null,
      };
    }
  }

  // Pasul 3 (tranzacție): cifrele din baza de date, sub RLS.
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const named = first.prepared.named;
    const categoryName = query.categoryId
      ? (named.find((c) => c.id === query.categoryId)?.name ?? null)
      : null;
    const period = { ...query.period, label: periodLabel };

    let answer: AskAnswer;
    if (query.metric === "expense_total" || query.metric === "income_total") {
      const ids = query.categoryId
        ? [
            query.categoryId,
            ...named.filter((c) => c.parentId === query.categoryId).map((c) => c.id),
          ]
        : null;
      const rows = await selectAskTotals(
        tx,
        m.householdId,
        query.metric === "income_total" ? "income" : "expense",
        query.period.from,
        query.period.to,
        ids,
        query.merchant ? query.merchant.trim().toLowerCase() : null,
      );
      answer = {
        kind: "total",
        rows: rows
          .filter((r) => r.count > 0)
          .sort((a, b) => a.currency.localeCompare(b.currency))
          .map((r) => ({
            currency: r.currency,
            totalMinor: toJson(money(BigInt(r.total), r.currency)).amountMinor,
            count: r.count,
          })),
      };
    } else if (query.metric === "top_categories") {
      const raw = await selectExpenseByCategory(
        tx,
        m.householdId,
        query.period.from,
        query.period.to,
      );
      const byCurrency = new Map<Currency, Map<string | null, { total: bigint; count: number }>>();
      for (const r of raw) {
        const per = byCurrency.get(r.currency) ?? new Map();
        const cur = per.get(r.rootCategoryId) ?? { total: 0n, count: 0 };
        per.set(r.rootCategoryId, {
          total: cur.total + BigInt(r.total),
          count: cur.count + r.count,
        });
        byCurrency.set(r.currency, per);
      }
      const names = new Map(named.map((c) => [c.id, c.name]));
      answer = {
        kind: "ranking",
        rows: [...byCurrency.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, per]) => ({
            currency,
            items: [...per.entries()]
              .sort(([ka, a], [kb, b]) =>
                a.total === b.total
                  ? (ka ?? "").localeCompare(kb ?? "")
                  : a.total > b.total
                    ? -1
                    : 1,
              )
              .slice(0, TOP_LIMIT)
              .map(([id, v]) => ({
                name: id ? (names.get(id) ?? null) : null,
                amountMinor: toJson(money(v.total, currency)).amountMinor,
                count: v.count,
              })),
          })),
      };
    } else {
      const raw = await selectTopMerchants(
        tx,
        m.householdId,
        query.period.from,
        query.period.to,
        TOP_LIMIT,
      );
      const byCurrency = new Map<Currency, AskItem[]>();
      for (const r of raw) {
        const list = byCurrency.get(r.currency) ?? [];
        list.push({
          name: r.merchant,
          amountMinor: toJson(money(BigInt(r.total), r.currency)).amountMinor,
          count: r.count,
        });
        byCurrency.set(r.currency, list);
      }
      answer = {
        kind: "ranking",
        rows: [...byCurrency.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, items]) => ({ currency, items })),
      };
    }
    return {
      understood: true,
      source,
      query,
      queryText: describe(query, periodLabel, categoryName),
      period,
      notes,
      answer,
      text: sentence(query, periodLabel, answer, categoryName),
    };
  });
}
