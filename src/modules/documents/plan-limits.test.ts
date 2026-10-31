import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import { NotFoundError } from "@/lib/authz";
import { PlanRestrictedError } from "@/lib/errors";
import { LocalStorage } from "@/lib/storage";
import { testConfig } from "@/modules/auth/testing";
import { createEntitlements, receiptHistoryMonths } from "@/modules/entitlements";
import { type LedgerFixture, createLedgerFixture } from "@/modules/ledger/testing";
import { listReceipts, getReceipt } from "@/modules/receipts/receipts.service";
import { listQueuedDocuments } from "@/worker/receipts/documents-job";

import { type DocumentsDeps, uploadDocuments } from "./documents.service";
import { multipartRequest, receiptLikeImage, textPdf } from "./testing";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/**
 * Limitele de plan din 12-A.2 (ADR 0035), pe Postgres real: dimensiunea și tipul fișierului,
 * istoricul de bonuri vizibil și prioritatea în coada workerului. `saas`, planuri scrise ca
 * `finet_migrator` (aplicația nu le poate scrie).
 */
describe.skipIf(!TEST_ADMIN_URL)("12-A.2: limite de plan (Postgres real)", () => {
  let f: LedgerFixture;
  let migrator: ReturnType<typeof testClient>;
  let root: string;
  let storage: LocalStorage;
  const config = testConfig({ APP_MODE: "saas" });

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_plan_limits");
    migrator = testClient(f.fx.scratch.migratorUrl, 1);
    root = await realpath(await mkdtemp(join(tmpdir(), "finet-plan-")));
    storage = new LocalStorage(root);
  });
  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await f?.close();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await f.admin`delete from finet.documents`;
    await f.admin`delete from finet.processing_batches`;
    await f.admin`delete from finet.consents`;
    await f.admin`delete from finet.document_usage_daily`;
    await f.admin`delete from finet.subscriptions`;
    await f.admin`delete from finet.plans`;
    await rm(join(root, "households"), { recursive: true, force: true });
  });

  const deps = (): DocumentsDeps => ({
    ...f.deps,
    storage,
    config,
    entitlements: createEntitlements("saas", config, f.db),
  });
  const files = (household: string) =>
    readdir(join(root, "households", household.toLowerCase(), "documents")).catch(() => []);

  async function planFor(
    household: string,
    values: { limits?: Record<string, number>; features?: string[] },
  ) {
    const code = `p${Math.random().toString(36).slice(2, 9)}`;
    const [row] = await migrator<{ id: string }[]>`
      insert into finet.plans (code, name, limits, features)
      values (${code}, ${code}, ${migrator.json((values.limits ?? {}) as never)},
              ${values.features ?? []}::text[]) returning id`;
    await migrator`
      insert into finet.subscriptions (household_id, plan_id, status, provider)
      values (${household}, ${row!.id}, 'active', 'manual')
      on conflict (household_id) do update set plan_id = excluded.plan_id, status = 'active'`;
  }
  const allTypes = ["documents.jpeg", "documents.png", "documents.webp", "documents.pdf"];
  const bigLimits = { "ai.dailyDocuments": 50, "storage.quotaMb": 5000 };

  describe("dimensiunea și tipul fișierului", () => {
    it("planul fără documents.maxFileMb nu primește nimic (FAIL CLOSED); fișierul nu rămâne pe disc", async () => {
      await planFor(f.HA, { limits: bigLimits, features: allTypes });
      const jpg = await receiptLikeImage();
      await expect(
        uploadDocuments(
          deps(),
          f.A,
          f.HA,
          await multipartRequest([["files", jpg, "bon.jpg", "image/jpeg"]]),
        ),
      ).rejects.toThrow();
      expect(await files(f.HA)).toEqual([]);
    });

    it("peste dimensiunea planului → respins; sub ea → primit (limita tehnică rămâne plafon)", async () => {
      const jpg = await receiptLikeImage();
      const sizeMb = Math.ceil(jpg.length / (1024 * 1024));
      // Plan cu 1 MB: bonul de test (sub 1 MB) trece; un plan cu 0 MB nu lasă nimic.
      await planFor(f.HA, {
        limits: { ...bigLimits, "documents.maxFileMb": Math.max(1, sizeMb) },
        features: allTypes,
      });
      const ok = await uploadDocuments(
        deps(),
        f.A,
        f.HA,
        await multipartRequest([["files", jpg, "bon.jpg", "image/jpeg"]]),
      );
      expect(ok.created).toBe(1);
      await planFor(f.HA, {
        limits: { ...bigLimits, "documents.maxFileMb": 0 },
        features: allTypes,
      });
      await expect(
        uploadDocuments(
          deps(),
          f.A,
          f.HA,
          await multipartRequest([["files", jpg, "alt-bon.jpg", "image/jpeg"]]),
        ),
      ).rejects.toThrow();
    });

    it("tip de fișier neinclus în plan → PlanRestrictedError, fișierele scrise se șterg", async () => {
      await planFor(f.HA, {
        limits: { ...bigLimits, "documents.maxFileMb": 10 },
        features: ["documents.jpeg", "documents.png"], // fără PDF
      });
      await expect(
        uploadDocuments(
          deps(),
          f.A,
          f.HA,
          await multipartRequest([["files", textPdf(), "bon.pdf", "application/pdf"]]),
        ),
      ).rejects.toBeInstanceOf(PlanRestrictedError);
      expect(await files(f.HA)).toEqual([]);
      // JPEG-ul, inclus în plan, trece.
      const ok = await uploadDocuments(
        deps(),
        f.A,
        f.HA,
        await multipartRequest([["files", await receiptLikeImage(), "bon.jpg", "image/jpeg"]]),
      );
      expect(ok.created).toBe(1);
    });

    it("`personal` nu e afectat: același cod, fără planuri, primește PDF-ul", async () => {
      const personalConfig = testConfig();
      const personalDeps: DocumentsDeps = {
        ...f.deps,
        storage,
        config: personalConfig,
        entitlements: createEntitlements("personal", personalConfig, f.db),
      };
      const ok = await uploadDocuments(
        personalDeps,
        f.A,
        f.HA,
        await multipartRequest([["files", textPdf(), "bon.pdf", "application/pdf"]]),
      );
      expect(ok.created).toBe(1);
    });
  });

  async function uploadImage(household: string, actor: typeof f.A, seed: number) {
    const r = await uploadDocuments(
      deps(),
      actor,
      household,
      await multipartRequest([
        ["files", await receiptLikeImage({ seed }), `bon-${seed}.jpg`, "image/jpeg"],
      ]),
    );
    return r.documents[0]!.id;
  }

  describe("istoricul de bonuri vizibil", () => {
    async function receiptFor(household: string, documentId: string, ageMonths: number) {
      const [row] = await f.admin<{ id: string }[]>`
        insert into finet.receipts (household_id, document_id, created_at)
        values (${household}, ${documentId}, now() - make_interval(months => ${ageMonths}))
        returning id`;
      return row!.id;
    }
    const rdeps = () => ({ ...deps() });

    it("receiptHistoryMonths: doar în saas, plan viu, fără arhivă permanentă, cheie > 0", async () => {
      await planFor(f.HA, { limits: { "receipts.historyMonths": 3 } });
      expect(await receiptHistoryMonths("saas", f.db, f.HA)).toBe(3);
      expect(await receiptHistoryMonths("personal", f.db, f.HA)).toBeNull();
      await planFor(f.HA, {
        limits: { "receipts.historyMonths": 3 },
        features: ["receipts.archive"],
      });
      expect(await receiptHistoryMonths("saas", f.db, f.HA)).toBeNull();
      await planFor(f.HA, { limits: { "receipts.historyMonths": 0 } });
      expect(await receiptHistoryMonths("saas", f.db, f.HA)).toBeNull();
      await planFor(f.HA, { limits: {} });
      expect(await receiptHistoryMonths("saas", f.db, f.HA)).toBeNull();
      // Abonament expirat: datele rămân vizibile (citire și export).
      await planFor(f.HA, { limits: { "receipts.historyMonths": 3 } });
      await migrator`update finet.subscriptions set status = 'expired' where household_id = ${f.HA}`;
      expect(await receiptHistoryMonths("saas", f.db, f.HA)).toBeNull();
    });

    it("lista și detaliul ascund bonurile mai vechi decât istoricul planului", async () => {
      await planFor(f.HA, {
        limits: { ...bigLimits, "documents.maxFileMb": 10, "receipts.historyMonths": 3 },
        features: allTypes,
      });
      const recent = await receiptFor(f.HA, await uploadImage(f.HA, f.A, 1), 1);
      const old = await receiptFor(f.HA, await uploadImage(f.HA, f.A, 2), 6);
      const list = await listReceipts(rdeps(), f.A, f.HA, {});
      expect(list.data.map((r) => r.id)).toEqual([recent]);
      await expect(getReceipt(rdeps(), f.A, f.HA, old)).rejects.toBeInstanceOf(NotFoundError);
      expect((await getReceipt(rdeps(), f.A, f.HA, recent)).id).toBe(recent);

      // Plan cu arhivă permanentă: ambele bonuri se văd.
      await planFor(f.HA, {
        limits: { ...bigLimits, "receipts.historyMonths": 3 },
        features: ["receipts.archive"],
      });
      const all = await listReceipts(rdeps(), f.A, f.HA, {});
      expect(all.data.map((r) => r.id).sort()).toEqual([recent, old].sort());
      expect((await getReceipt(rdeps(), f.A, f.HA, old)).id).toBe(old);
    });
  });

  describe("prioritatea în coada workerului (queue.priority)", () => {
    const setup = { "documents.maxFileMb": 10, ...bigLimits };
    const consent = (userId: string) =>
      f.admin`insert into finet.consents (user_id, kind) values (${userId}, 'external_ai')
        on conflict do nothing`;

    it("în același rând de echitate, planul cu prioritate mai mare e primul, chiar dacă e mai nou", async () => {
      await planFor(f.HA, { limits: { ...setup, "queue.priority": 0 }, features: allTypes });
      await planFor(f.HB, { limits: { ...setup, "queue.priority": 10 }, features: allTypes });
      await consent(f.A.userId);
      await consent(f.B.userId);
      const low = await uploadImage(f.HA, f.A, 3); // mai vechi, prioritate 0
      const high = await uploadImage(f.HB, f.B, 4); // mai nou, prioritate 10
      const queue = await listQueuedDocuments(f.db, 10);
      expect(queue.map((q) => q.documentId)).toEqual([high, low]);
    });

    it("fără prioritate în plan ordinea rămâne cea veche: după vechime", async () => {
      await planFor(f.HA, { limits: setup, features: allTypes });
      await planFor(f.HB, { limits: setup, features: allTypes });
      await consent(f.A.userId);
      await consent(f.B.userId);
      const first = await uploadImage(f.HA, f.A, 5);
      const second = await uploadImage(f.HB, f.B, 6);
      const queue = await listQueuedDocuments(f.db, 10);
      expect(queue.map((q) => q.documentId)).toEqual([first, second]);
    });

    it("echitatea rămâne prima: al doilea document al unei gospodării cu prioritate mare nu trece peste primul al altora", async () => {
      await planFor(f.HA, { limits: { ...setup, "queue.priority": 0 }, features: allTypes });
      await planFor(f.HB, { limits: { ...setup, "queue.priority": 100 }, features: allTypes });
      await consent(f.A.userId);
      await consent(f.B.userId);
      const a1 = await uploadImage(f.HA, f.A, 7);
      const b1 = await uploadImage(f.HB, f.B, 8);
      const b2 = await uploadImage(f.HB, f.B, 9);
      const order = (await listQueuedDocuments(f.db, 10)).map((q) => q.documentId);
      // Rândul 1: B (prioritate 100) înaintea lui A; rândul 2 (al doilea al lui B) vine ultimul.
      expect(order).toEqual([b1, a1, b2]);
    });
  });

  describe("planul fondator (12-D): limite „fără plafon”", () => {
    it("o încărcare reală merge cu valoarea maximă întreagă pe toate limitele (comparații în JS, nimic în SQL)", async () => {
      const MAX = Number.MAX_SAFE_INTEGER;
      await planFor(f.HA, {
        limits: {
          "ai.dailyDocuments": MAX,
          "storage.quotaMb": MAX,
          "household.maxMembers": MAX,
          "documents.maxFileMb": MAX,
        },
        features: [...allTypes, "receipts.archive"],
      });
      const jpg = await receiptLikeImage();
      const out = await uploadDocuments(
        deps(),
        f.A,
        f.HA,
        await multipartRequest([["files", jpg, "bon.jpg", "image/jpeg"]]),
      );
      expect(out.created).toBe(1);
      expect(await files(f.HA)).toHaveLength(1);
    });
  });
});
