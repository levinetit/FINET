import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildStatementFixtures } from "../../../../scripts/make-statement-fixtures.mjs";

import { TEST_ADMIN_URL } from "@/db/testing";
import { LocalStorage } from "@/lib/storage";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { multipartRequest } from "@/modules/documents/testing";
import { itemsToPdf } from "@/modules/statements/testing";
import { handleStatementParse } from "@/worker/statements/statement-jobs";

import * as L from "./_lib/ledger-handlers";
import * as MT from "./_lib/matching-handlers";
import * as S from "./_lib/statements-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

type Body = Record<string, unknown> & { data?: unknown; error?: { code: string; reason?: string } };
type Handler = (...a: never[]) => Promise<Response>;

const fixtures = buildStatementFixtures();
const CSV = Buffer.from(
  ["Data;Descriere;Suma", "03.11.2026;Cafenea Exemplu;-15,00", "04.11.2026;Salariu;4500,00"].join(
    "\r\n",
  ),
);
const MAPPING = JSON.stringify({
  headerRow: 0,
  date: 0,
  dateFormat: "dmy_dot",
  amount: 2,
  decimal: ",",
  thousands: "",
  description: [1],
});

/**
 * API-ul extraselor, al potrivirii și al propunerilor (F7-B) pe PostgreSQL real: handlere reale,
 * sesiuni reale, storage local temporar, contractul OpenAPI verificat pe fiecare răspuns.
 */
describe.skipIf(!TEST_ADMIN_URL)("API extrase + potrivire + propuneri (F7-B)", () => {
  const PASS = "parola-extrase-12345";
  let fx: AuthFixture;
  let auth: AuthEnv;
  let env: S.StatementsApiDeps;
  let root: string;
  let A: Sessions;
  let B: Sessions;
  let accA: string;
  let seq = 0;
  const key = () => `extrase-cheie-${String(++seq).padStart(8, "0")}`;

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
    const text = await res.clone().text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {}, res };
  }

  async function upload(
    s: Sessions | null,
    file: Buffer | null,
    fields: [string, string][],
    deps: S.StatementsApiDeps = env,
    extra: [string, Buffer][] = [],
  ) {
    const parts = [
      ...fields,
      ...(file ? [["file", file, "extras.bin"] as const] : []),
      ...extra.map(([n, b]) => [n, b, "x.bin"] as const),
    ];
    const res = await S.uploadStatementHandler(
      await multipartRequest(parts, s ? { authorization: `Bearer ${s.bearer}` } : {}),
      deps,
    );
    await assertContract(S.uploadStatementHandler, res);
    return { status: res.status, body: (await readJson(res)) as Body };
  }

  const householdOf = async (email: string) => {
    const [row] = await fx.scratch.admin<{ household_id: string }[]>`
      select m.household_id from finet.household_members m join finet.users u on u.id = m.user_id
       where u.email = ${email}`;
    return row!.household_id;
  };

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_statements_api");
    root = await realpath(await mkdtemp(join(tmpdir(), "finet-stmt-api-")));
    auth = authEnv(fx.db, { now: () => Date.parse("2026-11-20T10:00:00Z") });
    env = {
      ...auth,
      storage: new LocalStorage(root),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        statementUpload: { max: 100_000, windowSeconds: 60 },
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
    A = await sessionsFor(auth, "ana@exemplu.ro", PASS);
    B = await sessionsFor(auth, "bogdan@exemplu.ro", PASS);
    const r = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      body: { name: "Banca", type: "bank", currency: "RON" },
    });
    accA = (r.body.data as { id: string }).id;
  });
  afterAll(async () => {
    await fx?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("încărcarea: 401 fără sesiune; 415 fără multipart; câmpuri/fișiere în plus → 400/413; fișier invalid → 422 cu cod", async () => {
    expect((await upload(null, CSV, [["accountId", accA]])).status).toBe(401);
    const notMultipart = await call(S.uploadStatementHandler, "/api/v1/statements/uploads", {
      bearer: A.bearer,
      body: { accountId: accA },
    });
    expect(notMultipart.status).toBe(415);
    const extraField = await upload(A, CSV, [
      ["accountId", accA],
      ["kind", "receipt"],
    ]);
    expect(extraField).toMatchObject({ status: 400, body: { error: { code: "invalid_field" } } });
    const two = await upload(A, CSV, [["accountId", accA]], env, [["file", CSV]]);
    expect([400, 413]).toContain(two.status);
    const noAccount = await upload(A, CSV, []);
    expect(noAccount.status).toBe(400);
    const badMapping = await upload(A, CSV, [
      ["accountId", accA],
      ["mapping", "[1,2"],
    ]);
    expect(badMapping.status).toBe(400);
    const junk = await upload(A, Buffer.from([0, 1, 2, 3]), [["accountId", accA]]);
    expect(junk).toMatchObject({ status: 422, body: { error: { code: "csv_invalid" } } });
    const unknownPdf = await upload(
      A,
      itemsToPdf([{ p: 1, x: 10, y: 700, w: 50, s: "Banca Necunoscuta" }]),
      [["accountId", accA]],
    );
    // PDF-ul nu se citește în web: intră în coada workerului (refuzul vine de acolo).
    expect(unknownPdf.status).toBe(201);
  });

  it("limita proprie de încărcare → 429 cu Retry-After", async () => {
    const tight = {
      ...env,
      limits: { ...env.limits, statementUpload: { max: 1, windowSeconds: 600 } },
    };
    const C = await (async () => {
      await createUserWithHousehold(fx.db, {
        email: "carmen@exemplu.ro",
        name: "Carmen",
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
      return sessionsFor(auth, "carmen@exemplu.ro", PASS);
    })();
    await upload(C, CSV, [["accountId", accA]], tight);
    const second = await upload(C, CSV, [["accountId", accA]], tight);
    expect(second).toMatchObject({ status: 429, body: { error: { code: "rate_limited" } } });
  });

  it("CSV: mapare cerută → previzualizare → confirmare idempotentă (Idempotency-Key) → listă, acoperire, anulare", async () => {
    const first = await upload(A, CSV, [["accountId", accA]]);
    expect(first.status).toBe(200);
    expect((first.body.data as { parts: { kind: string }[] }).parts[0]!.kind).toBe(
      "mapping_required",
    );
    const second = await upload(A, CSV, [
      ["accountId", accA],
      ["mapping", MAPPING],
    ]);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const imp = (second.body.data as { parts: { import: { id: string; status: string } }[] })
      .parts[0]!.import;
    expect(imp.status).toBe("previewed");
    const detail = await call(
      S.getImportHandler,
      `/api/v1/statements/imports/${imp.id}`,
      { bearer: A.bearer },
      imp.id,
    );
    expect((detail.body.data as { lines: unknown[] }).lines).toHaveLength(2);
    // Altă gospodărie: 404 pe detaliu, confirmare, anulare.
    expect(
      (
        await call(
          S.getImportHandler,
          `/api/v1/statements/imports/${imp.id}`,
          { bearer: B.bearer },
          imp.id,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          S.confirmImportHandler,
          `/api/v1/statements/imports/${imp.id}/confirm`,
          { bearer: B.bearer, body: {} },
          imp.id,
        )
      ).status,
    ).toBe(404);
    const k = key();
    const confirm = (init: ApiInit) =>
      call(S.confirmImportHandler, `/api/v1/statements/imports/${imp.id}/confirm`, init, imp.id);
    const c1 = await confirm({ bearer: A.bearer, body: {}, headers: { "idempotency-key": k } });
    expect(c1.status, JSON.stringify(c1.body)).toBe(200);
    expect(c1.body.data).toMatchObject({ status: "imported", importedCount: 2 });
    const c2 = await confirm({ bearer: A.bearer, body: {}, headers: { "idempotency-key": k } });
    expect(c2.res.headers.get("idempotent-replay")).toBe("true");
    const reused = await confirm({
      bearer: A.bearer,
      body: { skipRows: [1] },
      headers: { "idempotency-key": k },
    });
    expect(reused.status).toBe(422);
    // Reîncărcarea aceluiași fișier: deja importat, nimic nou (200).
    const again = await upload(A, CSV, [
      ["accountId", accA],
      ["mapping", MAPPING],
    ]);
    expect(again.status).toBe(200);
    const list = await call(S.listImportsHandler, `/api/v1/statements/imports?accountId=${accA}`, {
      bearer: A.bearer,
    });
    expect((list.body.data as { id: string }[]).map((i) => i.id)).toContain(imp.id);
    expect(
      (await call(S.listImportsHandler, "/api/v1/statements/imports", { bearer: B.bearer })).body
        .data,
    ).toEqual([]);
    const cov = await call(
      S.coverageHandler,
      "/api/v1/statements/coverage?from=2026-10&to=2026-11",
      { bearer: A.bearer },
    );
    expect(cov.status).toBe(200);
    expect((cov.body.data as { accountId: string }[])[0]!.accountId).toBe(accA);
    expect(
      (
        await call(S.coverageHandler, "/api/v1/statements/coverage?from=2026-13&to=2026-11", {
          bearer: A.bearer,
        })
      ).status,
    ).toBe(400);
    const cancel = await call(
      S.cancelImportHandler,
      `/api/v1/statements/imports/${imp.id}/cancel`,
      { bearer: A.bearer, body: {} },
      imp.id,
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.data).toMatchObject({ status: "cancelled", keptEdited: 0 });
    // CSRF: cookie fără Origin → 403.
    const csrf = await call(
      S.cancelImportHandler,
      `/api/v1/statements/imports/${imp.id}/cancel`,
      { cookie: A.cookie, body: {}, headers: { origin: "" } },
      imp.id,
    );
    expect(csrf.status).toBe(403);
  });

  it("PDF: în coadă → workerul → previzualizare → renunțare (fișierul șters); B nu vede nimic", async () => {
    const pdf = itemsToPdf(fixtures.bt.items);
    const up = await upload(A, pdf, [["accountId", accA]]);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const u = (
      up.body.data as { parts: { kind: string; upload: { id: string; status: string } }[] }
    ).parts[0]!;
    expect(u).toMatchObject({ kind: "queued", upload: { status: "queued" } });
    const id = u.upload.id;
    expect(
      (await call(S.getUploadHandler, `/api/v1/statements/uploads/${id}`, { bearer: B.bearer }, id))
        .status,
    ).toBe(404);
    const hh = await householdOf("ana@exemplu.ro");
    expect(
      await handleStatementParse(
        { db: fx.db, storage: env.storage! },
        { uploadId: id, householdId: hh },
      ),
    ).toEqual({
      outcome: "parsed",
    });
    const st = await call(
      S.getUploadHandler,
      `/api/v1/statements/uploads/${id}`,
      { bearer: A.bearer },
      id,
    );
    const importId = (st.body.data as { importId: string; status: string }).importId;
    expect(st.body.data).toMatchObject({ status: "parsed", fileDeleted: false });
    const listed = await call(S.listUploadsHandler, "/api/v1/statements/uploads", {
      bearer: A.bearer,
    });
    expect((listed.body.data as { id: string }[]).some((x) => x.id === id)).toBe(true);
    const del = await call(
      S.discardImportHandler,
      `/api/v1/statements/imports/${importId}`,
      { bearer: A.bearer, method: "DELETE" },
      importId,
    );
    expect(del.status).toBe(204);
    const after = await call(
      S.getUploadHandler,
      `/api/v1/statements/uploads/${id}`,
      { bearer: A.bearer },
      id,
    );
    expect(after.body.data).toMatchObject({ fileDeleted: true, importId: null });
    // Renunțarea la încărcarea (deja fără fișier) e idempotentă.
    const cancel = await call(
      S.cancelUploadHandler,
      `/api/v1/statements/uploads/${id}`,
      { bearer: A.bearer, method: "DELETE" },
      id,
    );
    expect(cancel.status).toBe(200);
    // B nu poate încărca pe contul lui A.
    expect((await upload(B, CSV, [["accountId", accA]])).status).toBe(404);
  });

  it("potrivire: propunerea pentru bon, confirmarea, coada; propunerile de recurențe: listă, acceptare idempotentă, respingere", async () => {
    const hh = await householdOf("ana@exemplu.ro");
    const [u] = await fx.scratch.admin<{ id: string }[]>`
      select id from finet.users where email = 'ana@exemplu.ro'`;
    const stmt = async (amount: number, on: string, description: string) => {
      const id = randomUUID();
      await fx.scratch.admin`insert into finet.transactions (id, household_id, account_id, type,
          amount_minor, currency, occurred_on, description, source, external_ref, created_by_user_id)
        values (${id}, ${hh}, ${accA}, 'expense', ${amount}, 'RON', ${on}, ${description},
          'statement', ${`stmt:${createHash("sha256").update(id).digest("hex")}`}, ${u!.id})`;
      return id;
    };
    const t = await stmt(4590, "2026-10-13", "EPOS LIDL DISCOUNT");
    const doc = randomUUID();
    await fx.scratch.admin`insert into finet.documents (id, household_id, kind, status,
        detected_mime, size_bytes, sha256, storage_key, uploaded_by_user_id)
      values (${doc}, ${hh}, 'receipt', 'needs_review', 'image/jpeg', 10,
        ${createHash("sha256").update(doc).digest("hex")}, ${`households/${hh}/documents/${doc}`}, ${u!.id})`;
    const [r] = await fx.scratch.admin<{ id: string }[]>`
      insert into finet.receipts (household_id, document_id, merchant_name, merchant_tax_id,
        occurred_on, total_minor, currency, status)
      values (${hh}, ${doc}, 'LIDL DISCOUNT SRL', 'RO22891860', '2026-10-12', 4590, 'RON', 'needs_review')
      returning id`;
    const m = await call(
      MT.receiptMatchesHandler,
      `/api/v1/receipts/${r!.id}/matches`,
      { bearer: A.bearer },
      r!.id,
    );
    expect(m.status).toBe(200);
    expect(
      (m.body.data as { candidates: { transactionId: string }[] }).candidates[0]!.transactionId,
    ).toBe(t);
    expect(
      (
        await call(
          MT.receiptMatchesHandler,
          `/api/v1/receipts/${r!.id}/matches`,
          { bearer: B.bearer },
          r!.id,
        )
      ).status,
    ).toBe(404);
    const q = await call(MT.matchQueueHandler, "/api/v1/matches", { bearer: A.bearer });
    expect((q.body.data as { receiptId: string }[]).map((x) => x.receiptId)).toContain(r!.id);
    const bad = await call(
      MT.decideMatchHandler,
      `/api/v1/receipts/${r!.id}/matches`,
      { bearer: A.bearer, body: { transactionId: t, decision: "maybe" } },
      r!.id,
    );
    expect(bad.status).toBe(400);
    const ok = await call(
      MT.decideMatchHandler,
      `/api/v1/receipts/${r!.id}/matches`,
      { bearer: A.bearer, body: { transactionId: t, decision: "confirm" } },
      r!.id,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ decision: "confirm", transactionId: t });

    for (const d of ["2026-08-05", "2026-09-05", "2026-10-05", "2026-11-05"]) {
      await stmt(5999, d, "NETFLIX.COM");
    }
    const list = await call(MT.listSuggestionsHandler, "/api/v1/recurring/suggestions", {
      bearer: A.bearer,
    });
    const sug = (list.body.data as { signature: string; description: string }[]).find((s) =>
      s.description.startsWith("NETFLIX"),
    )!;
    expect(sug).toBeTruthy();
    expect(
      (await call(MT.listSuggestionsHandler, "/api/v1/recurring/suggestions", { bearer: B.bearer }))
        .body.data,
    ).toEqual([]);
    const k = key();
    const acc1 = await call(
      MT.acceptSuggestionHandler,
      `/api/v1/recurring/suggestions/${sug.signature}/accept`,
      { bearer: A.bearer, body: {}, headers: { "idempotency-key": k } },
      sug.signature,
    );
    expect(acc1.status, JSON.stringify(acc1.body)).toBe(201);
    const acc2 = await call(
      MT.acceptSuggestionHandler,
      `/api/v1/recurring/suggestions/${sug.signature}/accept`,
      { bearer: A.bearer, body: {}, headers: { "idempotency-key": k } },
      sug.signature,
    );
    expect(acc2.res.headers.get("idempotent-replay")).toBe("true");
    expect(
      (
        await call(
          MT.dismissSuggestionHandler,
          `/api/v1/recurring/suggestions/${"0".repeat(64)}/dismiss`,
          { bearer: A.bearer, method: "POST" },
          "0".repeat(64),
        )
      ).status,
    ).toBe(404);
  });
});
