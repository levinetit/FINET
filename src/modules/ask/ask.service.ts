import "server-only";

import { DEFAULT_TIME_ZONE, addMonths, localDateOf, monthBounds } from "@/lib/calendar";
import type { Actor } from "@/lib/authz";
import { type Currency, formatMoney, money, toJson } from "@/lib/money";
import { selectHouseholdTimeZone } from "@/modules/budgets/budgets.repo";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { selectCategories } from "@/modules/categories/categories.repo";
import { selectExpenseByCategory, selectTopMerchants } from "@/modules/dashboard/dashboard.repo";
import { inHousehold } from "@/modules/ledger/context";
import { parseInput } from "@/modules/ledger/input";

import { selectAskTotals, selectKnownMerchants } from "./ask.repo";
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
      reason: "empty" | "metric" | "period";
      message: string;
    }>;

const NOT_UNDERSTOOD = {
  empty: "Scrie o întrebare despre cheltuielile sau veniturile tale.",
  metric:
    "Nu am înțeles întrebarea. Pot răspunde la: cât ai cheltuit sau încasat într-o perioadă (opțional pe o categorie sau la un comerciant) și care sunt categoriile sau comercianții cu cele mai mari cheltuieli.",
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

export async function askFinet(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  rawBody: unknown,
): Promise<AskResult> {
  const body = parseInput(askBodySchema, rawBody);
  const now = deps.now ?? (() => new Date());
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const tz = (await selectHouseholdTimeZone(tx, m.householdId)) ?? DEFAULT_TIME_ZONE;
    const today = localDateOf(now(), tz);
    const cats = (await selectCategories(tx, m.householdId)).filter((c) => !c.visibilityHidden);
    const named: AskNamed[] = cats.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }));
    const merchants = await selectKnownMerchants(
      tx,
      m.householdId,
      monthBounds(addMonths(today.slice(0, 7), -36)).from,
    );
    const parsed = parseQuestion(body.question, { today, categories: named, merchants });
    if (!parsed.ok) {
      return { understood: false, reason: parsed.reason, message: NOT_UNDERSTOOD[parsed.reason] };
    }
    // A doua validare: orice interogare, oricum a fost produsă, trece prin schema strictă.
    const query = parseInput(askQuerySchema, parsed.query);
    const categoryName = query.categoryId
      ? (named.find((c) => c.id === query.categoryId)?.name ?? null)
      : null;
    const period = { ...query.period, label: parsed.periodLabel };

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
      query,
      queryText: describe(query, parsed.periodLabel, categoryName),
      period,
      notes: parsed.notes,
      answer,
      text: sentence(query, parsed.periodLabel, answer, categoryName),
    };
  });
}
