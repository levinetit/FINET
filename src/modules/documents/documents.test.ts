import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { LocalStorage, type StorageKey } from "@/lib/storage";
import { createAccount } from "@/modules/accounts/accounts.service";
import { testConfig } from "@/modules/auth/testing";
import { createEntitlements } from "@/modules/entitlements";
import {
  type LedgerFixture,
  createLedgerFixture,
  sqlState,
  systemCategoryId,
} from "@/modules/ledger/testing";
import {
  claimDocument,
  listQueuedDocuments,
  prepareDocument,
} from "@/worker/receipts/documents-job";
import { activePdfChildren } from "@/worker/receipts/pdf-sandbox";

import {
  type DocumentsDeps,
  dailyUsage,
  deleteDocument,
  getDocument,
  queueAwaitingConsent,
  uploadDocuments,
} from "./documents.service";
import { HOSTILE, jpegWithGpsExif, multipartRequest, receiptLikeImage, textPdf } from "./testing";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

describe.skipIf(!TEST_ADMIN_URL)("documente (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  let root: string;
  let storage: LocalStorage;
  const config = testConfig();

  const deps = (extra: Partial<DocumentsDeps> = {}): DocumentsDeps => ({
    ...f.deps,
    storage,
    config,
    ...extra,
  });
  const limited = (daily: number, quotaMb = 5000): Partial<DocumentsDeps> => ({
    entitlements: createEntitlements("personal", {
      ai: { dailyDocumentLimit: daily, monthlyBudget: config.ai.monthlyBudget },
      storage: { ...config.storage, quotaMb },
    }),
  });
  const files = (household: string) =>
    readdir(join(root, "households", household.toLowerCase(), "documents")).catch(() => []);
  const upload = async (
    parts: Parameters<typeof multipartRequest>[0],
    actor = f.A,
    household = f.HA,
    extra: Partial<DocumentsDeps> = {},
  ) => uploadDocuments(deps(extra), actor, household, await multipartRequest(parts));

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_documents");
    root = await realpath(await mkdtemp(join(tmpdir(), "finet-docs-")));
    storage = new LocalStorage(root);
  });
  afterAll(async () => {
    await f?.close();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    // Fiecare test pornește fără documente, consimțăminte sau fișiere.
    await f.admin`delete from finet.documents`;
    await f.admin`delete from finet.processing_batches`;
    await f.admin`delete from finet.consents`;
    await f.admin`delete from finet.document_usage_daily`;
    await rm(join(root, "households"), { recursive: true, force: true });
  });

  const grantExternalAi = (userId: string) =>
    f.admin`insert into finet.consents (user_id, kind) values (${userId}, 'external_ai')`;

  describe("încărcarea", () => {
    it("fără consimțământ external_ai → awaiting_consent; fișierul în storage; audit fără nume", async () => {
      const jpg = await receiptLikeImage();
      const result = await upload([["files", jpg, "bon-lidl.jpg", "image/jpeg"]]);
      expect(result.created).toBe(1);
      const [doc] = result.documents;
      expect(doc).toMatchObject({
        kind: "receipt",
        status: "awaiting_consent",
        mime: "image/jpeg",
        sizeBytes: jpg.length,
        duplicate: false,
        batchId: null,
        fileDeleted: false,
      });
      expect(doc!.expiresAt!.getTime() - doc!.createdAt.getTime()).toBeGreaterThan(
        179 * 24 * 3600 * 1000,
      );
      expect(await files(f.HA)).toEqual([doc!.id]);
      const [row] = await f.admin<
        { storage_key: string; sha256: string; uploaded_by_user_id: string }[]
      >`
        select storage_key, sha256, uploaded_by_user_id from finet.documents where id = ${doc!.id}`;
      expect(row!.storage_key).toBe(`households/${f.HA}/documents/${doc!.id}`);
      expect(row!.uploaded_by_user_id).toBe(f.A.userId);
      const audits = await f.admin<{ action: string; metadata: unknown }[]>`
        select action, metadata from finet.audit_events where action = 'document.uploaded'
         order by created_at desc limit 1`;
      expect(audits[0]).toEqual({
        action: "document.uploaded",
        metadata: { created: 1, duplicates: 0 },
      });
      expect(JSON.stringify(audits)).not.toContain("bon-lidl");
    });

    it("cu consimțământ external_ai → queued; după acordare, cele în așteptare trec în coadă", async () => {
      const waiting = await upload([["files", await receiptLikeImage({ seed: 2 })]]);
      expect(waiting.documents[0]!.status).toBe("awaiting_consent");
      expect(await queueAwaitingConsent(deps(), f.A, f.HA)).toBe(0);
      await grantExternalAi(f.A.userId);
      expect(
        (await upload([["files", await receiptLikeImage({ seed: 3 })]])).documents[0]!.status,
      ).toBe("queued");
      expect(await queueAwaitingConsent(deps(), f.A, f.HA)).toBe(1);
      expect((await getDocument(deps(), f.A, f.HA, waiting.documents[0]!.id)).status).toBe(
        "queued",
      );
    });

    it("deduplicare exactă (SHA-256): același fișier → documentul existent, fără rând sau fișier nou", async () => {
      const jpg = await receiptLikeImage({ seed: 4 });
      const first = await upload([["files", jpg, "a.jpg"]]);
      const second = await upload([["files", jpg, "alt-nume.jpg"]], f.C);
      expect(second.created).toBe(0);
      expect(second.documents).toEqual([{ ...first.documents[0]!, duplicate: true }]);
      expect(await files(f.HA)).toEqual([first.documents[0]!.id]);
      // De două ori în aceeași cerere: un singur document.
      const png = await receiptLikeImage({ seed: 5, format: "png" });
      const twice = await upload([
        ["files", png],
        ["files", png],
      ]);
      expect(twice.created).toBe(1);
      expect(twice.documents.map((d) => d.duplicate)).toEqual([false, true]);
      expect(twice.documents[0]!.id).toBe(twice.documents[1]!.id);
      expect((await files(f.HA)).length).toBe(2);
    });

    it("deduplicarea nu e limitată: un duplicat trece și când limita zilnică e atinsă", async () => {
      const jpg = await receiptLikeImage({ seed: 6 });
      await upload([["files", jpg]], f.A, f.HA, limited(1));
      expect((await upload([["files", jpg]], f.A, f.HA, limited(1))).documents[0]!.duplicate).toBe(
        true,
      );
      const error = await upload([["files", textPdf()]], f.A, f.HA, limited(1)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).reason).toBe("daily_document_limit");
      expect((await files(f.HA)).length).toBe(1);
      expect(await dailyUsage(deps(limited(1)), f.A, f.HA)).toEqual({ used: 1, limit: 1 });
    });

    it("ștergerea nu eliberează limita zilnică (contor care doar crește, revizuirea M3)", async () => {
      const first = await upload(
        [["files", await receiptLikeImage({ seed: 60 })]],
        f.A,
        f.HA,
        limited(1),
      );
      await deleteDocument(deps(), f.A, f.HA, first.documents[0]!.id);
      const error = await upload(
        [["files", await receiptLikeImage({ seed: 61 })]],
        f.A,
        f.HA,
        limited(1),
      ).catch((e: unknown) => e);
      expect((error as ConflictError).reason).toBe("daily_document_limit");
      expect(await files(f.HA)).toEqual([]);
      expect(await dailyUsage(deps(limited(1)), f.A, f.HA)).toEqual({ used: 1, limit: 1 });
    });

    it("ziua limitei e cea din București (00:30 local = 22:30 UTC în ziua precedentă)", async () => {
      // 28 oct. 2026, 22:30 UTC = 29 oct., 00:30 la București (EET, UTC+2 după 25 oct.).
      const now = () => new Date("2026-10-28T22:30:00Z");
      await upload([["files", await receiptLikeImage({ seed: 62 })]], f.A, f.HA, { now });
      const rows = await f.admin<{ day: string; count: number }[]>`
        select day::text as day, count from finet.document_usage_daily where household_id = ${f.HA}`;
      expect(rows).toEqual([{ day: "2026-10-29", count: 1 }]);
      // Duplicatul nu crește contorul.
      await upload([["files", await receiptLikeImage({ seed: 62 })]], f.A, f.HA, { now });
      const [again] = await f.admin<{ count: number }[]>`
        select count from finet.document_usage_daily where household_id = ${f.HA}`;
      expect(again!.count).toBe(1);
    });

    it("cota de stocare: peste plafon → storage_quota_exceeded, fișierele șterse", async () => {
      await upload([["files", await receiptLikeImage({ seed: 7 })]], f.A, f.HA, limited(50, 1));
      const big = await sharp(Buffer.alloc(800 * 800 * 3, 7), {
        raw: { width: 800, height: 800, channels: 3 },
      })
        .png({ compressionLevel: 0 })
        .toBuffer();
      const error = await upload([["files", big]], f.A, f.HA, limited(50, 1)).catch(
        (e: unknown) => e,
      );
      expect((error as ConflictError).reason).toBe("storage_quota_exceeded");
      expect((await files(f.HA)).length).toBe(1);
    });

    it("un străin nu poate încărca în altă gospodărie (404), iar corpul nu se citește", async () => {
      const error = await upload([["files", await receiptLikeImage()]], f.B, f.HA).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NotFoundError);
      expect(await files(f.HA)).toEqual([]);
    });

    it("conținut ostil → refuzat înainte de bază, nimic stocat", async () => {
      for (const [, data] of HOSTILE.slice(0, 3)) {
        await expect(upload([["files", data, "bon.jpg", "image/jpeg"]])).rejects.toThrow();
      }
      expect(await files(f.HA)).toEqual([]);
      const [n] = await f.admin<{ n: number }[]>`select count(*)::int as n from finet.documents`;
      expect(n!.n).toBe(0);
    });

    it("bon lung: 2–4 poze, ordonate în lot; PDF sau o singură poză → 400; extrase → 400", async () => {
      const parts = await Promise.all([11, 12, 13].map((seed) => receiptLikeImage({ seed })));
      const result = await upload([
        ["longReceipt", "true"],
        ...parts.map((p, i) => ["files", p, `${i}.jpg`] as const),
      ]);
      expect(result.batchId).not.toBeNull();
      expect(result.documents.map((d) => [d.batchId, d.documentOrder])).toEqual([
        [result.batchId, 1],
        [result.batchId, 2],
        [result.batchId, 3],
      ]);
      const [batch] = await f.admin<{ kind: string }[]>`
        select kind from finet.processing_batches where id = ${result.batchId}`;
      expect(batch!.kind).toBe("long_receipt");

      for (const bad of [
        [
          ["longReceipt", "true"],
          ["files", parts[0]!],
        ],
        [
          ["longReceipt", "true"],
          ["files", await receiptLikeImage({ seed: 20 })],
          ["files", textPdf()],
        ],
        [
          ["kind", "statement"],
          ["files", textPdf(["EXTRAS DE CONT BANCA TEST 2026 IULIE"])],
        ],
        [
          ["longReceipt", "poate"],
          ["files", await receiptLikeImage({ seed: 21 })],
        ],
      ] as const) {
        await expect(upload(bad)).rejects.toBeInstanceOf(ValidationError);
      }
      expect((await files(f.HA)).length).toBe(3);
      // O poză deja încărcată într-un bon lung nou → conflict, nimic nou.
      const dup = await upload([
        ["longReceipt", "true"],
        ["files", parts[0]!],
        ["files", await receiptLikeImage({ seed: 22 })],
      ]).catch((e: unknown) => e);
      expect((dup as ConflictError).reason).toBe("long_receipt_duplicate");
      expect((await files(f.HA)).length).toBe(3);
    });
  });

  describe("citire și ștergere", () => {
    it("alt utilizator nu vede documentul (404); id invalid → 404", async () => {
      const id = (await upload([["files", await receiptLikeImage({ seed: 30 })]])).documents[0]!.id;
      expect((await getDocument(deps(), f.C, f.HA, id)).id).toBe(id);
      await expect(getDocument(deps(), f.B, f.HA, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getDocument(deps(), f.B, f.HB, id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getDocument(deps(), f.A, f.HA, "nu-e-uuid")).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(deleteDocument(deps(), f.B, f.HB, id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("ștergerea elimină fișierul și bonul extras; tranzacția rămâne, fără legătură (5.6)", async () => {
      const id = (await upload([["files", await receiptLikeImage({ seed: 31 })]])).documents[0]!.id;
      const account = await createAccount(f.deps, f.A, f.HA, {
        name: `Card ${randomUUID().slice(0, 6)}`,
        type: "bank",
        currency: "RON",
      });
      const [tx] = await f.admin<{ id: string }[]>`
        insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on, source, document_id)
        values (${f.HA}, ${account.id}, 'expense', 4590, 'RON', date '2026-10-01', 'receipt', ${id})
        returning id`;
      await f.admin`
        insert into finet.receipts (household_id, document_id, total_minor, transaction_id)
        values (${f.HA}, ${id}, 4590, ${tx!.id})`;
      await deleteDocument(deps(), f.A, f.HA, id);
      expect(await files(f.HA)).toEqual([]);
      const [row] = await f.admin<{ document_id: string | null }[]>`
        select document_id from finet.transactions where id = ${tx!.id}`;
      expect(row).toEqual({ document_id: null });
      const receipts = await f.admin`select 1 from finet.receipts where document_id = ${id}`;
      expect(receipts.length).toBe(0);
      const audit = await f.admin<{ target_id: string }[]>`
        select target_id from finet.audit_events where action = 'document.deleted'`;
      expect(audit.map((a) => a.target_id)).toContain(id);
    });
  });

  describe("workerul: selecția, revendicarea, preprocesarea (storage doar citire)", () => {
    const jobDeps = () => ({
      ...f.deps,
      storage: new LocalStorage(root, { readOnly: true }),
      limits: {
        maxImagePixels: 50_000_000,
        maxPdfPages: 6,
        timeoutMs: 30_000,
        duplicateMaxDistance: 6,
      },
    });

    it("queued_documents întoarce doar documentele în coadă, doar identificatori", async () => {
      await grantExternalAi(f.A.userId);
      const queued = await upload([["files", await receiptLikeImage({ seed: 40 })]]);
      await f.admin`delete from finet.consents`;
      await upload([["files", await receiptLikeImage({ seed: 41 })]]); // awaiting_consent
      const rows = await f.db.execute<Record<string, unknown>>(
        sql`select * from finet.queued_documents(10, 900)`,
      );
      expect(rows.map((r) => Object.keys(r).sort())).toEqual([
        ["actor_user_id", "document_id", "household_id"],
      ]);
      expect(await listQueuedDocuments(f.db)).toEqual([
        { documentId: queued.documents[0]!.id, householdId: f.HA, actorUserId: f.A.userId },
      ]);
    });

    it("pregătește: EXIF eliminat din imaginea trimisă mai departe, dHash, pagini; posibil duplicat legat", async () => {
      await grantExternalAi(f.A.userId);
      const original = await jpegWithGpsExif();
      // Altă copie (alt SHA), aceeași poză: rotită deja, fără EXIF, calitate mai mică.
      const copy = await sharp(original).rotate().jpeg({ quality: 60 }).toBuffer();
      // Încărcări separate: ordinea din coadă (created_at) e determinată.
      const a = (await upload([["files", original]])).documents[0];
      const b = (await upload([["files", copy]])).documents[0];
      const [refA, refB] = await listQueuedDocuments(f.db);
      expect([refA!.documentId, refB!.documentId]).toEqual([a!.id, b!.id]);

      const ready = await prepareDocument(jobDeps(), refA!);
      expect(ready.outcome).toBe("ready");
      if (ready.outcome !== "ready" || ready.preprocessed.kind !== "images") throw new Error("x");
      const meta = await sharp(ready.preprocessed.images[0]!.jpeg).metadata();
      expect(meta.exif).toBeUndefined();
      expect(ready.possibleDuplicateOfId).toBeNull();

      const second = await prepareDocument(jobDeps(), refB!);
      expect(second.outcome === "ready" && second.possibleDuplicateOfId).toBe(a!.id);
      const rows = await f.admin<
        { id: string; status: string; pages: number; attempts: number; h: boolean }[]
      >`
        select id, status, pages, attempts, perceptual_hash is not null as h
          from finet.documents order by created_at, id`;
      expect(rows.map((r) => [r.status, r.pages, r.attempts, r.h])).toEqual([
        ["processing", 1, 1, true],
        ["processing", 1, 1, true],
      ]);
      // Revendicat și în lucru: nu mai e revendicat a doua oară și nu mai apare în selecție.
      expect(await claimDocument(f.deps, refA!)).toBeNull();
      expect(await listQueuedDocuments(f.db)).toEqual([]);
      // Fișierul original (cu EXIF) a rămas neatins: storage doar citire.
      expect((await files(f.HA)).length).toBe(2);
    });

    it("un fișier înlocuit pe disc cu conținut ostil → rejected cu cod stabil", async () => {
      await grantExternalAi(f.A.userId);
      const doc = (await upload([["files", await receiptLikeImage({ seed: 42 })]])).documents[0]!;
      const key = `households/${f.HA}/documents/${doc.id}` as StorageKey;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(root, key), HOSTILE[0]![1]);
      const [ref] = await listQueuedDocuments(f.db);
      expect(await prepareDocument(jobDeps(), ref!)).toEqual({
        outcome: "rejected",
        code: "unsupported_type",
      });
      const [row] = await f.admin<{ status: string; error_code: string }[]>`
        select status, error_code from finet.documents where id = ${doc.id}`;
      expect(row).toEqual({ status: "rejected", error_code: "unsupported_type" });
    });

    it("PDF cu un copil ostil (anunță 200 MB): copilul ucis, documentul rejected, workerul viu", async () => {
      await grantExternalAi(f.A.userId);
      const doc = (await upload([["files", textPdf(), "bon.pdf", "application/pdf"]]))
        .documents[0]!;
      const { writeFile, mkdtemp: mk } = await import("node:fs/promises");
      const dir = await mk(join(tmpdir(), "finet-hostile-child-"));
      const script = join(dir, "hostile.mjs");
      await writeFile(
        script,
        'process.stdout.write(JSON.stringify({pages:1,text:[""],images:[{width:100,height:100,length:200*1024*1024}]})+"\\n"); setInterval(()=>{},1000);',
      );
      try {
        const [ref] = await listQueuedDocuments(f.db);
        const deps = jobDeps();
        const outcome = await prepareDocument(
          { ...deps, limits: { ...deps.limits, pdfChildScript: script } },
          ref!,
        );
        expect(outcome).toEqual({ outcome: "rejected", code: "pdf_too_complex" });
        expect(activePdfChildren()).toBe(0);
        const [row] = await f.admin<{ status: string; error_code: string }[]>`
          select status, error_code from finet.documents where id = ${doc.id}`;
        expect(row).toEqual({ status: "rejected", error_code: "pdf_too_complex" });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("un fișier înlocuit pe disc cu unul mai mare decât cel înregistrat → rejected file_changed", async () => {
      await grantExternalAi(f.A.userId);
      const doc = (await upload([["files", await receiptLikeImage({ seed: 44 })]])).documents[0]!;
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(root, `households/${f.HA}/documents/${doc.id}`),
        await receiptLikeImage({ seed: 45, width: 1200, height: 1800 }),
      );
      const [ref] = await listQueuedDocuments(f.db);
      expect(await prepareDocument(jobDeps(), ref!)).toEqual({
        outcome: "rejected",
        code: "file_changed",
      });
    });

    it("plafonul de încercări: la 10, documentul nu mai e selectat", async () => {
      await grantExternalAi(f.A.userId);
      const doc = (await upload([["files", await receiptLikeImage({ seed: 43 })]])).documents[0]!;
      await f.admin`update finet.documents set attempts = 10 where id = ${doc.id}`;
      expect(await listQueuedDocuments(f.db)).toEqual([]);
      await f.admin`update finet.documents set attempts = 9, status = 'processing',
        processing_started_at = now() - interval '1 hour' where id = ${doc.id}`;
      // Termen de lucru expirat: reluat.
      expect((await listQueuedDocuments(f.db)).map((r) => r.documentId)).toEqual([doc.id]);
    });
  });

  describe("RLS, CHECK-uri și triggere pe tabelele noi (ca finet_app)", () => {
    const TABLES = [
      "documents",
      "processing_batches",
      "receipts",
      "receipt_lines",
      "product_aliases",
      "ai_calls",
      "document_usage_daily",
    ] as const;

    it("fără context: 0 rânduri; în contextul lui B: nimic din HA", async () => {
      await upload([["files", await receiptLikeImage({ seed: 50 })]]);
      const [doc] = await f.admin<{ id: string }[]>`select id from finet.documents`;
      const [rc] = await f.admin<{ id: string }[]>`
        insert into finet.receipts (household_id, document_id) values (${f.HA}, ${doc!.id}) returning id`;
      await f.admin`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name, line_total_minor)
        values (${rc!.id}, ${f.HA}, 1, 'LAPTE', 799)`;
      const food = await systemCategoryId(f.admin, "expense.groceries").catch(() => null);
      const [anyExpense] = await f.admin<{ id: string }[]>`
        select id from finet.categories where household_id is null and kind = 'expense' limit 1`;
      const category = food ?? anyExpense!.id;
      await f.admin`insert into finet.product_aliases (household_id, normalized_name, category_id)
        values (${f.HA}, 'lapte 1,5% 1l', ${category})`;
      await f.admin`insert into finet.ai_calls (household_id, document_id, task, model_alias, provider, duration_ms, result)
        values (${f.HA}, ${doc!.id}, 'receipt_extract', 'finet-vision-external', 'external', 1200, 'ok')`;
      await f.admin`insert into finet.processing_batches (household_id, kind) values (${f.HA}, 'single')`;
      // Contorul zilei există deja (încărcarea de mai sus l-a creat).

      for (const table of TABLES) {
        const all = await f.admin.unsafe(`select count(*)::int as n from finet.${table}`);
        expect(all[0]!.n, table).toBeGreaterThan(0);
        const none = await f.db.execute<{ n: number }>(
          sql.raw(`select count(*)::int as n from finet.${table}`),
        );
        expect(none[0]!.n, `${table} fără context`).toBe(0);
        const asB = await withRlsOn(f.db, { userId: f.B.userId, householdId: f.HB }, (tx) =>
          tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from finet.${table}`)),
        );
        expect(asB[0]!.n, `${table} ca B`).toBe(0);
        const asA = await withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, (tx) =>
          tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from finet.${table}`)),
        );
        expect(asA[0]!.n, `${table} ca A`).toBeGreaterThan(0);
      }
    });

    it("inserare cu gospodăria altcuiva → 42501 pe fiecare tabel", async () => {
      const inB = (statement: ReturnType<typeof sql>) =>
        sqlState(() =>
          withRlsOn(f.db, { userId: f.B.userId, householdId: f.HB }, (tx) => tx.execute(statement)),
        );
      const id = randomUUID();
      expect(
        await inB(sql`insert into finet.documents (id, household_id, detected_mime, size_bytes, sha256, storage_key)
          values (${id}, ${f.HA}, 'image/jpeg', 10, ${"a".repeat(64)}, ${`households/${f.HA}/documents/${id}`})`),
      ).toBe("42501");
      expect(
        await inB(
          sql`insert into finet.processing_batches (household_id, kind) values (${f.HA}, 'single')`,
        ),
      ).toBe("42501");
      expect(
        await inB(sql`insert into finet.ai_calls (household_id, task, model_alias, provider, duration_ms, result)
          values (${f.HA}, 'categorize', 'finet-text-external', 'external', 1, 'ok')`),
      ).toBe("42501");
      const [cat] = await f.admin<{ id: string }[]>`
        select id from finet.categories where household_id is null and kind = 'expense' limit 1`;
      expect(
        await inB(sql`insert into finet.product_aliases (household_id, normalized_name, category_id)
          values (${f.HA}, 'x', ${cat!.id})`),
      ).toBe("42501");
      // Bonul, linia și contorul zilei: tot 42501 cu gospodăria altcuiva.
      const docA = (await upload([["files", await receiptLikeImage({ seed: 70 })]])).documents[0]!;
      const [rcA] = await f.admin<{ id: string }[]>`
        insert into finet.receipts (household_id, document_id) values (${f.HA}, ${docA.id}) returning id`;
      expect(
        await inB(
          sql`insert into finet.receipts (household_id, document_id) values (${f.HA}, ${docA.id})`,
        ),
      ).toBe("42501");
      expect(
        await inB(sql`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name, line_total_minor)
          values (${rcA!.id}, ${f.HA}, 2, 'X', 1)`),
      ).toBe("42501");
      expect(
        await inB(sql`insert into finet.document_usage_daily (household_id, day, count)
          values (${f.HA}, date '2026-10-29', 0)`),
      ).toBe("42501");
    });

    it("CHECK: cheia de storage legată de id + gospodărie; SHA-256; tipuri; plafoane", async () => {
      const asA = (statement: ReturnType<typeof sql>) =>
        sqlState(() =>
          withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, (tx) => tx.execute(statement)),
        );
      const id = randomUUID();
      const ok = (over: Record<string, string>) => {
        const v = {
          key: `households/${f.HA}/documents/${id}`,
          mime: "image/jpeg",
          sha: "b".repeat(64),
          size: "10",
          ...over,
        };
        return sql`insert into finet.documents (id, household_id, detected_mime, size_bytes, sha256, storage_key)
          values (${id}, ${f.HA}, ${v.mime}, ${Number(v.size)}, ${v.sha}, ${v.key})`;
      };
      expect(await asA(ok({ key: `households/${f.HB}/documents/${id}` }))).toBe("23514");
      expect(await asA(ok({ key: `households/${f.HA}/documents/${randomUUID()}` }))).toBe("23514");
      expect(await asA(ok({ mime: "image/svg+xml" }))).toBe("23514");
      expect(await asA(ok({ sha: "XYZ" }))).toBe("23514");
      expect(await asA(ok({ size: "0" }))).toBe("23514");
      expect(await asA(ok({ size: String(200 * 1024 * 1024) }))).toBe("23514");
      expect(await asA(ok({}))).toBeNull();
      // Același SHA-256 în aceeași gospodărie → 23505 (deduplicarea exactă în bază).
      const id2 = randomUUID();
      expect(
        await asA(sql`insert into finet.documents (id, household_id, detected_mime, size_bytes, sha256, storage_key)
          values (${id2}, ${f.HA}, 'image/jpeg', 10, ${"b".repeat(64)}, ${`households/${f.HA}/documents/${id2}`})`),
      ).toBe("23505");
      // Bonul: CUI, încredere, motiv de trecere la extern; linia: total negativ, tip.
      const [rc] = await f.admin<{ id: string }[]>`
        insert into finet.receipts (household_id, document_id) values (${f.HA}, ${id}) returning id`;
      expect(
        await asA(sql`update finet.receipts set merchant_tax_id = 'RO12A' where id = ${rc!.id}`),
      ).toBe("23514");
      expect(await asA(sql`update finet.receipts set confidence = 101 where id = ${rc!.id}`)).toBe(
        "23514",
      );
      expect(
        await asA(sql`update finet.receipts set fallback_reason = 'oricare' where id = ${rc!.id}`),
      ).toBe("23514");
      expect(
        await asA(sql`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name, line_total_minor)
          values (${rc!.id}, ${f.HA}, 1, 'X', -1)`),
      ).toBe("23514");
      expect(
        await asA(sql`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name, line_total_minor, kind)
          values (${rc!.id}, ${f.HA}, 1, 'X', 1, 'vat_summary')`),
      ).toBe("23514");
    });

    it("triggere: categoria/eticheta altei gospodării → 23503; categorie de venit → 23514", async () => {
      const id = (await upload([["files", await receiptLikeImage({ seed: 51 })]])).documents[0]!.id;
      const [rc] = await f.admin<{ id: string }[]>`
        insert into finet.receipts (household_id, document_id) values (${f.HA}, ${id}) returning id`;
      const [bCat] = await f.admin<{ id: string }[]>`
        insert into finet.categories (household_id, name, kind) values (${f.HB}, 'Doar B', 'expense') returning id`;
      const [bTag] = await f.admin<{ id: string }[]>`
        insert into finet.tags (household_id, name) values (${f.HB}, 'Eticheta B') returning id`;
      const [income] = await f.admin<{ id: string }[]>`
        select id from finet.categories where household_id is null and kind = 'income' limit 1`;
      const [expense] = await f.admin<{ id: string }[]>`
        select id from finet.categories where household_id is null and kind = 'expense' limit 1`;
      const asA = (statement: ReturnType<typeof sql>) =>
        sqlState(() =>
          withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, (tx) => tx.execute(statement)),
        );
      const line = (
        cat: string,
      ) => sql`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name, line_total_minor, category_id)
        values (${rc!.id}, ${f.HA}, 1, 'PAINE', 450, ${cat})`;
      expect(await asA(line(bCat!.id))).toBe("23503");
      expect(await asA(line(income!.id))).toBe("23514");
      expect(await asA(line(expense!.id))).toBeNull();
      expect(
        await asA(sql`insert into finet.product_aliases (household_id, normalized_name, category_id)
          values (${f.HA}, 'paine', ${bCat!.id})`),
      ).toBe("23503");
      expect(
        await asA(sql`insert into finet.product_aliases (household_id, normalized_name, category_id, tag_ids)
          values (${f.HA}, 'paine', ${expense!.id}, ${`{${bTag!.id}}`}::uuid[])`),
      ).toBe("23503");
      expect(
        await asA(sql`insert into finet.product_aliases (household_id, normalized_name, category_id)
          values (${f.HA}, 'paine', ${expense!.id})`),
      ).toBeNull();
    });
  });
});
