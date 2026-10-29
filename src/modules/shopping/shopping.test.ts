import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";

import {
  getComparison,
  listComparableReceipts,
  runComparison,
  setItemMatch,
} from "./compare.service";
import { MATCH_HIGH } from "./match";
import {
  addItem,
  copyList,
  createList,
  deleteItem,
  deleteList,
  getList,
  listLists,
  reorderItems,
  suggestProducts,
  updateItem,
  updateList,
} from "./shopping.service";
import { canonicalQuantity, quantitySchema } from "./shopping.schema";
import { grantExternalAi, seedReceipt } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

describe("cantitatea (fără float)", () => {
  it("forma canonică și respingerea valorilor invalide", () => {
    expect(canonicalQuantity("2.000")).toBe("2");
    expect(canonicalQuantity("0.500")).toBe("0.5");
    expect(canonicalQuantity("007")).toBe("7");
    expect(canonicalQuantity("12.340")).toBe("12.34");
    expect(quantitySchema.parse("1,5")).toBe("1.5");
    expect(quantitySchema.parse(3)).toBe("3");
    expect(quantitySchema.parse("0.001")).toBe("0.001");
    for (const bad of ["0", "0.000", "-1", "1.2345", "1e3", "abc", "", "1000000", 1e21, 0.1 + 0.2]) {
      expect(quantitySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe.skipIf(!TEST_ADMIN_URL)("liste de cumpărături (Postgres real, finet_app)", () => {
  let f: FamilyFixture;

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_shop");
  });
  afterAll(async () => {
    await f?.close();
  });

  const names = (items: readonly { name: string }[]) => items.map((i) => i.name);

  it("creare, citire, validare strictă și curățarea numelui", async () => {
    const created = await createList(f.deps, f.A, f.HA, {
      name: "  Cumpărături   săptămâna 1 ",
      items: [{ name: "Lapte 1,5% 1L", quantity: "2", unit: "buc" }, { name: " Pâine " }],
    });
    expect(created.list).toMatchObject({
      name: "Cumpărături săptămâna 1",
      shared: true,
      status: "active",
      itemCount: 2,
      checkedCount: 0,
    });
    expect(created.items.map((i) => [i.name, i.quantity, i.unit, i.position])).toEqual([
      ["Lapte 1,5% 1L", "2", "buc", 1],
      ["Pâine", "1", null, 2],
    ]);
    const read = await getList(f.deps, f.C, f.HA, created.list.id);
    expect(names(read.items)).toEqual(["Lapte 1,5% 1L", "Pâine"]);
    // Cheile necunoscute (gospodărie, proprietar) sunt respinse.
    for (const extra of [{ householdId: f.HB }, { ownerUserId: f.A.userId }, { id: "x" }]) {
      await expect(createList(f.deps, f.A, f.HA, { name: "X", ...extra })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    for (const bad of ["", "   ", "x".repeat(101), "\u0000", 5, null]) {
      await expect(createList(f.deps, f.A, f.HA, { name: bad })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    // Un articol fără litere/cifre nu se poate potrivi: refuzat.
    await expect(
      addItem(f.deps, f.A, f.HA, created.list.id, { name: "!!!" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      addItem(f.deps, f.A, f.HA, created.list.id, { name: "ok", quantity: "0" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      addItem(f.deps, f.A, f.HA, created.list.id, { name: "ok", extra: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("lista personală e invizibilă celorlalți membri (și altei gospodării); comună pe cerere", async () => {
    const personal = await createList(f.deps, f.C, f.HA, {
      name: "Doar a mea",
      personal: true,
      items: [{ name: "Cadou surpriză" }],
    });
    expect(personal.list.shared).toBe(false);
    // Proprietarul o vede; owner-ul gospodăriei (A) NU, nici altă gospodărie (B).
    expect((await listLists(f.deps, f.C, f.HA)).map((l) => l.id)).toContain(personal.list.id);
    expect((await listLists(f.deps, f.A, f.HA)).map((l) => l.id)).not.toContain(personal.list.id);
    await expect(getList(f.deps, f.A, f.HA, personal.list.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getList(f.deps, f.B, f.HB, personal.list.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getList(f.deps, f.B, f.HA, personal.list.id)).rejects.toBeInstanceOf(NotFoundError);
    // Nici nu o poate modifica, șterge sau completa.
    await expect(
      updateList(f.deps, f.A, f.HA, personal.list.id, { name: "Furat" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      addItem(f.deps, f.A, f.HA, personal.list.id, { name: "Intrus" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateItem(f.deps, f.A, f.HA, personal.list.id, personal.items[0]!.id, { checked: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteList(f.deps, f.A, f.HA, personal.list.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(copyList(f.deps, f.A, f.HA, personal.list.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Proprietarul o poate face comună (o singură direcție).
    const shared = await updateList(f.deps, f.C, f.HA, personal.list.id, { shared: true });
    expect(shared.shared).toBe(true);
    expect((await getList(f.deps, f.A, f.HA, personal.list.id)).items).toHaveLength(1);
    // Idempotent.
    expect((await updateList(f.deps, f.C, f.HA, personal.list.id, { shared: true })).shared).toBe(
      true,
    );
  });

  it("o listă comună nu devine personală (trigger în bază)", async () => {
    const common = await createList(f.deps, f.A, f.HA, { name: "Comună" });
    const { withRlsOn } = await import("@/db");
    const { sql } = await import("drizzle-orm");
    await expect(
      withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, (tx) =>
        tx.execute(
          sql`update finet.shopping_lists set owner_user_id = ${f.A.userId} where id = ${common.list.id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("bifarea e idempotentă (stare explicită), păstrează primul autor și se poate anula", async () => {
    const l = await createList(f.deps, f.A, f.HA, { name: "Raft", items: [{ name: "Cafea" }] });
    const id = l.items[0]!.id;
    const first = await updateItem(f.deps, f.A, f.HA, l.list.id, id, { checked: true });
    expect(first.item.checked).toBe(true);
    expect(first.item.checkedByMe).toBe(true);
    expect(first.shared).toBe(true);
    // A doua cerere identică (de la altcineva) nu schimbă nimic.
    const again = await updateItem(f.deps, f.C, f.HA, l.list.id, id, { checked: true });
    expect(again.item.checkedAt).toEqual(first.item.checkedAt);
    expect(again.item.checkedByMe).toBe(false);
    const read = await getList(f.deps, f.A, f.HA, l.list.id);
    expect(read.list.checkedCount).toBe(1);
    const off = await updateItem(f.deps, f.C, f.HA, l.list.id, id, { checked: false });
    expect(off.item).toMatchObject({ checked: false, checkedAt: null, checkedByMe: null });
    expect((await updateItem(f.deps, f.C, f.HA, l.list.id, id, { checked: false })).item.checked).toBe(
      false,
    );
    await expect(
      updateItem(f.deps, f.A, f.HA, l.list.id, id, {}),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("editare, ștergere, reordonare (permutare exactă) și copiere", async () => {
    const l = await createList(f.deps, f.A, f.HA, {
      name: "Ordine",
      items: [{ name: "a1" }, { name: "b2" }, { name: "c3" }],
    });
    const [a, b, c] = l.items.map((i) => i.id) as [string, string, string];
    const renamed = await updateItem(f.deps, f.A, f.HA, l.list.id, b, {
      name: "Brânză",
      quantity: "0,5",
      unit: "kg",
      note: "telemea",
    });
    expect(renamed.item).toMatchObject({ name: "Brânză", quantity: "0.5", unit: "kg", note: "telemea" });
    const order = await reorderItems(f.deps, f.A, f.HA, l.list.id, { itemIds: [c, a, b] });
    expect(names(order.items)).toEqual(["c3", "a1", "Brânză"]);
    expect(order.items.map((i) => i.position)).toEqual([1, 2, 3]);
    // Mulțime diferită (articol lipsă, în plus, dublat) → 409 `order_mismatch`.
    for (const ids of [[a, b], [a, b, c, c], [a, b, "00000000-0000-4000-8000-000000000001"]]) {
      await expect(
        reorderItems(f.deps, f.A, f.HA, l.list.id, { itemIds: ids }),
      ).rejects.toMatchObject({ reason: "order_mismatch" });
    }
    // Un articol nou vine la sfârșit.
    const added = await addItem(f.deps, f.C, f.HA, l.list.id, { name: "d4" });
    expect(added.item.position).toBe(4);
    await updateItem(f.deps, f.A, f.HA, l.list.id, a, { checked: true });
    const copy = await copyList(f.deps, f.C, f.HA, l.list.id);
    expect(copy.list).toMatchObject({ name: "Ordine (copie)", shared: true, itemCount: 4, checkedCount: 0 });
    expect(names(copy.items)).toEqual(["c3", "a1", "Brânză", "d4"]);
    expect(copy.items.every((i) => !i.checked && i.match.status === "none")).toBe(true);
    await deleteItem(f.deps, f.A, f.HA, l.list.id, d4Id(added));
    expect((await getList(f.deps, f.A, f.HA, l.list.id)).items).toHaveLength(3);
    await expect(deleteItem(f.deps, f.A, f.HA, l.list.id, d4Id(added))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const archived = await updateList(f.deps, f.A, f.HA, l.list.id, { status: "archived" });
    expect(archived.status).toBe("archived");
    expect((await listLists(f.deps, f.A, f.HA, { status: "archived" })).map((x) => x.id)).toContain(
      l.list.id,
    );
    expect((await listLists(f.deps, f.A, f.HA, { status: "active" })).map((x) => x.id)).not.toContain(
      l.list.id,
    );
    // Ștergerea listei: auditată (comună), fără nume în audit.
    await deleteList(f.deps, f.A, f.HA, l.list.id);
    await expect(getList(f.deps, f.A, f.HA, l.list.id)).rejects.toBeInstanceOf(NotFoundError);
    const audit = await f.admin<{ action: string; metadata: unknown }[]>`
      select action, metadata from finet.audit_events
       where household_id = ${f.HA} and action = 'shopping_list.deleted'`;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("Ordine");
  });

  it("copia unei liste personale rămâne personală; id invalid = 404", async () => {
    const l = await createList(f.deps, f.C, f.HA, {
      name: "Personală",
      personal: true,
      items: [{ name: "x1" }],
    });
    const copy = await copyList(f.deps, f.C, f.HA, l.list.id, { name: "Copia mea" });
    expect(copy.list).toMatchObject({ name: "Copia mea", shared: false });
    const sharedCopy = await copyList(f.deps, f.C, f.HA, l.list.id, { personal: false });
    expect(sharedCopy.list.shared).toBe(true);
    await expect(getList(f.deps, f.A, f.HA, "nu-e-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      getList(f.deps, f.A, f.HA, "00000000-0000-4000-8000-000000000999"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("plafoanele: 300 de articole pe listă, 100 de liste vizibile; coduri fixe", async () => {
    const big = await createList(f.deps, f.A, f.HA, {
      name: "Plină",
      items: Array.from({ length: 300 }, (_, i) => ({ name: `produs ${i + 1}` })),
    });
    expect(big.list.itemCount).toBe(300);
    const err = await addItem(f.deps, f.A, f.HA, big.list.id, { name: "unul în plus" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).reason).toBe("shopping_item_limit");
    // Mesajul nu conține conținut.
    expect(String((err as Error).message)).not.toContain("produs");
    await expect(
      createList(f.deps, f.A, f.HA, {
        name: "Peste",
        items: Array.from({ length: 301 }, (_, i) => ({ name: `p ${i}` })),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    // Gospodăria B are propriul plafon (independent): umplem HB până la 100 de liste.
    const existing = (await listLists(f.deps, f.B, f.HB)).length;
    for (let i = existing; i < 100; i++) {
      await createList(f.deps, f.B, f.HB, { name: `L${i}` });
    }
    const limit = await createList(f.deps, f.B, f.HB, { name: "a 101-a" }).catch((e: unknown) => e);
    expect((limit as ConflictError).reason).toBe("shopping_list_limit");
    // HA nu e afectată.
    expect((await createList(f.deps, f.A, f.HA, { name: "Încă una" })).list.shared).toBe(true);
  });

  it("sugestiile: produse cumpărate des, doar nume normalizate, doar din gospodăria proprie", async () => {
    await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE ZUZU 1,5% 1L"], ["PAINE FELIATA 500G"]]);
    await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE ZUZU 1,5% 1L"], ["LAMAIE"]]);
    await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE NESALVAT"]], { status: "needs_review" });
    await seedReceipt(f.admin, f.HB, f.B.userId, [["LAPTE DE LA ALTII"]]);
    const all = await suggestProducts(f.deps, f.A, f.HA);
    expect(all[0]).toEqual({ name: "lapte zuzu 1.5% 1l", count: 2 });
    expect(all.map((s) => s.name)).not.toContain("lapte nesalvat");
    expect(all.map((s) => s.name)).not.toContain("lapte de la altii");
    expect((await suggestProducts(f.deps, f.A, f.HA, { q: "LAP" })).map((s) => s.name)).toEqual([
      "lapte zuzu 1.5% 1l",
    ]);
    expect(await suggestProducts(f.deps, f.A, f.HA, { q: "!!!" })).toEqual([]);
    // `%` și `_` din căutare nu sunt metacaractere.
    expect(await suggestProducts(f.deps, f.A, f.HA, { q: "%" })).toEqual([]);
    await expect(suggestProducts(f.deps, f.A, f.HA, { q: "a", x: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

/** Id-ul articolului întors de `addItem`. */
function d4Id(r: { item: { id: string } }): string {
  return r.item.id;
}

describe.skipIf(!TEST_ADMIN_URL)("comparația listă ↔ bon (Postgres real, finet_app)", () => {
  let f: FamilyFixture;

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_cmp");
  });
  afterAll(async () => {
    await f?.close();
  });

  const lines = [
    ["LAPTE ZUZU 1,5% 1L"],
    ["PAINE FELIATA 500G"],
    ["SAMPON HAIR 400ML"],
    ["GARANTIE SGR", "deposit_sgr"],
    ["PUNGA RAFIE", "bag"],
  ] as const;

  it("potrivite, neplanificate și uitate; confirmare/respingere/corecție; reluarea păstrează deciziile", async () => {
    const list = await createList(f.deps, f.A, f.HA, {
      name: "Săptămâna",
      items: [{ name: "lapte" }, { name: "pâine" }, { name: "ouă" }, { name: "cafea" }],
    });
    const [lapte, paine, oua, cafea] = list.items.map((i) => i.id) as [string, string, string, string];
    await updateItem(f.deps, f.A, f.HA, list.list.id, oua, { checked: true });
    const rc = await seedReceipt(f.admin, f.HA, f.A.userId, lines);

    const run = await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc.id });
    expect(run.shared).toBe(true);
    expect(run.view.matched.map((m) => [m.item.name, m.line.name, m.status, m.uncertain])).toEqual([
      ["lapte", "LAPTE ZUZU 1,5% 1L", "suggested", false],
      ["pâine", "PAINE FELIATA 500G", "suggested", false],
    ]);
    expect(run.view.matched.every((m) => (m.score ?? 0) >= MATCH_HIGH && m.source === "code")).toBe(true);
    // Neplanificat: șamponul (pe bon, nu pe listă); SGR și punga nu sunt „produse”.
    expect(run.view.unplanned.map((l) => l.name)).toEqual(["SAMPON HAIR 400ML"]);
    expect(run.view.forgotten.map((i) => i.name)).toEqual(["cafea"]);
    expect(run.view.checkedMissing.map((i) => i.name)).toEqual(["ouă"]);
    expect(run.view.boughtElsewhere).toEqual([]);
    expect(run.view.ai.status).toBe("none");
    expect(run.view.lines.map((l) => l.name)).toEqual([
      "LAPTE ZUZU 1,5% 1L",
      "PAINE FELIATA 500G",
      "SAMPON HAIR 400ML",
    ]);

    // Idempotentă: a doua rulare dă aceeași stare.
    const second = await runComparison(f.deps, f.C, f.HA, list.list.id, { receiptId: rc.id });
    expect(second.view.matched).toEqual(run.view.matched);
    expect((await getComparison(f.deps, f.C, f.HA, list.list.id, rc.id)).view).toEqual(second.view);

    // Confirmă laptele; respinge pâinea; leagă manual cafeaua de șampon (corecție).
    const confirmed = await setItemMatch(f.deps, f.A, f.HA, list.list.id, lapte, { action: "confirm" });
    expect(confirmed.item.match.status).toBe("confirmed");
    await setItemMatch(f.deps, f.A, f.HA, list.list.id, paine, { action: "reject" });
    const manual = await setItemMatch(f.deps, f.A, f.HA, list.list.id, cafea, {
      action: "set",
      receiptLineId: rc.lineIds[2]!,
    });
    expect(manual.item.match).toMatchObject({ status: "confirmed", source: "manual", score: 100 });

    // Reluarea: confirmarea, respingerea și corecția rămân; nimic nou nu se propune pentru ele.
    const again = await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc.id });
    expect(again.view.matched.map((m) => [m.item.name, m.status, m.source])).toEqual([
      ["lapte", "confirmed", "code"],
      ["cafea", "confirmed", "manual"],
    ]);
    expect(again.view.unplanned.map((l) => l.name)).toEqual(["PAINE FELIATA 500G"]);
    expect(again.view.forgotten.map((i) => i.name)).toEqual(["pâine"]);
    const rejected = (await getList(f.deps, f.A, f.HA, list.list.id)).items.find((i) => i.id === paine)!;
    expect(rejected.match.status).toBe("rejected");

    // O linie confirmată pentru alt articol nu se poate lua.
    await expect(
      setItemMatch(f.deps, f.A, f.HA, list.list.id, oua, { action: "set", receiptLineId: rc.lineIds[2]! }),
    ).rejects.toMatchObject({ reason: "line_already_matched" });
    // Fără propunere nu e nimic de confirmat/respins.
    await expect(
      setItemMatch(f.deps, f.A, f.HA, list.list.id, oua, { action: "confirm" }),
    ).rejects.toMatchObject({ reason: "no_suggestion" });
    await expect(
      setItemMatch(f.deps, f.A, f.HA, list.list.id, oua, { action: "reject" }),
    ).rejects.toMatchObject({ reason: "no_suggestion" });
    // Linie a altui tip (SGR), inexistentă sau din altă gospodărie → 404.
    for (const lineId of [rc.lineIds[3]!, "00000000-0000-4000-8000-000000000999"]) {
      await expect(
        setItemMatch(f.deps, f.A, f.HA, list.list.id, oua, { action: "set", receiptLineId: lineId }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }

    // Un al doilea bon: laptele confirmat pe primul apare „cumpărat în altă parte”.
    const rc2 = await seedReceipt(f.admin, f.HA, f.A.userId, [["OUA M 10 BUC"], ["MERE GOLDEN 1KG"]]);
    const cmp2 = await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc2.id });
    expect(cmp2.view.matched.map((m) => [m.item.name, m.line.name])).toEqual([["ouă", "OUA M 10 BUC"]]);
    expect(cmp2.view.boughtElsewhere.map((i) => i.name)).toEqual(["lapte", "cafea"]);
    expect(cmp2.view.unplanned.map((l) => l.name)).toEqual(["MERE GOLDEN 1KG"]);

    // „Șterge potrivirea”.
    const cleared = await setItemMatch(f.deps, f.A, f.HA, list.list.id, oua, { action: "clear" });
    expect(cleared.item.match).toEqual({ status: "none", score: null, source: null, receiptLineId: null });
  });

  it("istoricul: o confirmare învață perechea; o respingere o oprește (alte liste, alte bonuri)", async () => {
    const rcA = await seedReceipt(f.admin, f.HA, f.A.userId, [["LACTATE PREMIUM 1L"]]);
    const l1 = await createList(f.deps, f.A, f.HA, { name: "Învățare 1", items: [{ name: "lapte praf" }] });
    // Fără istoric, „lapte praf” nu seamănă destul cu „lactate premium”.
    const before = await runComparison(f.deps, f.A, f.HA, l1.list.id, { receiptId: rcA.id });
    expect(before.view.matched).toEqual([]);
    await setItemMatch(f.deps, f.A, f.HA, l1.list.id, l1.items[0]!.id, {
      action: "set",
      receiptLineId: rcA.lineIds[0]!,
    });
    const rcB = await seedReceipt(f.admin, f.HA, f.A.userId, [["LACTATE PREMIUM 1L"]]);
    const l2 = await createList(f.deps, f.C, f.HA, { name: "Învățare 2", items: [{ name: "lapte praf" }] });
    const learned = await runComparison(f.deps, f.C, f.HA, l2.list.id, { receiptId: rcB.id });
    expect(learned.view.matched.map((m) => [m.source, m.score])).toEqual([["learned", 100]]);
    // Respingerea: perechea (lapte, lapte zuzu) nu se mai propune pe liste noi.
    const rcC = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE ZUZU 1,5% 1L"]]);
    const l3 = await createList(f.deps, f.A, f.HA, { name: "Respingere 1", items: [{ name: "lapte" }] });
    const first = await runComparison(f.deps, f.A, f.HA, l3.list.id, { receiptId: rcC.id });
    expect(first.view.matched).toHaveLength(1);
    await setItemMatch(f.deps, f.A, f.HA, l3.list.id, l3.items[0]!.id, { action: "reject" });
    const l4 = await createList(f.deps, f.A, f.HA, { name: "Respingere 2", items: [{ name: "lapte" }] });
    const second = await runComparison(f.deps, f.A, f.HA, l4.list.id, { receiptId: rcC.id });
    expect(second.view.matched).toEqual([]);
    expect(second.view.forgotten.map((i) => i.name)).toEqual(["lapte"]);
  });

  it("acces: bon neconfirmat → 409; bon/listă străine → 404; lista personală a altuia → 404", async () => {
    const list = await createList(f.deps, f.A, f.HA, { name: "Acces", items: [{ name: "lapte" }] });
    const draft = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE"]], { status: "needs_review" });
    await expect(
      runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: draft.id }),
    ).rejects.toMatchObject({ reason: "receipt_not_confirmed" });
    await expect(getComparison(f.deps, f.A, f.HA, list.list.id, draft.id)).rejects.toMatchObject({
      reason: "receipt_not_confirmed",
    });
    const foreign = await seedReceipt(f.admin, f.HB, f.B.userId, [["LAPTE"]]);
    await expect(
      runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: foreign.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const personal = await createList(f.deps, f.C, f.HA, {
      name: "Personală C",
      personal: true,
      items: [{ name: "lapte" }],
    });
    const ok = await seedReceipt(f.admin, f.HA, f.A.userId, [["LAPTE"]]);
    await expect(
      runComparison(f.deps, f.A, f.HA, personal.list.id, { receiptId: ok.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      setItemMatch(f.deps, f.A, f.HA, personal.list.id, personal.items[0]!.id, { action: "clear" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // Proprietarul o poate compara; evenimentul live ar merge doar la el (`shared: false`).
    const own = await runComparison(f.deps, f.C, f.HA, personal.list.id, { receiptId: ok.id });
    expect(own.shared).toBe(false);
    expect(own.view.matched).toHaveLength(1);
    await expect(
      runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: ok.id, listId: "x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const receipts = await listComparableReceipts(f.deps, f.A, f.HA);
    expect(receipts.map((r) => r.id)).toContain(ok.id);
    expect(receipts.map((r) => r.id)).not.toContain(draft.id);
    expect(receipts.map((r) => r.id)).not.toContain(foreign.id);
  });

  it("bonul șters: potrivirea rămâne fără linie și se arată ca „fără potrivire”", async () => {
    const rc = await seedReceipt(f.admin, f.HA, f.A.userId, [["BANANE"]]);
    const list = await createList(f.deps, f.A, f.HA, { name: "Bon șters", items: [{ name: "banane" }] });
    const cmp = await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc.id });
    expect(cmp.view.matched).toHaveLength(1);
    await setItemMatch(f.deps, f.A, f.HA, list.list.id, list.items[0]!.id, { action: "confirm" });
    await f.admin`delete from finet.receipts where id = ${rc.id}`;
    const after = await getList(f.deps, f.A, f.HA, list.list.id);
    expect(after.items[0]!.match).toEqual({ status: "none", score: null, source: null, receiptLineId: null });
    const [raw] = await f.admin<{ match_status: string; matched_receipt_line_id: string | null }[]>`
      select match_status, matched_receipt_line_id from finet.shopping_list_items
       where id = ${list.items[0]!.id}`;
    expect(raw).toEqual({ match_status: "confirmed", matched_receipt_line_id: null });
    // Redenumirea unui articol cu propunere o șterge; una confirmată rămâne.
    const rc2 = await seedReceipt(f.admin, f.HA, f.A.userId, [["BANANE"]]);
    const l2 = await createList(f.deps, f.A, f.HA, { name: "Redenumire", items: [{ name: "banane" }, { name: "mere" }] });
    await runComparison(f.deps, f.A, f.HA, l2.list.id, { receiptId: rc2.id });
    const renamed = await updateItem(f.deps, f.A, f.HA, l2.list.id, l2.items[0]!.id, { name: "portocale" });
    expect(renamed.item.match.status).toBe("none");
  });

  it("pasul AI: se pune în coadă doar pentru perechi ambigue ȘI cu consimțământ `external_ai`", async () => {
    // „lapte” într-o ciocolată cu lapte: pereche ambiguă (între praguri).
    const rc = await seedReceipt(f.admin, f.HA, f.A.userId, [["CIOCOLATA CU LAPTE 100G"]]);
    const list = await createList(f.deps, f.A, f.HA, { name: "AI", items: [{ name: "lapte" }] });
    const noConsent = await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc.id });
    expect(noConsent.view.matched[0]).toMatchObject({ uncertain: true, status: "suggested" });
    expect(noConsent.view.ai.status).toBe("none");
    await grantExternalAi(f.admin, f.A.userId);
    const withConsent = await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc.id });
    expect(withConsent.view.ai.status).toBe("queued");
    const [req] = await f.admin<{ status: string; requested_by_user_id: string; attempts: number }[]>`
      select status, requested_by_user_id, attempts from finet.shopping_list_ai_requests
       where list_id = ${list.list.id}`;
    expect(req).toEqual({ status: "queued", requested_by_user_id: f.A.userId, attempts: 0 });
    // O rulare repetată nu dublează cererea.
    await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc.id });
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.shopping_list_ai_requests where list_id = ${list.list.id}`;
    expect(n!.n).toBe(1);
    // Doi membri: C reîncearcă cât timp cererea lui A e activă → fără eroare RLS, fără schimbarea
    // solicitantului (A rămâne `requested_by`), răspuns fix.
    await grantExternalAi(f.admin, f.C.userId);
    const byC = await runComparison(f.deps, f.C, f.HA, list.list.id, { receiptId: rc.id });
    expect(byC.view.ai.status).toBe("queued");
    const [still] = await f.admin<{ status: string; requested_by_user_id: string }[]>`
      select status, requested_by_user_id from finet.shopping_list_ai_requests
       where list_id = ${list.list.id}`;
    expect(still).toEqual({ status: "queued", requested_by_user_id: f.A.userId });
    // În lucru (`processing`): la fel.
    await f.admin`update finet.shopping_list_ai_requests set status = 'processing' where list_id = ${list.list.id}`;
    expect((await runComparison(f.deps, f.C, f.HA, list.list.id, { receiptId: rc.id })).view.ai.status).toBe("processing");
    // Terminată: C o poate pune din nou în coadă, în numele lui, cu încercările la 0.
    await f.admin`update finet.shopping_list_ai_requests set status = 'failed', attempts = 3, error_code = 'timeout' where list_id = ${list.list.id}`;
    expect((await runComparison(f.deps, f.C, f.HA, list.list.id, { receiptId: rc.id })).view.ai.status).toBe("queued");
    const [requeued] = await f.admin<{ status: string; requested_by_user_id: string; attempts: number; error_code: string | null }[]>`
      select status, requested_by_user_id, attempts, error_code from finet.shopping_list_ai_requests
       where list_id = ${list.list.id}`;
    expect(requeued).toEqual({ status: "queued", requested_by_user_id: f.C.userId, attempts: 0, error_code: null });
    // Fără perechi ambigue (potrivire sigură) nu se pune nimic în coadă.
    const rc2 = await seedReceipt(f.admin, f.HA, f.A.userId, [["PAINE FELIATA 500G"]]);
    const l2 = await createList(f.deps, f.A, f.HA, { name: "AI sigur", items: [{ name: "pâine" }] });
    const sure = await runComparison(f.deps, f.A, f.HA, l2.list.id, { receiptId: rc2.id });
    expect(sure.view.ai.status).toBe("none");
  });
});
