import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { LocalStorage } from "@/lib/storage";
import { type AuthFixture, authEnv, createAuthFixture, testConfig } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { multipartRequest, receiptLikeImage } from "@/modules/documents/testing";
import { systemCategoryId } from "@/modules/ledger/testing";

import * as D from "./_lib/documents-handlers";
import type { DocumentsApiDeps } from "./_lib/documents-handlers";
import * as L from "./_lib/ledger-handlers";
import * as M from "./_lib/me-handlers";
import * as RC from "./_lib/receipts-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Acceptarea F6-C prin API (handlere reale, PostgreSQL real, aplicația ca `finet_app`, storage local
 * temporar): documentele (listă, stare, fișierul în flux cu antete fixe, ștergere), contorul zilei,
 * bonurile (listă cu filtre și căutare după sumă „45,90”/„45.90”, detaliu, corectare cu
 * recalcularea verificărilor și învățarea alias-ului, confirmare → tranzacție `source=receipt`,
 * duplicat, reprocesare care consumă limita, ștergere), consimțământul `externalAi` care pune
 * documentele în coadă, izolarea între gospodării (404) și contractul OpenAPI pe fiecare răspuns.
 * Bonurile sunt scrise direct în bază (ca de worker), fără niciun apel AI.
 */

type Handler = (request: Request, deps: DocumentsApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;
type Receipt = {
  id: string;
  status: string;
  totalMinor: number | null;
  issues: { code: string }[];
  confidence: number | null;
  transactionId: string | null;
  duplicateOfReceiptId: string | null;
  linesSumMinor: number | null;
  categoryIds: string[];
  documentIds: string[];
  lines?: { id: string; rawName: string; categoryId: string | null; lineTotalMinor: number }[];
};

describe.skipIf(!TEST_ADMIN_URL)("API documente + bonuri (F6-C) pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: DocumentsApiDeps;
  let root: string;
  let A: Sessions;
  let B: Sessions;
  let accA: string;
  let accEur: string;
  let groceries: string;
  let restaurants: string;
  let keySeq = 0;
  const PASS = "parola-bonuri-12345";
  const newKey = () => `bonuri-cheie-${String(++keySeq).padStart(8, "0")}`;

  async function call(
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ): Promise<{ status: number; body: Body; res: Response }> {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      env,
      ...rest,
    );
    await assertContract(handler, res);
    if (res.headers.get("content-type")?.startsWith("application/json") ?? true) {
      const text = await res.clone().text();
      return { status: res.status, body: text ? (JSON.parse(text) as Body) : {}, res };
    }
    return { status: res.status, body: {}, res };
  }

  async function upload(s: Sessions, files: Buffer[], fields: [string, string][] = []) {
    const res = await D.uploadDocumentsHandler(
      await multipartRequest(
        [...fields, ...files.map((f, i) => ["files", f, `poza-${i}.jpg`] as const)],
        { authorization: `Bearer ${s.bearer}` },
      ),
      env,
    );
    await assertContract(D.uploadDocumentsHandler, res);
    return { status: res.status, body: await readJson(res) };
  }

  async function householdOf(email: string): Promise<string> {
    const [row] = await fx.scratch.admin<{ household_id: string }[]>`
      select m.household_id from finet.household_members m join finet.users u on u.id = m.user_id
       where u.email = ${email}`;
    return row!.household_id;
  }

  /** Un bon „extras” (ca de worker): 2 linii, total 45,90, CUI Lidl. */
  async function seedReceipt(
    hh: string,
    documentId: string,
    opts: { total?: bigint; lines?: [string, bigint, string | null][]; duplicateOf?: string } = {},
  ): Promise<string> {
    const total = opts.total ?? 4590n;
    const [r] = await fx.scratch.admin<{ id: string }[]>`
      insert into finet.receipts (household_id, document_id, merchant_name, merchant_tax_id,
        receipt_number, occurred_on, total_minor, currency, status, confidence, provider_used,
        fallback_reason, issues, duplicate_of_receipt_id)
      values (${hh}, ${documentId}, 'LIDL DISCOUNT SRL', 'RO22891860', '0142', '2026-10-12',
        ${total.toString()}, 'RON', 'needs_review', 60, 'external', 'no_local_model',
        ${fx.scratch.admin.json([{ code: "total_mismatch", field: "total" }])},
        ${opts.duplicateOf ?? null})
      returning id`;
    const lines = opts.lines ?? [
      ["LAPTE ZUZU 1L", 1498n, null],
      ["PAINE", 3092n, null],
    ];
    let pos = 1;
    for (const [name, amount, cat] of lines) {
      await fx.scratch.admin`
        insert into finet.receipt_lines (receipt_id, household_id, position, raw_name,
          normalized_name, line_total_minor, category_id, kind)
        values (${r!.id}, ${hh}, ${pos++}, ${name}, ${name.toLowerCase()}, ${amount.toString()},
          ${cat}, 'product')`;
    }
    await fx.scratch
      .admin`update finet.documents set status = 'needs_review' where id = ${documentId}`;
    return r!.id;
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_receipts_api");
    root = await realpath(await mkdtemp(join(tmpdir(), "finet-receipts-api-")));
    env = {
      ...authEnv(fx.db, {
        config: testConfig({ AI_DAILY_DOCUMENT_LIMIT: "8" }),
        now: () => Date.parse("2026-10-28T10:00:00Z"),
      }),
      storage: new LocalStorage(root),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        documentUpload: { max: 100_000, windowSeconds: 60 },
        receiptReprocess: { max: 100_000, windowSeconds: 60 },
      },
    };
    for (const [email, name] of [
      ["ana@exemplu.ro", "Ana"],
      ["bogdan@exemplu.ro", "Bogdan"],
    ] as const) {
      await createUserWithHousehold(fx.db, {
        email,
        name,
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
    }
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    const acc = async (currency: string) => {
      const r = await call(L.createAccountHandler, "/api/v1/accounts", {
        bearer: A.bearer,
        body: { name: `Card ${currency}`, type: "bank", currency },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return (r.body.data as { id: string }).id;
    };
    accA = await acc("RON");
    accEur = await acc("EUR");
    groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");
    restaurants = await systemCategoryId(fx.scratch.admin, "expense.restaurants");
  });
  afterAll(async () => {
    await fx?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("documentele: listă cu stare, detaliu, fișierul în flux (antete fixe), izolare 404", async () => {
    const jpg = await receiptLikeImage({ seed: 101 });
    const up = await upload(A, [jpg]);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const doc = (up.body.data as { documents: { id: string; status: string }[] }).documents[0]!;
    expect(doc.status).toBe("awaiting_consent");

    const list = await call(D.listDocumentsHandler, "/api/v1/documents", { bearer: A.bearer });
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string; receiptId: null }[])[0]).toMatchObject({
      id: doc.id,
      receiptId: null,
    });
    const one = await call(
      D.getDocumentHandler,
      `/api/v1/documents/${doc.id}`,
      { bearer: A.bearer },
      doc.id,
    );
    expect(one.status).toBe(200);

    const file = await call(
      D.documentFileHandler,
      `/api/v1/documents/${doc.id}/file`,
      { bearer: A.bearer },
      doc.id,
    );
    expect(file.status).toBe(200);
    expect(file.res.headers.get("content-type")).toBe("image/jpeg");
    expect(file.res.headers.get("content-disposition")).toBe(
      `attachment; filename="bon-${doc.id}.jpg"`,
    );
    expect(Buffer.from(await file.res.arrayBuffer()).equals(jpg)).toBe(true);

    // B nu vede nimic: 404 uniform pe detaliu și pe fișier, listă goală.
    for (const [h, path] of [
      [D.getDocumentHandler, `/api/v1/documents/${doc.id}`],
      [D.documentFileHandler, `/api/v1/documents/${doc.id}/file`],
    ] as const) {
      const r = await call(h, path, { bearer: B.bearer }, doc.id);
      expect(r.status).toBe(404);
    }
    const listB = await call(D.listDocumentsHandler, "/api/v1/documents", { bearer: B.bearer });
    expect(listB.body.data).toEqual([]);
    // Id invalid → 404; parametru necunoscut → 400.
    expect(
      (await call(D.getDocumentHandler, "/api/v1/documents/x", { bearer: A.bearer }, "x")).status,
    ).toBe(404);
    expect(
      (await call(D.listDocumentsHandler, "/api/v1/documents?x=1", { bearer: A.bearer })).status,
    ).toBe(400);
  });

  it("contorul zilei: X din Y, fără costuri", async () => {
    const r = await call(D.aiUsageHandler, "/api/v1/ai/usage", { bearer: A.bearer });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ used: 1, limit: 8, remaining: 7 });
  });

  it("un fișier de 11 MB ajunge întreg la handler și e refuzat de limita aplicației (413 file_too_large)", async () => {
    const big = Buffer.concat([
      await receiptLikeImage({ seed: 102 }),
      Buffer.alloc(11 * 1024 * 1024, 7),
    ]);
    const r = await upload(A, [big]);
    expect(r.status).toBe(413);
    expect(r.body.error?.code).toBe("file_too_large");
  });

  it("consimțământul externalAi pune în coadă documentele care îl așteptau", async () => {
    const hh = await householdOf("ana@exemplu.ro");
    const before = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.documents where household_id = ${hh} and status = 'awaiting_consent'`;
    expect(before[0]!.n).toBeGreaterThan(0);
    const put = await call(M.putConsentsHandler, "/api/v1/me/consents", {
      bearer: A.bearer,
      method: "PUT",
      body: { externalAi: true },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const after = await fx.scratch.admin<{ status: string }[]>`
      select status from finet.documents where household_id = ${hh}`;
    expect(after.every((d) => d.status === "queued")).toBe(true);
    // Retragerea nu schimbă documentele; workerul verifică din nou consimțământul.
    await call(M.putConsentsHandler, "/api/v1/me/consents", {
      bearer: A.bearer,
      method: "PUT",
      body: { externalAi: false },
    });
  });

  let receiptId: string;
  let docId: string;

  it("lista bonurilor: filtre, căutare după magazin/produs/sumă (45,90 și 45.90), izolare", async () => {
    const hh = await householdOf("ana@exemplu.ro");
    const up = await upload(A, [await receiptLikeImage({ seed: 103 })]);
    docId = (up.body.data as { documents: { id: string }[] }).documents[0]!.id;
    receiptId = await seedReceipt(hh, docId, {
      lines: [
        ["LAPTE ZUZU 1L", 1498n, groceries],
        ["PAINE", 3092n, null],
      ],
    });

    const q = async (query: string, s: Sessions = A) => {
      const r = await call(RC.listReceiptsHandler, `/api/v1/receipts${query}`, {
        bearer: s.bearer,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body.data as Receipt[]).map((x) => x.id);
    };
    expect(await q("")).toEqual([receiptId]);
    expect(await q("?q=45%2C90")).toEqual([receiptId]);
    expect(await q("?q=45.90")).toEqual([receiptId]);
    expect(await q("?q=14,98")).toEqual([receiptId]); // suma unei linii
    expect(await q("?q=lidl")).toEqual([receiptId]);
    expect(await q("?q=zuzu")).toEqual([receiptId]);
    expect(await q("?q=46,00")).toEqual([]);
    expect(await q("?q=%25")).toEqual([]); // `%` e caracter obișnuit (escape LIKE)
    expect(await q("?status=needs_review")).toEqual([receiptId]);
    expect(await q("?status=saved")).toEqual([]);
    expect(await q(`?categoryId=${groceries}`)).toEqual([receiptId]);
    expect(await q(`?categoryId=${restaurants}`)).toEqual([]);
    expect(await q("?dateFrom=2026-10-12&dateTo=2026-10-12")).toEqual([receiptId]);
    expect(await q("?amountMinMinor=4591")).toEqual([]);
    expect(await q("", B)).toEqual([]);
    const bad = await call(RC.listReceiptsHandler, "/api/v1/receipts?status=x", {
      bearer: A.bearer,
    });
    expect(bad.status).toBe(400);
    const inv = await call(
      RC.listReceiptsHandler,
      "/api/v1/receipts?dateFrom=2026-10-13&dateTo=2026-10-12",
      { bearer: A.bearer },
    );
    expect(inv.status).toBe(400);

    const detail = await call(
      RC.getReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      { bearer: A.bearer },
      receiptId,
    );
    expect(detail.status).toBe(200);
    const d = detail.body.data as Receipt;
    expect(d).toMatchObject({ totalMinor: 4590, linesSumMinor: 4590, documentIds: [docId] });
    expect(d.categoryIds).toEqual([groceries]);
    expect(
      (
        await call(
          RC.getReceiptHandler,
          `/api/v1/receipts/${receiptId}`,
          { bearer: B.bearer },
          receiptId,
        )
      ).status,
    ).toBe(404);
  });

  it("corectarea: Zod strict, verificările recalculate, alias-ul produsului învățat, B → 404", async () => {
    const detail = (
      await call(
        RC.getReceiptHandler,
        `/api/v1/receipts/${receiptId}`,
        { bearer: A.bearer },
        receiptId,
      )
    ).body.data as Receipt;
    const [l1, l2] = detail.lines!;
    const strict = await call(
      RC.patchReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      { bearer: A.bearer, method: "PATCH", body: { status: "saved" } },
      receiptId,
    );
    expect(strict.status).toBe(400);
    const badCui = await call(
      RC.patchReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      { bearer: A.bearer, method: "PATCH", body: { merchantTaxId: "abc" } },
      receiptId,
    );
    expect(badCui.status).toBe(400);

    const body = {
      lines: [
        {
          id: l1!.id,
          rawName: l1!.rawName,
          lineTotalMinor: 1498,
          kind: "product",
          categoryId: groceries,
        },
        {
          id: l2!.id,
          rawName: "PAINE ALBA",
          lineTotalMinor: 3092,
          kind: "product",
          categoryId: restaurants,
        },
      ],
    };
    const r = await call(
      RC.patchReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      { bearer: A.bearer, method: "PATCH", body },
      receiptId,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = r.body.data as Receipt;
    // Suma liniilor = total → `total_mismatch` dispare (recalculat în cod).
    expect(after.issues.map((i) => i.code)).not.toContain("total_mismatch");
    expect(after.lines!.map((l) => l.categoryId)).toEqual([groceries, restaurants]);
    const aliases = await fx.scratch.admin<{ normalized_name: string; category_id: string }[]>`
      select normalized_name, category_id from finet.product_aliases order by normalized_name`;
    expect(aliases).toEqual([{ normalized_name: "paine alba", category_id: restaurants }]);

    const foreign = await call(
      RC.patchReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      { bearer: B.bearer, method: "PATCH", body: { merchantName: "X" } },
      receiptId,
    );
    expect(foreign.status).toBe(404);
    // O linie a altui bon nu se poate „adopta” prin id.
    const alien = await call(
      RC.patchReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      {
        bearer: A.bearer,
        method: "PATCH",
        body: {
          lines: [
            {
              id: "7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f",
              rawName: "X",
              lineTotalMinor: 1,
              kind: "product",
            },
          ],
        },
      },
      receiptId,
    );
    expect(alien.status).toBe(400);
  });

  it("confirmarea: cont în altă monedă 409, apoi o tranzacție source=receipt; a doua 409; replay cu cheie", async () => {
    const url = `/api/v1/receipts/${receiptId}/confirm`;
    const eur = await call(
      RC.confirmReceiptHandler,
      url,
      { bearer: A.bearer, body: { accountId: accEur } },
      receiptId,
    );
    expect([eur.status, eur.body.error?.reason]).toEqual([409, "currency_mismatch"]);
    const strict = await call(
      RC.confirmReceiptHandler,
      url,
      { bearer: A.bearer, body: { accountId: accA, amountMinor: 1 } },
      receiptId,
    );
    expect(strict.status).toBe(400);

    const key = newKey();
    const ok = await call(
      RC.confirmReceiptHandler,
      url,
      { bearer: A.bearer, body: { accountId: accA }, headers: { "idempotency-key": key } },
      receiptId,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const { receipt, transactionId } = ok.body.data as { receipt: Receipt; transactionId: string };
    expect(receipt).toMatchObject({ status: "saved", transactionId });
    const replay = await call(
      RC.confirmReceiptHandler,
      url,
      { bearer: A.bearer, body: { accountId: accA }, headers: { "idempotency-key": key } },
      receiptId,
    );
    expect(replay.status).toBe(201);
    expect(replay.res.headers.get("idempotent-replay")).toBe("true");
    const again = await call(
      RC.confirmReceiptHandler,
      url,
      { bearer: A.bearer, body: { accountId: accA } },
      receiptId,
    );
    expect([again.status, again.body.error?.reason]).toEqual([409, "receipt_already_saved"]);

    const tx = await call(
      L.getTransactionHandler,
      `/api/v1/transactions/${transactionId}`,
      { bearer: A.bearer },
      transactionId,
    );
    // Categoria dominantă: PAINE ALBA (30,92 lei, restaurante) > LAPTE (14,98 lei).
    expect(tx.body.data).toMatchObject({
      type: "expense",
      amountMinor: 4590,
      source: "receipt",
      documentId: docId,
      categoryId: restaurants,
      occurredOn: "2026-10-12",
      merchant: "LIDL DISCOUNT SRL",
    });
    const patch = await call(
      RC.patchReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      { bearer: A.bearer, method: "PATCH", body: { merchantName: "Y" } },
      receiptId,
    );
    expect([patch.status, patch.body.error?.reason]).toEqual([409, "receipt_saved"]);
    const repro = await call(
      RC.reprocessReceiptHandler,
      `/api/v1/receipts/${receiptId}/reprocess`,
      { bearer: A.bearer, method: "POST" },
      receiptId,
    );
    expect([repro.status, repro.body.error?.reason]).toEqual([409, "receipt_saved"]);

    // Auditul: fără sume, fără nume.
    const audit = await fx.scratch.admin<{ metadata: unknown }[]>`
      select metadata from finet.audit_events where action like 'receipt.%'`;
    const text = JSON.stringify(audit);
    expect(text).not.toContain("4590");
    expect(text).not.toMatch(/LIDL|PAINE|LAPTE/i);
  });

  it("posibil duplicat: confirmarea cere allowDuplicate", async () => {
    const hh = await householdOf("ana@exemplu.ro");
    const up = await upload(A, [await receiptLikeImage({ seed: 104 })]);
    const id = (up.body.data as { documents: { id: string }[] }).documents[0]!.id;
    const dup = await seedReceipt(hh, id, { duplicateOf: receiptId });
    const url = `/api/v1/receipts/${dup}/confirm`;
    const no = await call(
      RC.confirmReceiptHandler,
      url,
      { bearer: A.bearer, body: { accountId: accA } },
      dup,
    );
    expect([no.status, no.body.error?.reason]).toEqual([409, "possible_duplicate"]);
    const yes = await call(
      RC.confirmReceiptHandler,
      url,
      { bearer: A.bearer, body: { accountId: accA, allowDuplicate: true, categoryId: null } },
      dup,
    );
    expect(yes.status, JSON.stringify(yes.body)).toBe(201);
  });

  it("reprocesarea: bonul dispare, documentul revine în coadă, limita zilnică se consumă (409 la plafon)", async () => {
    const hh = await householdOf("ana@exemplu.ro");
    const usage = async () =>
      (
        (await call(D.aiUsageHandler, "/api/v1/ai/usage", { bearer: A.bearer })).body.data as {
          used: number;
        }
      ).used;
    const up = await upload(A, [await receiptLikeImage({ seed: 105 })]);
    const id = (up.body.data as { documents: { id: string }[] }).documents[0]!.id;
    const r = await seedReceipt(hh, id);
    const before = await usage();
    const res = await call(
      RC.reprocessReceiptHandler,
      `/api/v1/receipts/${r}/reprocess`,
      { bearer: A.bearer, method: "POST" },
      r,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(await usage()).toBe(before + 1);
    const [doc] = await fx.scratch.admin<{ status: string; attempts: number }[]>`
      select status, attempts from finet.documents where id = ${id}`;
    expect(doc).toEqual({ status: "queued", attempts: 0 });
    expect(
      (await call(RC.getReceiptHandler, `/api/v1/receipts/${r}`, { bearer: A.bearer }, r)).status,
    ).toBe(404);
    // `order` doar pentru bon lung → 400.
    const r2 = await seedReceipt(hh, id);
    const ord = await call(
      RC.reprocessReceiptHandler,
      `/api/v1/receipts/${r2}/reprocess`,
      { bearer: A.bearer, body: { order: [2, 1] } },
      r2,
    );
    expect(ord.status).toBe(400);
    // Plafonul zilnic (8): se umple contorul, apoi reprocesarea e refuzată.
    await fx.scratch
      .admin`update finet.document_usage_daily set count = 8 where household_id = ${hh}`;
    const full = await call(
      RC.reprocessReceiptHandler,
      `/api/v1/receipts/${r2}/reprocess`,
      { bearer: A.bearer, method: "POST" },
      r2,
    );
    expect([full.status, full.body.error?.reason]).toEqual([409, "daily_document_limit"]);
    // B nu poate reprocesa bonul lui A.
    const foreign = await call(
      RC.reprocessReceiptHandler,
      `/api/v1/receipts/${r2}/reprocess`,
      { bearer: B.bearer, method: "POST" },
      r2,
    );
    expect(foreign.status).toBe(404);
    await fx.scratch
      .admin`update finet.document_usage_daily set count = 0 where household_id = ${hh}`;
  });

  it("ștergerea bonului: documentul și fișierul dispar, tranzacția rămâne fără legătură", async () => {
    const [{ transaction_id }] = (await fx.scratch.admin<{ transaction_id: string }[]>`
      select transaction_id from finet.receipts where id = ${receiptId}`) as [
      { transaction_id: string },
    ];
    expect(
      (
        await call(
          RC.deleteReceiptHandler,
          `/api/v1/receipts/${receiptId}`,
          { bearer: B.bearer, method: "DELETE" },
          receiptId,
        )
      ).status,
    ).toBe(404);
    const del = await call(
      RC.deleteReceiptHandler,
      `/api/v1/receipts/${receiptId}`,
      { bearer: A.bearer, method: "DELETE" },
      receiptId,
    );
    expect(del.status).toBe(204);
    const docs = await fx.scratch.admin`select 1 from finet.documents where id = ${docId}`;
    expect(docs).toHaveLength(0);
    const hh = await householdOf("ana@exemplu.ro");
    const files = await readdir(join(root, "households", hh, "documents"));
    expect(files).not.toContain(docId);
    const [tx] = await fx.scratch.admin<{ document_id: string | null }[]>`
      select document_id from finet.transactions where id = ${transaction_id}`;
    expect(tx).toEqual({ document_id: null });
  });

  it("ștergerea unui document: 204, apoi 404; B → 404", async () => {
    const up = await upload(A, [await receiptLikeImage({ seed: 106 })]);
    const id = (up.body.data as { documents: { id: string }[] }).documents[0]!.id;
    expect(
      (
        await call(
          D.deleteDocumentHandler,
          `/api/v1/documents/${id}`,
          { bearer: B.bearer, method: "DELETE" },
          id,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          D.deleteDocumentHandler,
          `/api/v1/documents/${id}`,
          { bearer: A.bearer, method: "DELETE" },
          id,
        )
      ).status,
    ).toBe(204);
    expect(
      (await call(D.getDocumentHandler, `/api/v1/documents/${id}`, { bearer: A.bearer }, id))
        .status,
    ).toBe(404);
  });
  it("paginarea cu cursor: fără duplicate între pagini; cursor modificat → 400", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const url: string = `/api/v1/receipts?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
      const r = await call(RC.listReceiptsHandler, url, { bearer: A.bearer });
      expect(r.status).toBe(200);
      seen.push(...(r.body.data as Receipt[]).map((x) => x.id));
      cursor = (r.body.nextCursor as string | null) ?? null;
      if (cursor === null) break;
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(seen.length);
    const bad = await call(RC.listReceiptsHandler, "/api/v1/receipts?cursor=abc", {
      bearer: A.bearer,
    });
    expect(bad.status).toBe(400);
  });
});
