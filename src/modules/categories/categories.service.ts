import "server-only";

import type { Tx } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";

import {
  type CategoryRow,
  countUsage,
  deleteCategoryRow,
  hasChildren,
  insertCategory,
  reassignTransactions,
  selectCategories,
  selectCategory,
  updateCategoryRow,
  upsertVisibility,
} from "./categories.repo";
import {
  type CategoryView,
  categoryCreateSchema,
  categoryDeleteSchema,
  categoryListSchema,
  categoryUpdateSchema,
} from "./categories.schema";

/**
 * Categoriile (5.4, 5.6): cele de sistem nu se șterg și nu se modifică, doar se ascund per
 * gospodărie (`category_visibility`); cele personalizate se creează, se modifică și se șterg
 * (dacă sunt folosite, doar cu reasignarea tranzacțiilor). Ierarhie pe un singur nivel.
 */

function view(row: CategoryRow): CategoryView {
  const isSystem = row.householdId === null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parentId: row.parentId,
    icon: row.icon,
    color: row.color,
    hidden: isSystem ? (row.visibilityHidden ?? false) : row.hidden,
    isSystem,
    systemKey: row.systemKey,
  };
}

export async function listCategories(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawOptions: unknown = {},
): Promise<CategoryView[]> {
  const options = parseInput(categoryListSchema, rawOptions) ?? {};
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = (await selectCategories(tx, m.householdId)).map(view);
    return rows.filter(
      (c) =>
        (options.kind === undefined || c.kind === options.kind) &&
        (options.includeHidden !== false || !c.hidden),
    );
  });
}

export async function getCategory(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  categoryId: string,
): Promise<CategoryView> {
  if (!isValidId(categoryId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const row = await selectCategory(tx, m.householdId, categoryId.toLowerCase());
    if (!row) throw new NotFoundError();
    return view(row);
  });
}

/** Părintele: vizibil, de același tip, fără părinte propriu, diferit de categoria însăși. */
async function checkParent(
  tx: Tx,
  householdId: string,
  parentId: string,
  kind: CategoryRow["kind"],
  selfId: string | null,
): Promise<void> {
  const fail = (message: string) => new ValidationError({ parentId: message });
  if (parentId === selfId) throw fail("O categorie nu poate fi propriul părinte.");
  const parent = await selectCategory(tx, householdId, parentId);
  if (!parent) throw fail("Categoria părinte nu există.");
  if (parent.parentId !== null) throw fail("Ierarhia are un singur nivel.");
  if (parent.kind !== kind) throw fail("Categoria părinte are alt tip.");
  if (selfId && (await hasChildren(tx, householdId, selfId))) {
    throw fail("O categorie cu subcategorii nu poate avea părinte.");
  }
}

export async function createCategory(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<CategoryView> {
  const input = parseInput(categoryCreateSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    if (input.parentId) await checkParent(tx, m.householdId, input.parentId, input.kind, null);
    const row = await insertCategory(tx, {
      householdId: m.householdId,
      name: input.name,
      kind: input.kind,
      parentId: input.parentId ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
    });
    return view({ ...row, visibilityHidden: null });
  });
}

export async function updateCategory(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  categoryId: string,
  rawPatch: unknown,
): Promise<CategoryView> {
  if (!isValidId(categoryId)) throw new NotFoundError();
  const patch = parseInput(categoryUpdateSchema, rawPatch);
  const id = categoryId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectCategory(tx, m.householdId, id);
    if (!current) throw new NotFoundError();
    if (current.householdId === null) {
      const { hidden, ...rest } = patch;
      if (Object.values(rest).some((v) => v !== undefined)) {
        throw new ConflictError(
          "system_category_readonly",
          "Categoriile de sistem nu se modifică; se pot doar ascunde.",
        );
      }
      if (hidden !== undefined) await upsertVisibility(tx, m.householdId, id, hidden);
    } else {
      await selectCategory(tx, m.householdId, id, true);
      if (patch.parentId) await checkParent(tx, m.householdId, patch.parentId, current.kind, id);
      await updateCategoryRow(tx, m.householdId, id, {
        name: patch.name,
        parentId: patch.parentId,
        icon: patch.icon,
        color: patch.color,
        hidden: patch.hidden,
      });
    }
    const row = await selectCategory(tx, m.householdId, id);
    return view(row!);
  });
}

/**
 * Șterge o categorie personalizată (5.6). Folosită → cere `reassignTo` (o categorie vizibilă, de
 * același tip); tranzacțiile se mută în aceeași tranzacție SQL, apoi categoria se șterge.
 * Întoarce câte tranzacții au fost reasignate.
 */
export async function deleteCategory(
  deps: LedgerDeps,
  actor: Actor,
  householdId: string,
  categoryId: string,
  rawOptions: unknown = {},
): Promise<{ reassigned: number }> {
  if (!isValidId(categoryId)) throw new NotFoundError();
  const options = parseInput(categoryDeleteSchema, rawOptions) ?? {};
  const id = categoryId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const current = await selectCategory(tx, m.householdId, id);
    if (!current) throw new NotFoundError();
    if (current.householdId === null) {
      throw new ConflictError(
        "system_category_readonly",
        "Categoriile de sistem nu se șterg; se pot ascunde.",
      );
    }
    await selectCategory(tx, m.householdId, id, true);
    if (await hasChildren(tx, m.householdId, id)) {
      throw new ConflictError("category_has_children", "Mută sau șterge întâi subcategoriile.");
    }
    let reassigned = 0;
    if ((await countUsage(tx, m.householdId, id)) > 0) {
      if (!options.reassignTo) {
        throw new ConflictError(
          "category_in_use",
          "Categoria e folosită: alege categoria care preia tranzacțiile.",
        );
      }
      if (options.reassignTo === id) {
        throw new ValidationError({ reassignTo: "Alege o altă categorie." });
      }
      const target = await selectCategory(tx, m.householdId, options.reassignTo);
      if (!target) throw new ValidationError({ reassignTo: "Categoria nu există." });
      if (target.kind !== current.kind) {
        throw new ValidationError({ reassignTo: "Categoria are alt tip." });
      }
      reassigned = await reassignTransactions(tx, m.householdId, id, target.id);
    }
    if (!(await deleteCategoryRow(tx, m.householdId, id))) throw new NotFoundError();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "category.deleted",
      targetType: "category",
      targetId: id,
      metadata: { reassigned },
    });
    return { reassigned };
  });
}
