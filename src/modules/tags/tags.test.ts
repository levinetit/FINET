import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type LedgerFixture, createLedgerFixture } from "@/modules/ledger/testing";
import {
  createTransaction,
  listTransactions,
  updateTransaction,
} from "@/modules/transactions/transactions.service";
import { createTransfer } from "@/modules/transfers/transfers.service";

import {
  createTag,
  deleteTag,
  getTag,
  getTransactionTagIds,
  listTags,
  setTransactionTags,
  updateTag,
} from "./tags.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe.skipIf(!TEST_ADMIN_URL)("etichete (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let accA: string;
  let accA2: string;
  let accB: string;
  const day = "2026-10-15";

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_tags");
    accA = (await createAccount(f.deps, f.A, f.HA, { name: "A", type: "bank", currency: "RON" }))
      .id;
    accA2 = (await createAccount(f.deps, f.A, f.HA, { name: "A2", type: "cash", currency: "RON" }))
      .id;
    accB = (await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" }))
      .id;
  });
  afterAll(async () => {
    await f?.close();
  });

  const expense = (extra: Record<string, unknown> = {}) =>
    createTransaction(f.deps, f.A, f.HA, {
      accountId: accA,
      type: "expense",
      amountMinor: 100,
      occurredOn: day,
      ...extra,
    });
  const systemTag = async (key: string) =>
    (await listTags(f.deps, f.A, f.HA, { includeHidden: true })).find((t) => t.systemKey === key)!
      .id;

  it("lista: cele 5 de sistem întâi, apoi cele proprii; numele unic și față de cele de sistem", async () => {
    const before = await listTags(f.deps, f.A, f.HA);
    expect(before.map((t) => t.name)).toEqual([
      "Personal",
      "Familie",
      "Copii",
      "Deductibil",
      "Cadou",
    ]);
    expect(before.every((t) => t.isSystem && t.usageCount === 0)).toBe(true);
    const own = await createTag(f.deps, f.A, f.HA, { name: "  Vacanța   2027 ", color: "#AABBCC" });
    expect(own).toMatchObject({ name: "Vacanța 2027", color: "#aabbcc", isSystem: false });
    await expect(createTag(f.deps, f.A, f.HA, { name: "vacanța 2027" })).rejects.toMatchObject({
      reason: "tag_name_taken",
    });
    await expect(createTag(f.deps, f.A, f.HA, { name: "CADOU" })).rejects.toMatchObject({
      reason: "tag_name_taken",
    });
    // Altă gospodărie poate folosi același nume.
    await createTag(f.deps, f.B, f.HB, { name: "Vacanța 2027" });
    await expect(
      createTag(f.deps, f.A, f.HA, { name: "X", householdId: f.HB }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(createTag(f.deps, f.A, f.HA, { name: "x".repeat(41) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("izolare: A nu vede, nu modifică și nu șterge eticheta lui B (404); C (member) o vede pe a lui A", async () => {
    const tagB = await createTag(f.deps, f.B, f.HB, { name: "Doar B" });
    await expect(getTag(f.deps, f.A, f.HA, tagB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getTag(f.deps, f.A, f.HB, tagB.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateTag(f.deps, f.A, f.HA, tagB.id, { name: "Furat" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(deleteTag(f.deps, f.A, f.HA, tagB.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listTags(f.deps, f.A, f.HA)).map((t) => t.name)).not.toContain("Doar B");
    const tagA = await createTag(f.deps, f.A, f.HA, { name: "Comun" });
    expect((await getTag(f.deps, f.C, f.HA, tagA.id)).name).toBe("Comun");
    // Pe tranzacția lui A, eticheta lui B → 404, iar tranzacția NU se creează.
    const before = (await listTransactions(f.deps, f.A, f.HA, { limit: 100 })).data.length;
    await expect(expense({ tagIds: [tagB.id] })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listTransactions(f.deps, f.A, f.HA, { limit: 100 })).data.length).toBe(before);
    // Tranzacția lui B nu primește etichete de la A.
    const txB = await createTransaction(f.deps, f.B, f.HB, {
      accountId: accB,
      type: "expense",
      amountMinor: 1,
      occurredOn: day,
    });
    await expect(setTransactionTags(f.deps, f.A, f.HA, txB.id, [tagA.id])).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("etichetele de sistem: doar ascundere, per gospodărie; nu se șterg", async () => {
    const gift = await systemTag("gift");
    await expect(updateTag(f.deps, f.A, f.HA, gift, { name: "Dar" })).rejects.toMatchObject({
      reason: "system_tag",
    });
    await expect(deleteTag(f.deps, f.A, f.HA, gift)).rejects.toMatchObject({
      reason: "system_tag",
    });
    const hidden = await updateTag(f.deps, f.A, f.HA, gift, { hidden: true });
    expect(hidden.hidden).toBe(true);
    expect((await listTags(f.deps, f.A, f.HA)).map((t) => t.systemKey)).not.toContain("gift");
    expect((await listTags(f.deps, f.B, f.HB)).map((t) => t.systemKey)).toContain("gift");
    // O etichetă ascunsă rămâne utilizabilă pe tranzacții.
    const t = await expense({ tagIds: [gift] });
    expect(await getTransactionTagIds(f.deps, f.A, f.HA, t.id)).toEqual([gift]);
    await updateTag(f.deps, f.A, f.HA, gift, { hidden: false });
  });

  it("tagIds la creare și modificare: validare (max 10, distincte), înlocuire, ștergere", async () => {
    const own = await Promise.all(
      Array.from({ length: 11 }, (_, i) => createTag(f.deps, f.A, f.HA, { name: `E${i}` })),
    );
    const ids = own.map((t) => t.id);
    await expect(expense({ tagIds: ids })).rejects.toBeInstanceOf(ValidationError);
    await expect(expense({ tagIds: [ids[0], ids[0]] })).rejects.toBeInstanceOf(ValidationError);
    await expect(expense({ tagIds: ["nu-e-uuid"] })).rejects.toBeInstanceOf(ValidationError);
    const t = await expense({ tagIds: ids.slice(0, 3) });
    expect(await getTransactionTagIds(f.deps, f.A, f.HA, t.id)).toEqual(
      [...ids.slice(0, 3)].sort(),
    );
    await updateTransaction(f.deps, f.A, f.HA, t.id, { tagIds: [ids[5]!] });
    expect(await getTransactionTagIds(f.deps, f.A, f.HA, t.id)).toEqual([ids[5]]);
    // Modificarea fără `tagIds` păstrează etichetele.
    await updateTransaction(f.deps, f.A, f.HA, t.id, { notes: "x" });
    expect(await getTransactionTagIds(f.deps, f.A, f.HA, t.id)).toEqual([ids[5]]);
    expect(await setTransactionTags(f.deps, f.A, f.HA, t.id, [])).toEqual([]);
    // Ștergerea etichetei scoate legăturile; auditul nu conține numele.
    await setTransactionTags(f.deps, f.A, f.HA, t.id, [ids[6]!, ids[7]!]);
    expect((await getTag(f.deps, f.A, f.HA, ids[6]!)).usageCount).toBe(1);
    await deleteTag(f.deps, f.A, f.HA, ids[6]!);
    expect(await getTransactionTagIds(f.deps, f.A, f.HA, t.id)).toEqual([ids[7]]);
    await expect(getTag(f.deps, f.A, f.HA, ids[6]!)).rejects.toBeInstanceOf(NotFoundError);
    const [audit] = await f.admin<{ action: string; metadata: unknown }[]>`
      select action, metadata from finet.audit_events
       where action = 'tag.deleted' and target_id = ${ids[6]!}`;
    expect(audit).toEqual({ action: "tag.deleted", metadata: { usageCount: 1 } });
  });

  it("transferurile nu au etichete (409)", async () => {
    const tr = await createTransfer(f.deps, f.A, f.HA, {
      fromAccountId: accA,
      toAccountId: accA2,
      amountMinor: 5,
      occurredOn: day,
    });
    const tag = await createTag(f.deps, f.A, f.HA, { name: "T-transfer" });
    await expect(
      setTransactionTags(f.deps, f.A, f.HA, tr.from.transactionId, [tag.id]),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("filtrul tagIds (OR, fără dubluri, paginare stabilă) și filtrul comerciant", async () => {
    const red = await createTag(f.deps, f.A, f.HA, { name: "Roșu" });
    const blue = await createTag(f.deps, f.A, f.HA, { name: "Albastru" });
    const both: string[] = [];
    for (let i = 0; i < 5; i++) {
      both.push(
        (
          await expense({
            tagIds: [red.id, blue.id],
            merchant: `Lidl ${i}`,
            occurredOn: "2026-09-01",
          })
        ).id,
      );
    }
    const onlyRed = (await expense({ tagIds: [red.id], merchant: "Kaufland" })).id;
    await expense({ merchant: "Lidl fără etichetă" });

    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listTransactions(f.deps, f.A, f.HA, {
        tagIds: [red.id, blue.id],
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...page.data.map((t) => t.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toHaveLength(6);
    expect(new Set(all)).toEqual(new Set([...both, onlyRed]));

    const blueOnly = await listTransactions(f.deps, f.A, f.HA, { tagIds: [blue.id] });
    expect(new Set(blueOnly.data.map((t) => t.id))).toEqual(new Set(both));
    const lidl = await listTransactions(f.deps, f.A, f.HA, { merchant: "lidl", tagIds: [red.id] });
    expect(lidl.data).toHaveLength(5);
    const pct = await listTransactions(f.deps, f.A, f.HA, { merchant: "100%" });
    expect(pct.data).toHaveLength(0);
    // Filtrul cu eticheta altei gospodării: nimic (nu eroare, nu date străine).
    const tagB = await createTag(f.deps, f.B, f.HB, { name: "Roșu" });
    expect((await listTransactions(f.deps, f.A, f.HA, { tagIds: [tagB.id] })).data).toHaveLength(0);
    await expect(listTransactions(f.deps, f.A, f.HA, { tagIds: [] })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
