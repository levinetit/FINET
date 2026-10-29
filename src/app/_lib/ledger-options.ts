import "server-only";

import type { Actor } from "@/lib/authz";
import type { Db } from "@/db";
import { listAccounts } from "@/modules/accounts/accounts.service";
import { listCategories } from "@/modules/categories/categories.service";
import { listTags } from "@/modules/tags/tags.service";

/**
 * Opțiunile formularelor de tranzacții și transferuri, citite pe server: conturile ACTIVE (pe un
 * cont arhivat nu se adaugă tranzacții) și categoriile vizibile. `keep` păstrează în listă contul
 * și categoria curente ale unei tranzacții editate, chiar dacă între timp au fost arhivate/ascunse.
 */
export async function formOptions(
  db: Db,
  actor: Actor,
  householdId: string,
  keep: Readonly<{
    accountId?: string;
    categoryId?: string | null;
    tagIds?: readonly string[];
  }> = {},
) {
  const deps = { db };
  const [accounts, categories, tags] = await Promise.all([
    listAccounts(deps, actor, householdId, { includeArchived: true }),
    listCategories(deps, actor, householdId, { includeHidden: true }),
    listTags(deps, actor, householdId, { includeHidden: true }),
  ]);
  const keptTags = new Set(keep.tagIds ?? []);
  return {
    accounts: accounts.accounts
      .filter((a) => a.archivedAt === null || a.id === keep.accountId)
      .map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    categories: categories
      .filter((c) => !c.hidden || c.id === keep.categoryId)
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    tags: tags
      .filter((t) => !t.hidden || keptTags.has(t.id))
      .map((t) => ({ id: t.id, name: t.name, color: t.color })),
    // Faza 8: `ownerUserId` (null = cont comun) decide dacă o cheltuială se poate împărți.
    allAccounts: accounts.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      ownerUserId: a.ownerUserId,
    })),
  };
}
