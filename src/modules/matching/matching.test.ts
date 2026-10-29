import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import {
  acceptRecurringSuggestion,
  dismissRecurringSuggestion,
  listRecurringSuggestions,
} from "@/modules/recurring/suggestions.service";

import { decideReceiptMatch, getReceiptMatches, listMatchQueue } from "./matching.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Potrivirea bon ↔ tranzacție și propunerile de plăți recurente pe PostgreSQL real, ca
 * `finet_app` (ADR 0019): pozitiv, negativ, ambiguu; confirmarea nu creează duplicat (și elimină
 * tranzacția bonului deja salvat); respingerea se memorează; tranzacțiile din contul PERSONAL al
 * altui membru nu apar și nu se pot lega; altă gospodărie = 404.
 */
describe.skipIf(!TEST_ADMIN_URL)("potrivirea bonurilor și propunerile (Postgres real)", () => {
  let f: FamilyFixture;
  let common: string;
  let personalC: string;
  const now = () => new Date("2026-11-20T10:00:00Z");
  const deps = () => ({ db: f.db, now });

  const stmtTx = async (account: string, amount: number, on: string, description: string) => {
    const id = randomUUID();
    await f.admin`insert into finet.transactions (id, household_id, account_id, type, amount_minor,
        currency, occurred_on, description, source, external_ref, created_by_user_id)
      values (${id}, ${f.HA}, ${account}, 'expense', ${amount}, 'RON', ${on}, ${description},
        'statement', ${`stmt:${createHash("sha256").update(id).digest("hex")}`}, ${f.A.userId})`;
    return id;
  };
  const receipt = async (
    over: {
      total?: number;
      on?: string;
      merchant?: string;
      cui?: string | null;
      uploader?: string;
    } = {},
  ) => {
    const doc = randomUUID();
    await f.admin`insert into finet.documents (id, household_id, kind, status, detected_mime,
        size_bytes, sha256, storage_key, uploaded_by_user_id)
      values (${doc}, ${f.HA}, 'receipt', 'needs_review', 'image/jpeg', 10,
        ${createHash("sha256").update(doc).digest("hex")}, ${`households/${f.HA}/documents/${doc}`},
        ${over.uploader ?? f.A.userId})`;
    const id = randomUUID();
    await f.admin`insert into finet.receipts (id, household_id, document_id, status, total_minor,
        occurred_on, merchant_name, merchant_tax_id)
      values (${id}, ${f.HA}, ${doc}, 'needs_review', ${over.total ?? 8714}, ${over.on ?? "2026-11-02"},
        ${over.merchant ?? "KAUFLAND ROMANIA"}, ${over.cui === undefined ? "RO15991149" : over.cui})`;
    return id;
  };
  const count = async (account: string) => {
    const [r] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where account_id = ${account}`;
    return r!.n;
  };

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_match");
    common = (
      await createAccount({ db: f.db }, f.A, f.HA, { name: "Comun", type: "bank", currency: "RON" })
    ).id;
    personalC = (
      await createAccount({ db: f.db }, f.C, f.HA, {
        name: "Personal C",
        type: "bank",
        currency: "RON",
        ownerUserId: f.C.userId,
      })
    ).id;
  });
  afterAll(async () => {
    await f?.close();
  });

  it("pozitiv: candidatul din extras cu scor și motive; confirmarea leagă bonul FĂRĂ tranzacție nouă", async () => {
    const t = await stmtTx(common, 8714, "2026-11-03", "EPOS 02/11/2026 KAUFLAND RO");
    const r = await receipt();
    const m = await getReceiptMatches(deps(), f.A, f.HA, r);
    expect(m!.candidates).toHaveLength(1);
    expect(m!.candidates[0]).toMatchObject({
      transactionId: t,
      probable: true,
      reasons: ["amount_exact", "date_diff_1", "merchant_partial"],
    });
    expect(m!.ambiguous).toBe(false);
    expect((await listMatchQueue(deps(), f.A, f.HA)).map((q) => q.receiptId)).toContain(r);
    const before = await count(common);
    const done = await decideReceiptMatch(deps(), f.A, f.HA, r, {
      transactionId: t,
      decision: "confirm",
    });
    expect(done).toMatchObject({ decision: "confirm", removedTransactionId: null });
    expect(await count(common)).toBe(before);
    const [row] = await f.admin<{ status: string; tx: string }[]>`
      select status, transaction_id as tx from finet.receipts where id = ${r}`;
    expect(row).toEqual({ status: "saved", tx: t });
    // Idempotent; tranzacția legată nu mai e candidată pentru alt bon.
    await decideReceiptMatch(deps(), f.A, f.HA, r, { transactionId: t, decision: "confirm" });
    const other = await receipt();
    expect((await getReceiptMatches(deps(), f.A, f.HA, other))!.candidates).toHaveLength(0);
  });

  it("negativ: suma diferită cu un ban sau la 4 zile → niciun candidat; un id ghicit → 404", async () => {
    const t1 = await stmtTx(common, 1234, "2026-11-10", "LIDL");
    const t2 = await stmtTx(common, 1235, "2026-11-11", "LIDL");
    const r = await receipt({
      total: 1235,
      on: "2026-11-15",
      merchant: "LIDL DISCOUNT",
      cui: null,
    });
    expect((await getReceiptMatches(deps(), f.A, f.HA, r))!.candidates).toEqual([]);
    for (const id of [t1, t2, randomUUID()]) {
      await expect(
        decideReceiptMatch(deps(), f.A, f.HA, r, { transactionId: id, decision: "confirm" }),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it("ambiguu: doi candidați apropiați sunt marcați; respingerea se memorează și nu se mai propune", async () => {
    const a = await stmtTx(common, 5500, "2026-11-12", "Plata POS");
    const b = await stmtTx(common, 5500, "2026-11-12", "Plata POS");
    const r = await receipt({ total: 5500, on: "2026-11-12", merchant: "MAGAZIN X", cui: null });
    const m = await getReceiptMatches(deps(), f.A, f.HA, r);
    expect(m!.ambiguous).toBe(true);
    expect(m!.candidates.map((c) => c.transactionId).sort()).toEqual([a, b].sort());
    await decideReceiptMatch(deps(), f.A, f.HA, r, { transactionId: a, decision: "reject" });
    // Idempotent.
    await decideReceiptMatch(deps(), f.A, f.HA, r, { transactionId: a, decision: "reject" });
    const after = await getReceiptMatches(deps(), f.A, f.HA, r);
    expect(after!.candidates.map((c) => c.transactionId)).toEqual([b]);
    expect(after!.ambiguous).toBe(false);
  });

  it("bon deja salvat cu tranzacția lui: confirmarea mută legătura și ȘTERGE duplicatul (o singură tranzacție)", async () => {
    const r = await receipt({
      total: 3300,
      on: "2026-11-14",
      merchant: "Farmacia Exemplu",
      cui: null,
    });
    const own = randomUUID();
    await f.admin`insert into finet.transactions (id, household_id, account_id, type, amount_minor,
        currency, occurred_on, description, source, created_by_user_id)
      values (${own}, ${f.HA}, ${common}, 'expense', 3300, 'RON', '2026-11-14', 'Farmacia Exemplu',
        'receipt', ${f.A.userId})`;
    await f.admin`update finet.receipts set status = 'saved', transaction_id = ${own} where id = ${r}`;
    const t = await stmtTx(common, 3300, "2026-11-15", "FARMACIA EXEMPLU");
    const before = await count(common);
    const done = await decideReceiptMatch(deps(), f.A, f.HA, r, {
      transactionId: t,
      decision: "confirm",
    });
    expect(done.removedTransactionId).toBe(own);
    expect(await count(common)).toBe(before - 1);
    const [row] = await f.admin<{ tx: string }[]>`
      select transaction_id as tx from finet.receipts where id = ${r}`;
    expect(row!.tx).toBe(t);
  });

  it("contul PERSONAL al altui membru: tranzacția lui nu apare la A și nu se poate lega; C o vede", async () => {
    const t = await stmtTx(personalC, 7777, "2026-11-16", "KAUFLAND");
    const r = await receipt({ total: 7777, on: "2026-11-16" });
    expect((await getReceiptMatches(deps(), f.A, f.HA, r))!.candidates).toEqual([]);
    expect((await listMatchQueue(deps(), f.A, f.HA)).map((q) => q.receiptId)).not.toContain(r);
    await expect(
      decideReceiptMatch(deps(), f.A, f.HA, r, { transactionId: t, decision: "confirm" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      decideReceiptMatch(deps(), f.A, f.HA, r, { transactionId: t, decision: "reject" }),
    ).rejects.toMatchObject({ status: 404 });
    // m3 (revizuirea F7-B): nici proprietarul contului personal nu leagă de el bonul încărcat de
    // A (bonul e al gospodăriei, tranzacția ar rămâne invizibilă celorlalți) → conflict explicit.
    expect((await getReceiptMatches(deps(), f.C, f.HA, r))!.candidates).toEqual([]);
    await expect(
      decideReceiptMatch(deps(), f.C, f.HA, r, { transactionId: t, decision: "confirm" }),
    ).rejects.toMatchObject({ reason: "receipt_match_personal_account" });
    // Bonul încărcat de C se poate lega de tranzacția din contul personal al lui C.
    const own = await receipt({ total: 7777, on: "2026-11-16", uploader: f.C.userId });
    expect(
      (await getReceiptMatches(deps(), f.C, f.HA, own))!.candidates.map((c) => c.transactionId),
    ).toEqual([t]);
    await decideReceiptMatch(deps(), f.C, f.HA, own, { transactionId: t, decision: "confirm" });
    // Altă gospodărie: bonul nu există.
    await expect(getReceiptMatches(deps(), f.B, f.HB, r)).rejects.toMatchObject({ status: 404 });
  });

  it("propuneri: lunar detectat; contul personal al altuia nu contribuie; acceptarea creează regula; respingerea o ascunde", async () => {
    for (const d of ["2026-08-07", "2026-09-07", "2026-10-07", "2026-11-07"]) {
      await stmtTx(common, 4999, d, "NETFLIX.COM Amsterdam");
      await stmtTx(personalC, 3999, d, "SPOTIFY Stockholm");
    }
    const listA = await listRecurringSuggestions(deps(), f.A, f.HA);
    const netflix = listA.find((s) => s.description.startsWith("NETFLIX"));
    expect(netflix).toMatchObject({
      frequency: "monthly",
      amountMinor: 4999n,
      nextOn: "2026-12-07",
    });
    expect(listA.some((s) => s.description.startsWith("SPOTIFY"))).toBe(false);
    const listC = await listRecurringSuggestions(deps(), f.C, f.HA);
    const spotify = listC.find((s) => s.description.startsWith("SPOTIFY"))!;
    expect(spotify.accountId).toBe(personalC);
    // A nu poate accepta/respinge propunerea lui C (nu o vede).
    await expect(
      acceptRecurringSuggestion(deps(), f.A, f.HA, spotify.signature),
    ).rejects.toMatchObject({ status: 404 });
    const rule = await acceptRecurringSuggestion(deps(), f.A, f.HA, netflix!.signature);
    expect(rule).toMatchObject({ accountId: common, frequency: "monthly", startOn: "2026-12-07" });
    expect(
      (await listRecurringSuggestions(deps(), f.A, f.HA)).some(
        (s) => s.signature === netflix!.signature,
      ),
    ).toBe(false);
    await dismissRecurringSuggestion(deps(), f.C, f.HA, spotify.signature);
    await dismissRecurringSuggestion(deps(), f.C, f.HA, spotify.signature);
    expect(
      (await listRecurringSuggestions(deps(), f.C, f.HA)).some(
        (s) => s.signature === spotify.signature,
      ),
    ).toBe(false);
    await expect(
      dismissRecurringSuggestion(deps(), f.A, f.HA, "z".repeat(64)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("acceptarea simultană a aceleiași propuneri (fără Idempotency-Key) creează O SINGURĂ regulă", async () => {
    for (const d of ["2026-08-09", "2026-09-09", "2026-10-09", "2026-11-09"]) {
      await stmtTx(common, 3333, d, "CINEMAEXEMPLU Abonament");
    }
    const s = (await listRecurringSuggestions(deps(), f.A, f.HA)).find((x) =>
      x.description.startsWith("CINEMAEXEMPLU"),
    )!;
    expect(s).toBeTruthy();
    const results = await Promise.allSettled([
      acceptRecurringSuggestion(deps(), f.A, f.HA, s.signature),
      acceptRecurringSuggestion(deps(), f.C, f.HA, s.signature),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 404 });
    const [n] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.recurring_rules
       where account_id = ${common} and description like 'CINEMAEXEMPLU%'`;
    expect(n!.n).toBe(1);
  });

  it("m3: o tranzacție din contul PERSONAL al lui A nu șterge tranzacția comună a bonului salvat de B", async () => {
    const personalA = (
      await createAccount({ db: f.db }, f.A, f.HA, {
        name: "Personal A",
        type: "bank",
        currency: "RON",
        ownerUserId: f.A.userId,
      })
    ).id;
    const r = await receipt({
      total: 4321,
      on: "2026-11-17",
      merchant: "Librarie",
      cui: null,
      uploader: f.C.userId,
    });
    const own = randomUUID();
    await f.admin`insert into finet.transactions (id, household_id, account_id, type, amount_minor,
        currency, occurred_on, description, source, created_by_user_id)
      values (${own}, ${f.HA}, ${common}, 'expense', 4321, 'RON', '2026-11-17', 'Librarie',
        'receipt', ${f.C.userId})`;
    await f.admin`update finet.receipts set status = 'saved', transaction_id = ${own} where id = ${r}`;
    const t = await stmtTx(personalA, 4321, "2026-11-17", "LIBRARIE");
    expect((await getReceiptMatches(deps(), f.A, f.HA, r))!.candidates).toEqual([]);
    await expect(
      decideReceiptMatch(deps(), f.A, f.HA, r, { transactionId: t, decision: "confirm" }),
    ).rejects.toMatchObject({ reason: "receipt_match_personal_account" });
    const [still] = await f.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where id = ${own}`;
    expect(still!.n).toBe(1);
  });
});
