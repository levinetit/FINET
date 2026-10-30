import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { normalizeProductName } from "@/modules/receipts/normalize";

import {
  type ItemRow,
  type ListRow,
  type ListRowWithCounts,
  deleteItemRow,
  deleteListRow,
  insertItems,
  insertList,
  maxItemPosition,
  selectFrequentProducts,
  selectItem,
  selectItems,
  selectList,
  selectLists,
  setItemPositions,
  touchList,
  updateItemRow,
  updateListRow,
} from "./shopping.repo";
import {
  type ItemView,
  type ListView,
  type ListWithItems,
  canonicalQuantity,
  itemCreateSchema,
  itemUpdateSchema,
  listCopySchema,
  listCreateSchema,
  listFilterSchema,
  listUpdateSchema,
  reorderSchema,
  suggestionsQuerySchema,
} from "./shopping.schema";

/**
 * Listele de cumpărături (Faza 10, F10-A; ADR 0022): CRUD, bifarea la raft, reordonarea, copierea.
 *
 * - Vizibilitatea o impune RLS (`owner_user_id` NULL = comună; = X = personală a lui X): un id de
 *   listă personală a altui membru e „negăsit” (404), la fel ca unul inexistent.
 * - Bifarea e o stare EXPLICITĂ (`checked: true|false`), nu un comutator: o cerere repetată (rețea
 *   instabilă, dublu-tap) nu schimbă nimic; cine a bifat primul rămâne în `checked_by`.
 * - Mutațiile întorc și `shared` (lista e comună?), ca apelantul să aleagă publicul evenimentului
 *   live (o listă personală ajunge doar la proprietar), fără o interogare în plus.
 * - Plafoanele (100 de liste vizibile, 300 de articole pe listă) sunt în bază (triggere sub lock);
 *   depășirea → 409 `shopping_list_limit` / `shopping_item_limit`.
 * - Nimic din liste nu atinge tranzacțiile sau bonurile.
 */

export function listView(
  row: ListRowWithCounts | (ListRow & { itemCount?: number; checkedCount?: number }),
): ListView {
  return {
    id: row.id,
    name: row.name,
    shared: row.ownerUserId === null,
    status: row.status,
    itemCount: row.itemCount ?? 0,
    checkedCount: row.checkedCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function itemView(row: ItemRow, userId: string): ItemView {
  return {
    id: row.id,
    listId: row.listId,
    name: row.name,
    quantity: canonicalQuantity(row.quantity),
    unit: row.unit,
    note: row.note,
    checked: row.checked,
    checkedAt: row.checkedAt,
    checkedByMe: !row.checked
      ? null
      : row.checkedByUserId === null
        ? false
        : row.checkedByUserId.toLowerCase() === userId.toLowerCase(),
    position: row.position,
    // O potrivire fără linie (bonul a fost șters) se arată ca „fără potrivire”.
    match:
      row.matchedReceiptLineId === null
        ? { status: "none", score: null, source: null, receiptLineId: null }
        : {
            status: row.matchStatus,
            score: row.matchScore,
            source: row.matchSource,
            receiptLineId: row.matchedReceiptLineId,
          },
  };
}

/** Numele normalizat al articolului (garantat de schema Zod; aici doar o plasă de siguranță). */
function normalizedOf(name: string): string {
  const n = normalizeProductName(name);
  if (n === null)
    throw new ValidationError({ name: "Numele trebuie să conțină litere sau cifre." });
  return n;
}

async function requireList(
  tx: Tx,
  householdId: string,
  id: string,
  lock = false,
): Promise<ListRowWithCounts> {
  const row = await selectList(tx, householdId, id, lock);
  if (!row) throw new NotFoundError();
  return row;
}

export async function listLists(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<ListView[]> {
  const options = parseInput(listFilterSchema, rawOptions) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) =>
    (await selectLists(tx, m.householdId, options.status)).map(listView),
  );
}

export async function getList(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
): Promise<ListWithItems> {
  if (!isValidId(listId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = await requireList(tx, m.householdId, listId.toLowerCase());
    const items = await selectItems(tx, m.householdId, list.id);
    return { list: listView(list), items: items.map((i) => itemView(i, actor.userId)) };
  });
}

export async function createList(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<ListWithItems> {
  const input = parseInput(listCreateSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const row = await insertList(tx, {
      householdId: m.householdId,
      name: input.name,
      ownerUserId: input.personal === true ? actor.userId : null,
      createdByUserId: actor.userId,
    });
    const items = await insertItems(
      tx,
      (input.items ?? []).map((it, i) => ({
        householdId: m.householdId,
        listId: row.id,
        name: it.name,
        normalizedName: normalizedOf(it.name),
        quantity: it.quantity ?? "1",
        unit: it.unit ?? null,
        note: it.note ?? null,
        position: i + 1,
      })),
    );
    const view = listView({ ...row, itemCount: items.length, checkedCount: 0 });
    return { list: view, items: items.map((i) => itemView(i, actor.userId)) };
  });
}

export async function updateList(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  rawPatch: unknown,
): Promise<ListView> {
  if (!isValidId(listId)) throw new NotFoundError();
  const patch = parseInput(listUpdateSchema, rawPatch);
  const id = listId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await requireList(tx, m.householdId, id, true);
    // `shared: true` pe o listă deja comună = nimic de făcut (idempotent).
    const ownerPatch =
      patch.shared === true && current.ownerUserId !== null ? { ownerUserId: null } : {};
    const row = await updateListRow(tx, m.householdId, id, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...ownerPatch,
    });
    if (!row) throw new NotFoundError();
    return listView({ ...row, itemCount: current.itemCount, checkedCount: current.checkedCount });
  });
}

export async function deleteList(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
): Promise<Readonly<{ shared: boolean }>> {
  if (!isValidId(listId)) throw new NotFoundError();
  const id = listId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await requireList(tx, m.householdId, id, true);
    if (!(await deleteListRow(tx, m.householdId, id))) throw new NotFoundError();
    // Auditul poartă doar id-ul, dar e vizibil tuturor membrilor: o listă PERSONALĂ nu se auditează
    // (nu dezvăluim nici existența ei).
    if (current.ownerUserId === null) {
      await insertAudit(tx, actor.userId, m.householdId, {
        action: "shopping_list.deleted",
        targetType: "shopping_list",
        targetId: id,
        metadata: { items: current.itemCount },
      });
    }
    return { shared: current.ownerUserId === null };
  });
}

/** Copia unei liste: aceleași articole, nebifate, fără potriviri; vizibilitatea implicită = a sursei. */
export async function copyList(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  rawInput: unknown = {},
): Promise<ListWithItems> {
  if (!isValidId(listId)) throw new NotFoundError();
  const input = parseInput(listCopySchema, rawInput ?? {});
  const id = listId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const source = await requireList(tx, m.householdId, id);
    const sourceItems = await selectItems(tx, m.householdId, id);
    const personal = input.personal ?? source.ownerUserId !== null;
    const name = input.name ?? copyName(source.name);
    const row = await insertList(tx, {
      householdId: m.householdId,
      name,
      ownerUserId: personal ? actor.userId : null,
      createdByUserId: actor.userId,
    });
    const items = await insertItems(
      tx,
      sourceItems.map((it, i) => ({
        householdId: m.householdId,
        listId: row.id,
        name: it.name,
        normalizedName: it.normalizedName,
        quantity: it.quantity,
        unit: it.unit,
        note: it.note,
        position: i + 1,
      })),
    );
    const view = listView({ ...row, itemCount: items.length, checkedCount: 0 });
    return { list: view, items: items.map((i) => itemView(i, actor.userId)) };
  });
}

const COPY_SUFFIX = " (copie)";
function copyName(name: string): string {
  const chars = Array.from(name);
  return chars.length + COPY_SUFFIX.length <= 100
    ? `${name}${COPY_SUFFIX}`
    : `${chars
        .slice(0, 100 - COPY_SUFFIX.length)
        .join("")
        .trimEnd()}${COPY_SUFFIX}`;
}

// --- Articolele --------------------------------------------------------------------------------

export type ItemResult = Readonly<{ item: ItemView; shared: boolean }>;

export async function addItem(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  rawInput: unknown,
): Promise<ItemResult> {
  if (!isValidId(listId)) throw new NotFoundError();
  const input = parseInput(itemCreateSchema, rawInput);
  const id = listId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = await requireList(tx, m.householdId, id, true);
    const position = (await maxItemPosition(tx, m.householdId, id)) + 1;
    const [row] = await insertItems(tx, [
      {
        householdId: m.householdId,
        listId: id,
        name: input.name,
        normalizedName: normalizedOf(input.name),
        quantity: input.quantity ?? "1",
        unit: input.unit ?? null,
        note: input.note ?? null,
        position,
      },
    ]);
    await touchList(tx, m.householdId, id);
    return { item: itemView(row!, actor.userId), shared: list.ownerUserId === null };
  });
}

export async function updateItem(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  itemId: string,
  rawPatch: unknown,
): Promise<ItemResult> {
  if (!isValidId(listId) || !isValidId(itemId)) throw new NotFoundError();
  const patch = parseInput(itemUpdateSchema, rawPatch);
  const lid = listId.toLowerCase();
  const iid = itemId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = await requireList(tx, m.householdId, lid);
    const current = await selectItem(tx, m.householdId, lid, iid, true);
    if (!current) throw new NotFoundError();
    const set: Parameters<typeof updateItemRow>[4] = {};
    if (patch.name !== undefined && patch.name !== current.name) {
      set.name = patch.name;
      set.normalizedName = normalizedOf(patch.name);
      // O propunere sau o respingere nu mai are sens după o redenumire; una CONFIRMATĂ de
      // utilizator rămâne (decizia lui).
      if (current.matchStatus === "suggested" || current.matchStatus === "rejected") {
        set.matchStatus = "none";
        set.matchedReceiptLineId = null;
        set.matchScore = null;
        set.matchSource = null;
      }
    }
    if (patch.quantity !== undefined) set.quantity = patch.quantity;
    if (patch.unit !== undefined) set.unit = patch.unit;
    if (patch.note !== undefined) set.note = patch.note;
    if (patch.checked === true && !current.checked) {
      set.checked = true;
      set.checkedByUserId = actor.userId;
      set.checkedAt = new Date();
    } else if (patch.checked === false && current.checked) {
      set.checked = false;
      set.checkedByUserId = null;
      set.checkedAt = null;
    }
    // Nicio schimbare efectivă (de exemplu bifarea repetată): citirea curentă, fără scriere.
    const row =
      Object.keys(set).length === 0
        ? current
        : await updateItemRow(tx, m.householdId, lid, iid, set);
    if (!row) throw new NotFoundError();
    if (row !== current) await touchList(tx, m.householdId, lid);
    return { item: itemView(row, actor.userId), shared: list.ownerUserId === null };
  });
}

export async function deleteItem(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  itemId: string,
): Promise<Readonly<{ shared: boolean }>> {
  if (!isValidId(listId) || !isValidId(itemId)) throw new NotFoundError();
  const lid = listId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = await requireList(tx, m.householdId, lid);
    if (!(await deleteItemRow(tx, m.householdId, lid, itemId.toLowerCase()))) {
      throw new NotFoundError();
    }
    await touchList(tx, m.householdId, lid);
    return { shared: list.ownerUserId === null };
  });
}

/**
 * Ordinea nouă: o permutare EXACTĂ a articolelor listei. Dacă între timp altcineva a adăugat sau a
 * șters un articol, mulțimile diferă → 409 `order_mismatch` (clientul reîncarcă lista).
 */
export async function reorderItems(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  listId: string,
  rawInput: unknown,
): Promise<ListWithItems> {
  if (!isValidId(listId)) throw new NotFoundError();
  const input = parseInput(reorderSchema, rawInput);
  const lid = listId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = await requireList(tx, m.householdId, lid, true);
    const current = await selectItems(tx, m.householdId, lid);
    const wanted = input.itemIds;
    const same =
      wanted.length === current.length &&
      new Set(wanted).size === wanted.length &&
      current.every((i) => wanted.includes(i.id));
    if (!same) {
      throw new ConflictError(
        "order_mismatch",
        "Lista s-a schimbat; reîncarc-o și încearcă din nou.",
      );
    }
    await setItemPositions(tx, m.householdId, lid, wanted);
    await touchList(tx, m.householdId, lid);
    const items = await selectItems(tx, m.householdId, lid);
    return {
      list: listView({ ...list, updatedAt: new Date() }),
      items: items.map((i) => itemView(i, actor.userId)),
    };
  });
}

// --- Sugestii ----------------------------------------------------------------------------------

/** Câte zile înapoi se numără produsele frecvente. */
export const SUGGESTION_WINDOW_DAYS = 365;
export const SUGGESTION_LIMIT = 12;

export type Suggestion = Readonly<{ name: string; count: number }>;

/**
 * Produsele cumpărate des de gospodărie (nume normalizate din liniile bonurilor confirmate),
 * opțional filtrate după un prefix. Calculate în SQL, fără LLM; nu conțin sume sau comercianți.
 */
export async function suggestProducts(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawQuery: unknown = {},
): Promise<Suggestion[]> {
  const query = parseInput(suggestionsQuerySchema, rawQuery) ?? {};
  const prefix = query.q === undefined ? null : normalizeProductName(query.q);
  if (query.q !== undefined && query.q.trim() !== "" && prefix === null) return [];
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await selectFrequentProducts(
      tx,
      m.householdId,
      SUGGESTION_WINDOW_DAYS,
      prefix,
      SUGGESTION_LIMIT,
    );
    return rows.map((r) => ({ name: r.name, count: r.n }));
  });
}
