import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { selectTransaction } from "@/modules/transactions/transactions.repo";

import {
  type TagRow,
  deleteTagRow,
  insertTag,
  replaceTransactionTags,
  selectTag,
  selectTagIdsOf,
  selectTags,
  selectVisibleTagIds,
  tagNameTaken,
  updateTagRow,
  upsertTagVisibility,
} from "./tags.repo";
import {
  type TagView,
  tagCreateSchema,
  tagIdsSchema,
  tagListSchema,
  tagUpdateSchema,
} from "./tags.schema";

/**
 * Etichetele gospodăriei (5.4, Faza 3): listare cu numărul de utilizări, creare, modificare,
 * ascundere (și pentru cele de sistem, per gospodărie), ștergere (doar cele proprii; legăturile
 * dispar odată cu ea, cu `audit_event` fără nume) și etichetele unei tranzacții.
 *
 * Numele unei etichete e unic în gospodărie, fără majuscule, inclusiv față de etichetele de
 * sistem (decizia mea: „Cadou” personal lângă „Cadou” de sistem ar fi ambiguu în filtre).
 */

function view(row: TagRow): TagView {
  const isSystem = row.householdId === null;
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    hidden: isSystem ? (row.visibilityHidden ?? false) : row.hidden,
    isSystem,
    systemKey: row.systemKey,
    usageCount: row.usageCount,
  };
}

export async function listTags(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<TagView[]> {
  const options = parseInput(tagListSchema, rawOptions) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const list = (await selectTags(tx, m.householdId)).map(view);
    return options.includeHidden ? list : list.filter((t) => !t.hidden);
  });
}

export async function getTag(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  tagId: string,
): Promise<TagView> {
  if (!isValidId(tagId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const row = await selectTag(tx, m.householdId, tagId.toLowerCase());
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

const nameTaken = () =>
  new ConflictError("tag_name_taken", "Există deja o etichetă cu acest nume.");

export async function createTag(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<TagView> {
  const input = parseInput(tagCreateSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    if (await tagNameTaken(tx, m.householdId, input.name)) throw nameTaken();
    const row = await insertTag(tx, {
      householdId: m.householdId,
      name: input.name,
      color: input.color ?? null,
    });
    return view({ ...row, visibilityHidden: null, usageCount: 0 });
  });
}

export async function updateTag(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  tagId: string,
  rawPatch: unknown,
): Promise<TagView> {
  if (!isValidId(tagId)) throw new NotFoundError();
  const patch = parseInput(tagUpdateSchema, rawPatch);
  const id = tagId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectTag(tx, m.householdId, id);
    if (!current) throw new NotFoundError();
    if (current.householdId === null) {
      if (patch.name !== undefined || patch.color !== undefined) {
        throw new ConflictError(
          "system_tag",
          "Etichetele de sistem nu se modifică; se pot doar ascunde.",
        );
      }
      if (patch.hidden !== undefined) {
        await upsertTagVisibility(tx, m.householdId, id, patch.hidden);
      }
    } else {
      if (!(await selectTag(tx, m.householdId, id, true))) throw new NotFoundError();
      if (patch.name !== undefined && (await tagNameTaken(tx, m.householdId, patch.name, id))) {
        throw nameTaken();
      }
      await updateTagRow(tx, m.householdId, id, {
        name: patch.name,
        color: patch.color,
        hidden: patch.hidden,
      });
    }
    const row = await selectTag(tx, m.householdId, id);
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

/** Șterge o etichetă proprie (și legăturile ei); una de sistem → 409 (se poate doar ascunde). */
export async function deleteTag(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  tagId: string,
): Promise<void> {
  if (!isValidId(tagId)) throw new NotFoundError();
  const id = tagId.toLowerCase();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectTag(tx, m.householdId, id);
    if (!current) throw new NotFoundError();
    if (current.householdId === null) {
      throw new ConflictError("system_tag", "Etichetele de sistem nu se șterg; se pot ascunde.");
    }
    if (!(await deleteTagRow(tx, m.householdId, id))) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "tag.deleted",
      targetType: "tag",
      targetId: id,
      metadata: { usageCount: current.usageCount },
    });
  });
}

/**
 * Validează `rawTagIds` (listă, cel mult 10, distincte) și le pune pe tranzacție, ÎNLOCUIND
 * etichetele existente. Rulează în tranzacția apelantului (servicii de tranzacții). O etichetă
 * inexistentă sau a altei gospodării → 404 uniform; una ascunsă e acceptată (decizia mea: ascuns
 * înseamnă „nu o propune”, nu „interzisă”).
 */
export async function applyTransactionTags(
  tx: Tx,
  householdId: string,
  transactionId: string,
  tagIds: readonly string[],
): Promise<void> {
  const visible = await selectVisibleTagIds(tx, householdId, tagIds);
  if (visible.size !== tagIds.length) throw new NotFoundError();
  await replaceTransactionTags(tx, householdId, transactionId, tagIds);
}

/** Parsează lista de etichete (aceleași reguli ca în crearea tranzacției). */
export function parseTagIds(raw: unknown): string[] {
  const parsed = tagIdsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError({ tagIds: parsed.error.issues[0]?.message ?? "Valoare invalidă." });
  }
  return parsed.data;
}

/** Atașează/înlocuiește etichetele unei tranzacții (venit sau cheltuială; nu și transferuri). */
export async function setTransactionTags(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
  rawTagIds: unknown,
): Promise<string[]> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  const tagIds = parseTagIds(rawTagIds);
  const id = transactionId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectTransaction(tx, m.householdId, id, true);
    if (!current) throw new NotFoundError();
    if (current.type === "transfer") {
      throw new ConflictError("transfer_row", "Transferurile nu au etichete.");
    }
    await applyTransactionTags(tx, m.householdId, id, tagIds);
    return (await selectTagIdsOf(tx, m.householdId, [id])).get(id) ?? [];
  });
}

/** Etichetele (id-uri) unei tranzacții a gospodăriei; tranzacție străină → 404. */
export async function getTransactionTagIds(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  transactionId: string,
): Promise<string[]> {
  if (!isValidId(transactionId)) throw new NotFoundError();
  const id = transactionId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    if (!(await selectTransaction(tx, m.householdId, id))) throw new NotFoundError();
    return (await selectTagIdsOf(tx, m.householdId, [id])).get(id) ?? [];
  });
}
