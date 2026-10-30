import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError } from "@/lib/errors";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { normalizeProductName } from "@/modules/receipts/normalize";
import { hasActiveConsent } from "@/modules/usage/consents";

import {
  EMPTY_HISTORY,
  MATCH_HIGH,
  type MatchItem,
  type MatchLine,
  type PairHistory,
  pairKey,
  planMatches,
} from "./match";
import {
  type ItemRow,
  type ReceiptHeader,
  type ReceiptLineRow,
  selectAiRequest,
  selectItem,
  selectItems,
  selectLinesByIds,
  selectList,
  selectPairHistory,
  selectReceiptHeader,
  selectReceiptLines,
  selectRecentSavedReceipts,
  touchList,
  updateItemRow,
  upsertAiRequest,
} from "./shopping.repo";
import {
  type ItemView,
  canonicalQuantity,
  comparisonRunSchema,
  matchActionSchema,
} from "./shopping.schema";
import { itemView } from "./shopping.service";

/**
 * Comparația listă ↔ bon (Faza 10, F10-A; master prompt 3.6; ADR 0022).
 *
 * După ce un bon e CONFIRMAT (`saved`), articolele unei liste se compară cu liniile lui `product`:
 *  - *potrivite*: articole cu o propunere (`suggested`) sau o confirmare (`confirmed`) pe o linie a
 *    bonului; cele cu scor sub `MATCH_HIGH` sunt marcate „nesigur";
 *  - *neplanificate*: linii `product` ale bonului pe care nu le revendică niciun articol;
 *  - *uitate*: articole nebifate fără linie pe acest bon; *bifate, dar negăsite*: bifate fără linie;
 *  - *cumpărate în altă parte*: articole confirmate deja pe un ALT bon.
 * Potrivirea o face codul (`match.ts`); pasul opțional cu LLM (worker) doar alege între candidați.
 * Utilizatorul confirmă, respinge sau corectează. Nimic din comparație nu modifică un bon sau o
 * tranzacție: singurele scrieri sunt pe `shopping_list_items` (stare de potrivire) și pe coada AI.
 */

/** Câte perechi din istoric se citesc la o rulare (cele mai recente). */
export const HISTORY_LIMIT = 1000;
/** Câte bonuri confirmate se oferă la alegere. */
export const RECENT_RECEIPTS_LIMIT = 20;

export type ComparisonLine = Readonly<{
  id: string;
  name: string;
  quantity: string | null;
}>;

export type ComparisonMatched = Readonly<{
  item: ItemView;
  line: ComparisonLine;
  /** Scorul codului (0–100); `null` la o legare manuală veche fără scor. */
  score: number | null;
  status: "suggested" | "confirmed";
  source: "code" | "learned" | "ai" | "manual";
  /** `true` dacă propunerea e sub pragul „sigur” și nu a fost confirmată. */
  uncertain: boolean;
}>;

export type AiStatus = "none" | "queued" | "processing" | "done" | "failed" | "skipped";

export type ComparisonView = Readonly<{
  receipt: Readonly<{ id: string; merchantName: string | null; occurredOn: string | null }>;
  list: Readonly<{ id: string; name: string; shared: boolean }>;
  matched: readonly ComparisonMatched[];
  unplanned: readonly ComparisonLine[];
  forgotten: readonly ItemView[];
  checkedMissing: readonly ItemView[];
  boughtElsewhere: readonly ItemView[];
  ai: Readonly<{ status: AiStatus }>;
  /** Liniile bonului disponibile pentru corecție manuală (toate liniile `product`). */
  lines: readonly ComparisonLine[];
}>;

export type ComparisonResult = Readonly<{ view: ComparisonView; shared: boolean }>;

const lineName = (l: ReceiptLineRow): string => l.rawName;
const lineQuantity = (l: ReceiptLineRow): string | null =>
  l.quantity === null ? null : canonicalQuantity(l.quantity);
const lineView = (l: ReceiptLineRow): ComparisonLine => ({
  id: l.id,
  name: lineName(l),
  quantity: lineQuantity(l),
});
const lineNormalized = (l: ReceiptLineRow): string =>
  l.normalizedName ?? normalizeProductName(l.rawName) ?? "";

/** Bonul trebuie să existe în gospodărie și să fie confirmat (altfel nu are sens comparația). */
async function requireSavedReceipt(
  tx: Tx,
  householdId: string,
  receiptId: string,
): Promise<ReceiptHeader> {
  const header = await selectReceiptHeader(tx, householdId, receiptId);
  if (!header) throw new NotFoundError();
  if (header.status !== "saved") {
    throw new ConflictError(
      "receipt_not_confirmed",
      "Bonul trebuie confirmat înainte de comparație.",
    );
  }
  return header;
}

export async function loadHistory(tx: Tx, householdId: string): Promise<PairHistory> {
  const rows = await selectPairHistory(tx, householdId, HISTORY_LIMIT);
  const confirmed = new Set<string>();
  const rejected = new Set<string>();
  for (const r of rows) {
    const line = r.lineNormalized ?? normalizeProductName(r.lineRaw) ?? "";
    if (line === "") continue;
    (r.status === "confirmed" ? confirmed : rejected).add(pairKey(r.itemName, line));
  }
  return rows.length === 0 ? EMPTY_HISTORY : { confirmed, rejected };
}

/** Starea de potrivire a unui rând, ignorând legăturile rupte (linia a dispărut împreună cu bonul). */
export function effective(row: ItemRow): ItemRow["matchStatus"] {
  return row.matchedReceiptLineId === null ? "none" : row.matchStatus;
}

async function aiStatusOf(
  tx: Tx,
  householdId: string,
  listId: string,
  receiptId: string,
): Promise<AiStatus> {
  const row = await selectAiRequest(tx, householdId, listId, receiptId);
  return row ? row.status : "none";
}

/** Construiește vederea comparației din starea persistată (fără scrieri). */
async function buildView(
  tx: Tx,
  actor: Actor,
  householdId: string,
  list: Readonly<{ id: string; name: string; ownerUserId: string | null }>,
  receipt: ReceiptHeader,
): Promise<ComparisonView> {
  const lines = (await selectReceiptLines(tx, householdId, receipt.id)).filter(
    (l) => l.kind === "product",
  );
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const items = await selectItems(tx, householdId, list.id);
  const claimed = new Set<string>();
  const matched: ComparisonMatched[] = [];
  const forgotten: ItemView[] = [];
  const checkedMissing: ItemView[] = [];
  const boughtElsewhere: ItemView[] = [];
  for (const row of items) {
    const status = effective(row);
    const line =
      row.matchedReceiptLineId === null ? undefined : lineById.get(row.matchedReceiptLineId);
    if ((status === "suggested" || status === "confirmed") && line) {
      claimed.add(line.id);
      const source = row.matchSource ?? "manual";
      matched.push({
        item: itemView(row, actor.userId),
        line: lineView(line),
        score: row.matchScore,
        status,
        source,
        uncertain: status === "suggested" && (row.matchScore ?? 0) < MATCH_HIGH,
      });
    } else if (status === "confirmed" && row.matchedReceiptLineId !== null) {
      // Confirmat pe o linie a altui bon.
      boughtElsewhere.push(itemView(row, actor.userId));
    } else if (row.checked) {
      checkedMissing.push(itemView(row, actor.userId));
    } else {
      forgotten.push(itemView(row, actor.userId));
    }
  }
  return {
    receipt: {
      id: receipt.id,
      merchantName: receipt.merchantName,
      occurredOn: receipt.occurredOn,
    },
    list: { id: list.id, name: list.name, shared: list.ownerUserId === null },
    matched,
    unplanned: lines.filter((l) => !claimed.has(l.id)).map(lineView),
    forgotten,
    checkedMissing,
    boughtElsewhere,
    ai: { status: await aiStatusOf(tx, householdId, list.id, receipt.id) },
    lines: lines.map(lineView),
  };
}

/** Comparația persistată (citire). */
export async function getComparison(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  receiptId: string,
): Promise<ComparisonResult> {
  if (!isValidId(listId) || !isValidId(receiptId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = await selectList(tx, m.householdId, listId.toLowerCase());
    if (!list) throw new NotFoundError();
    const receipt = await requireSavedReceipt(tx, m.householdId, receiptId.toLowerCase());
    return {
      view: await buildView(tx, actor, m.householdId, list, receipt),
      shared: list.ownerUserId === null,
    };
  });
}

type Desired = Readonly<{
  lineId: string;
  score: number;
  source: "code" | "learned";
}>;

/**
 * Planul comparației (pur, fără bază): care articole intră în calcul (`pool`) și potrivirile
 * propuse de cod. Se ignoră deciziile utilizatorului (articole confirmate sau respinse pentru acest
 * bon) și alegerile pasului cu LLM nemodificate; liniile lor nu se mai oferă altor articole.
 * Folosită și de worker, ca să refacă DIN DATE perechile ambigue (cererea AI nu poartă conținut).
 */
export function planComparison(
  items: readonly ItemRow[],
  allLines: readonly ReceiptLineRow[],
  history: PairHistory,
): { pool: ItemRow[]; plan: ReturnType<typeof planMatches> } {
  const lineIds = new Set(allLines.map((l) => l.id));
  const productLines = allLines.filter((l) => l.kind === "product");
  const pool: ItemRow[] = [];
  const taken = new Set<string>(); // linii deja decise pentru acest bon
  for (const row of items) {
    const status = effective(row);
    const here = row.matchedReceiptLineId !== null && lineIds.has(row.matchedReceiptLineId);
    if (status === "confirmed") {
      if (here) taken.add(row.matchedReceiptLineId!);
      continue; // confirmat (aici sau pe alt bon): nu se mai propune nimic
    }
    if (status === "rejected" && here) continue; // respins pentru acest bon: definitiv
    if (status === "suggested" && row.matchSource === "ai" && here) {
      // Alegerea pasului cu LLM rămâne până o confirmi, o respingi sau o corectezi: o nouă
      // rulare a codului nu o suprascrie (și nu plătește un al doilea apel).
      taken.add(row.matchedReceiptLineId!);
      continue;
    }
    pool.push(row);
  }
  const matchLines: MatchLine[] = productLines
    .filter((l) => !taken.has(l.id) && lineNormalized(l) !== "")
    .map((l) => ({ id: l.id, normalizedName: lineNormalized(l), position: l.position }));
  const matchItems: MatchItem[] = pool.map((r) => ({
    id: r.id,
    normalizedName: r.normalizedName,
    position: r.position,
  }));
  return { pool, plan: planMatches({ items: matchItems, lines: matchLines, history }) };
}

/**
 * Rulează comparația: propune potrivirile (cod), le scrie pe articole (`suggested`) și, dacă există
 * perechi ambigue și utilizatorul a dat consimțământul `external_ai`, pune în coadă pasul opțional
 * cu LLM. Idempotentă: aceeași listă, același bon și aceleași date dau aceeași stare. Respectă
 * deciziile utilizatorului: articolele `confirmed` pe acest bon și cele `rejected` pentru acest bon
 * nu se ating; articolele confirmate pe alt bon nu intră în comparație.
 */
export async function runComparison(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  rawInput: unknown,
): Promise<ComparisonResult> {
  if (!isValidId(listId)) throw new NotFoundError();
  const input = parseInput(comparisonRunSchema, rawInput);
  const lid = listId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    // Lista rămâne blocată cât timp se scrie: două rulări concurente se serializează.
    const list = await selectList(tx, m.householdId, lid, true);
    if (!list) throw new NotFoundError();
    const receipt = await requireSavedReceipt(tx, m.householdId, input.receiptId);
    const allLines = await selectReceiptLines(tx, m.householdId, receipt.id);
    const lineIds = new Set(allLines.map((l) => l.id));
    const items = await selectItems(tx, m.householdId, lid);

    const { pool, plan } = planComparison(items, allLines, await loadHistory(tx, m.householdId));
    const desired = new Map<string, Desired>(
      plan.pairs.map((p) => [p.itemId, { lineId: p.lineId, score: p.score, source: p.source }]),
    );

    // Ce se schimbă: faza 1 pune pe `none` articolele ale căror propuneri se mută sau dispar (ca
    // indexul unic al liniei să nu se ciocnească), faza 2 scrie propunerile noi.
    const toClear: ItemRow[] = [];
    const toSet: { row: ItemRow; to: Desired }[] = [];
    for (const row of pool) {
      const want = desired.get(row.id);
      const current = effective(row);
      if (want) {
        const same =
          current === "suggested" &&
          row.matchedReceiptLineId === want.lineId &&
          row.matchScore === want.score &&
          row.matchSource === want.source;
        if (same) continue;
        // O propunere veche ține linia în indexul unic: se eliberează înainte de a o relua altcineva.
        if (current === "suggested") toClear.push(row);
        toSet.push({ row, to: want });
      } else {
        // Fără propunere nouă: dispare propunerea veche pentru ACEST bon (și orice legătură ruptă);
        // una pentru alt bon (încă nedecisă) sau o respingere pentru alt bon rămân.
        const here = row.matchedReceiptLineId !== null && lineIds.has(row.matchedReceiptLineId);
        const broken = row.matchedReceiptLineId === null && row.matchStatus !== "none";
        if ((row.matchStatus === "suggested" && here) || broken) toClear.push(row);
      }
    }
    for (const row of toClear) {
      await updateItemRow(tx, m.householdId, lid, row.id, {
        matchStatus: "none",
        matchedReceiptLineId: null,
        matchScore: null,
        matchSource: null,
      });
    }
    for (const { row, to } of toSet) {
      await updateItemRow(tx, m.householdId, lid, row.id, {
        matchStatus: "suggested",
        matchedReceiptLineId: to.lineId,
        matchScore: to.score,
        matchSource: to.source,
      });
    }
    if (toClear.length > 0 || toSet.length > 0) await touchList(tx, m.householdId, lid);

    // Pasul opțional cu LLM: doar dacă există perechi ambigue și utilizatorul a acceptat AI-ul
    // extern pentru bonuri (aceleași nume de produse pleacă la furnizor). Cererea conține doar
    // starea; workerul reface perechile ambigue din date și decide dacă rulează (AI_LIST_MATCH).
    if (
      plan.ambiguous.length > 0 &&
      (await selectAiRequest(tx, m.householdId, lid, receipt.id))?.status !== "done" &&
      (await hasActiveConsent(tx, actor.userId, "external_ai"))
    ) {
      await upsertAiRequest(tx, {
        householdId: m.householdId,
        listId: lid,
        receiptId: receipt.id,
        requestedByUserId: actor.userId,
      });
    }
    return {
      view: await buildView(tx, actor, m.householdId, list, receipt),
      shared: list.ownerUserId === null,
    };
  });
}

/** Bonurile confirmate recente, pentru alegerea celui cu care se compară lista. */
export async function listComparableReceipts(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
): Promise<ReceiptHeader[]> {
  return inHousehold(deps, actor, householdId, (tx, m) =>
    selectRecentSavedReceipts(tx, m.householdId, RECENT_RECEIPTS_LIMIT),
  );
}

// --- Acțiunile utilizatorului asupra propunerilor ------------------------------------------------

export type MatchResult = Readonly<{ item: ItemView; shared: boolean }>;

/**
 * Confirmă, respinge, șterge sau corectează potrivirea unui articol (ADR 0022 §4). Confirmarea și
 * corecția alimentează istoricul (aceeași pereche de nume va fi propusă ca „învățată”); respingerea
 * e reținută (perechea nu se mai propune). Nu modifică bonul sau tranzacția.
 */
export async function setItemMatch(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  itemId: string,
  rawInput: unknown,
): Promise<MatchResult> {
  if (!isValidId(listId) || !isValidId(itemId)) throw new NotFoundError();
  const input = parseInput(matchActionSchema, rawInput);
  const lid = listId.toLowerCase();
  const iid = itemId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = await selectList(tx, m.householdId, lid, true);
    if (!list) throw new NotFoundError();
    const current = await selectItem(tx, m.householdId, lid, iid, true);
    if (!current) throw new NotFoundError();
    const status = effective(current);
    let patch: Parameters<typeof updateItemRow>[4];
    switch (input.action) {
      case "confirm":
        if (status !== "suggested") {
          throw new ConflictError(
            "no_suggestion",
            "Articolul nu are nicio propunere de confirmat.",
          );
        }
        patch = { matchStatus: "confirmed" };
        break;
      case "reject":
        if (status !== "suggested" && status !== "confirmed") {
          throw new ConflictError("no_suggestion", "Articolul nu are nicio potrivire de respins.");
        }
        // Linia rămâne în rând (e memoria respingerii), fără să mai fie „propusă”.
        patch = { matchStatus: "rejected" };
        break;
      case "clear":
        patch = {
          matchStatus: "none",
          matchedReceiptLineId: null,
          matchScore: null,
          matchSource: null,
        };
        break;
      case "set": {
        const [line] = await selectLinesByIds(tx, m.householdId, [input.receiptLineId]);
        if (!line || line.kind !== "product") throw new NotFoundError();
        await requireSavedReceipt(tx, m.householdId, line.receiptId);
        // Linia e deja a altui articol al listei: o propunere se mută, o confirmare nu se ia.
        for (const other of await selectItems(tx, m.householdId, lid)) {
          if (other.id === iid || other.matchedReceiptLineId !== line.id) continue;
          const os = effective(other);
          if (os === "confirmed") {
            throw new ConflictError("line_already_matched", "Linia e deja asociată altui articol.");
          }
          if (os === "suggested") {
            await updateItemRow(tx, m.householdId, lid, other.id, {
              matchStatus: "none",
              matchedReceiptLineId: null,
              matchScore: null,
              matchSource: null,
            });
          }
        }
        patch = {
          matchStatus: "confirmed",
          matchedReceiptLineId: line.id,
          matchScore: 100,
          matchSource: "manual",
        };
        break;
      }
    }
    const row = await updateItemRow(tx, m.householdId, lid, iid, patch);
    if (!row) throw new NotFoundError();
    await touchList(tx, m.householdId, lid);
    return { item: itemView(row, actor.userId), shared: list.ownerUserId === null };
  });
}
