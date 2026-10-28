import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  sqlState,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTransaction, getTransaction } from "@/modules/transactions/transactions.service";

import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from "./categories.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Categoriile de sistem din master prompt 5.4, în ordinea de acolo. */
const EXPENSES = [
  "Alimente",
  "Restaurante și cafenele",
  "Locuință (chirie/rată)",
  "Utilități (curent, gaz, apă)",
  "Internet și telefonie",
  "Transport și combustibil",
  "Sănătate și farmacie",
  "Îmbrăcăminte și încălțăminte",
  "Copii",
  "Educație",
  "Divertisment",
  "Abonamente",
  "Cadouri și donații",
  "Taxe și impozite",
  "Asigurări",
  "Asociația de proprietari (întreținere bloc)",
  "Casă și reparații",
  "Igienă și cosmetice",
  "Animale de companie",
  "Vacanțe și călătorii",
  "Altele",
];
const INCOMES = [
  "Salariu",
  "Freelance/PFA",
  "Chirii încasate",
  "Dobânzi și dividende",
  "Rambursări",
  "Cadouri primite",
  "Alte venituri",
];

describe.skipIf(!TEST_ADMIN_URL)("categorii (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let accountA: string;
  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_cat");
    accountA = (
      await createAccount(f.deps, f.A, f.HA, { name: "Card", type: "bank", currency: "RON" })
    ).id;
  });
  afterAll(async () => {
    await f?.close();
  });

  it("categoriile de sistem din 5.4: 21 de cheltuieli și 7 venituri, în ordine, cu ș/ț cu virgulă", async () => {
    const list = await listCategories(f.deps, f.A, f.HA);
    const system = list.filter((c) => c.isSystem);
    expect(system.filter((c) => c.kind === "expense").map((c) => c.name)).toEqual(EXPENSES);
    expect(system.filter((c) => c.kind === "income").map((c) => c.name)).toEqual(INCOMES);
    for (const c of system) {
      expect(c.name, c.name).not.toMatch(/[ŞşŢţ]/); // sedilă
      expect(c.systemKey).toMatch(new RegExp(`^${c.kind}\\.[a-z0-9_]+$`));
      expect(c.parentId).toBeNull();
      expect(c.hidden).toBe(false);
    }
    expect(system.map((c) => c.name).join("")).toMatch(/[\u0219\u021b]/);
    expect(new Set(system.map((c) => c.systemKey)).size).toBe(28);
  });

  it("categoriile de sistem nu se șterg și nu se modifică (serviciu și bază)", async () => {
    const groceries = await systemCategoryId(f.admin, "expense.groceries");
    await expect(deleteCategory(f.deps, f.A, f.HA, groceries)).rejects.toMatchObject({
      reason: "system_category_readonly",
    });
    await expect(
      updateCategory(f.deps, f.A, f.HA, groceries, { name: "Mâncare" }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Direct în bază, ca finet_app, cu context valid: 0 rânduri afectate.
    const ctx = { userId: f.A.userId, householdId: f.HA };
    const deleted = await withRlsOn(f.db, ctx, (tx) =>
      tx.execute(sql`delete from finet.categories where id = ${groceries} returning id`),
    );
    expect(deleted.length).toBe(0);
    const updated = await withRlsOn(f.db, ctx, (tx) =>
      tx.execute(
        sql`update finet.categories set name = 'X', updated_at = now() where id = ${groceries} returning id`,
      ),
    );
    expect(updated.length).toBe(0);
    // Nici prin „mutarea” rândului de sistem într-o gospodărie (coloana nu poate fi scrisă).
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctx, (tx) =>
          tx.execute(sql`update finet.categories set household_id = ${f.HA} where id = ${groceries}`),
        ),
      ),
    ).toBe("42501");
    const [row] = await f.admin<{ name: string }[]>`
      select name from finet.categories where id = ${groceries}`;
    expect(row!.name).toBe("Alimente");
  });

  it("ascunderea unei categorii de sistem e per gospodărie și nu atinge rândul de sistem", async () => {
    const pets = await systemCategoryId(f.admin, "expense.pets");
    const hidden = await updateCategory(f.deps, f.A, f.HA, pets, { hidden: true });
    expect(hidden).toMatchObject({ id: pets, hidden: true, isSystem: true });
    const visibleA = await listCategories(f.deps, f.A, f.HA, { includeHidden: false });
    expect(visibleA.map((c) => c.id)).not.toContain(pets);
    // HB nu e afectată.
    const b = await getCategory(f.deps, f.B, f.HB, pets);
    expect(b.hidden).toBe(false);
    const [row] = await f.admin<{ hidden: boolean }[]>`
      select hidden from finet.categories where id = ${pets}`;
    expect(row!.hidden).toBe(false);
    expect((await updateCategory(f.deps, f.A, f.HA, pets, { hidden: false })).hidden).toBe(false);
    // Vizibilitatea se setează doar pentru categoriile de sistem (trigger).
    const custom = await createCategory(f.deps, f.A, f.HA, { name: "Hobby", kind: "expense" });
    expect(
      await sqlState(() =>
        withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, (tx) =>
          tx.execute(
            sql`insert into finet.category_visibility (household_id, category_id) values (${f.HA}, ${custom.id})`,
          ),
        ),
      ),
    ).toBe("23503");
  });

  it("personalizate: creare, modificare, ierarhie pe un singur nivel, același tip", async () => {
    const food = await systemCategoryId(f.admin, "expense.groceries");
    const child = await createCategory(f.deps, f.A, f.HA, {
      name: "Piață",
      kind: "expense",
      parentId: food,
      color: "#AA00FF",
      icon: "basket",
    });
    expect(child).toMatchObject({ parentId: food, color: "#aa00ff", isSystem: false });
    // Al doilea nivel → respins.
    await expect(
      createCategory(f.deps, f.A, f.HA, { name: "Legume", kind: "expense", parentId: child.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Părinte de alt tip → respins.
    const salary = await systemCategoryId(f.admin, "income.salary");
    await expect(
      createCategory(f.deps, f.A, f.HA, { name: "Bonus", kind: "expense", parentId: salary }),
    ).rejects.toBeInstanceOf(ValidationError);
    // O categorie cu copii nu poate deveni copil.
    const parent = await createCategory(f.deps, f.A, f.HA, { name: "Mașină", kind: "expense" });
    await createCategory(f.deps, f.A, f.HA, { name: "ITP", kind: "expense", parentId: parent.id });
    await expect(
      updateCategory(f.deps, f.A, f.HA, parent.id, { parentId: food }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Aceleași reguli în bază (trigger), ocolind serviciul.
    const ctx = { userId: f.A.userId, householdId: f.HA };
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctx, (tx) =>
          tx.execute(
            sql`insert into finet.categories (household_id, name, kind, parent_id) values (${f.HA}, 'Z', 'expense', ${child.id})`,
          ),
        ),
      ),
    ).toBe("23514");
    const renamed = await updateCategory(f.deps, f.A, f.HA, child.id, {
      name: "Piața de duminică",
      hidden: true,
    });
    expect(renamed).toMatchObject({ name: "Piața de duminică", hidden: true });
    // Nume duplicat sub același părinte → conflict.
    await createCategory(f.deps, f.A, f.HA, { name: "Unic", kind: "income" });
    await expect(
      createCategory(f.deps, f.A, f.HA, { name: "UNIC", kind: "income" }),
    ).rejects.toMatchObject({ reason: "category_name_taken" });
  });

  it("ștergerea: folosită → cere reasignare; cu reasignare mută tranzacțiile", async () => {
    const old = await createCategory(f.deps, f.A, f.HA, { name: "Veche", kind: "expense" });
    const target = await systemCategoryId(f.admin, "expense.other");
    const t = await createTransaction(f.deps, f.A, f.HA, {
      accountId: accountA,
      type: "expense",
      amountMinor: 100,
      occurredOn: "2026-10-01",
      categoryId: old.id,
    });
    await expect(deleteCategory(f.deps, f.A, f.HA, old.id)).rejects.toMatchObject({
      reason: "category_in_use",
    });
    const salary = await systemCategoryId(f.admin, "income.salary");
    await expect(
      deleteCategory(f.deps, f.A, f.HA, old.id, { reassignTo: salary }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      deleteCategory(f.deps, f.A, f.HA, old.id, { reassignTo: old.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await deleteCategory(f.deps, f.A, f.HA, old.id, { reassignTo: target })).toEqual({
      reassigned: 1,
    });
    expect((await getTransaction(f.deps, f.A, f.HA, t.id)).categoryId).toBe(target);
    await expect(getCategory(f.deps, f.A, f.HA, old.id)).rejects.toBeInstanceOf(NotFoundError);
    // Nefolosită: se șterge direct. Cu subcategorii: refuzat.
    const free = await createCategory(f.deps, f.A, f.HA, { name: "Liberă", kind: "income" });
    expect(await deleteCategory(f.deps, f.A, f.HA, free.id)).toEqual({ reassigned: 0 });
    const p = await createCategory(f.deps, f.A, f.HA, { name: "Părinte", kind: "income" });
    await createCategory(f.deps, f.A, f.HA, { name: "Copil", kind: "income", parentId: p.id });
    await expect(deleteCategory(f.deps, f.A, f.HA, p.id)).rejects.toMatchObject({
      reason: "category_has_children",
    });
    // Folosită și ștearsă direct în bază, fără reasignare → cheia străină refuză.
    const used = await createCategory(f.deps, f.A, f.HA, { name: "Folosită", kind: "expense" });
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: accountA,
      type: "expense",
      amountMinor: 1,
      occurredOn: "2026-10-01",
      categoryId: used.id,
    });
    expect(
      await sqlState(() =>
        withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, (tx) =>
          tx.execute(sql`delete from finet.categories where id = ${used.id}`),
        ),
      ),
    ).toBe("23503");
  });

  it("izolare: B nu vede, nu folosește și nu modifică categoriile personalizate ale lui A", async () => {
    const secret = await createCategory(f.deps, f.A, f.HA, { name: "Secretă", kind: "expense" });
    const listB = await listCategories(f.deps, f.B, f.HB);
    expect(listB.map((c) => c.id)).not.toContain(secret.id);
    expect(listB.every((c) => c.isSystem)).toBe(true);
    for (const op of [
      () => getCategory(f.deps, f.B, f.HB, secret.id),
      () => updateCategory(f.deps, f.B, f.HB, secret.id, { name: "Furată" }),
      () => deleteCategory(f.deps, f.B, f.HB, secret.id),
      () => listCategories(f.deps, f.B, f.HA),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(NotFoundError);
    }
    // B nu poate atașa categoria lui A ca părinte sau la o tranzacție.
    await expect(
      createCategory(f.deps, f.B, f.HB, { name: "X", kind: "expense", parentId: secret.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    const accB = await createAccount(f.deps, f.B, f.HB, {
      name: "B",
      type: "cash",
      currency: "RON",
    });
    await expect(
      createTransaction(f.deps, f.B, f.HB, {
        accountId: accB.id,
        type: "expense",
        amountMinor: 1,
        occurredOn: "2026-10-01",
        categoryId: secret.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Ocolind serviciul: cheia străină simplă ar accepta-o, triggerul (sub RLS) o respinge.
    const ctxB = { userId: f.B.userId, householdId: f.HB };
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctxB, (tx) =>
          tx.execute(sql`
            insert into finet.transactions
              (household_id, account_id, created_by_user_id, type, amount_minor, currency, occurred_on, category_id)
            values (${f.HB}, ${accB.id}, ${f.B.userId}, 'expense', 1, 'RON', '2026-10-01', ${secret.id})`),
        ),
      ),
    ).toBe("23503");
    expect(
      await sqlState(() =>
        withRlsOn(f.db, ctxB, (tx) =>
          tx.execute(
            sql`insert into finet.categories (household_id, name, kind, parent_id) values (${f.HB}, 'Y', 'expense', ${secret.id})`,
          ),
        ),
      ),
    ).toBe("23503");
    // Categoria tranzacției trebuie să aibă același tip.
    const salary = await systemCategoryId(f.admin, "income.salary");
    await expect(
      createTransaction(f.deps, f.B, f.HB, {
        accountId: accB.id,
        type: "expense",
        amountMinor: 1,
        occurredOn: "2026-10-01",
        categoryId: salary,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(getCategory(f.deps, f.B, f.HB, randomUUID())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
