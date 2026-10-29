import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";
import { type LedgerFixture, createLedgerFixture } from "@/modules/ledger/testing";
import { LocalStorage } from "@/lib/storage";
import { createRecurringRule } from "@/modules/recurring/recurring.service";

import { bossOptions } from "./boss";
import { GENERATE_CRON, JOB_GENERATE } from "./jobs";
import { enqueueGenerateNow, startWorker } from "./main";
import {
  JOB_RECEIPT_PROCESS,
  JOB_RECEIPT_SWEEP,
  RECEIPT_SWEEP_CRON,
} from "./receipts/receipt-jobs";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

/**
 * pg-boss REAL pe Postgres-ul efemer, conectat ca `finet_app` (rolul workerului), peste schema
 * creată de migrația 0007 (ca `finet_migrator`): pornire fără migrare/DDL, cozi, programare,
 * trimitere, procesare, oprire. Orice drept lipsă ar da 42501 aici.
 */
describe.skipIf(!TEST_ADMIN_URL)("pg-boss ca finet_app (Postgres real)", () => {
  let fx: AuthFixture;
  let boss: PgBoss;
  const errors: unknown[] = [];

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_pgboss");
    boss = new PgBoss({ ...bossOptions(fx.scratch.appUrl, null, { allowInsecure: true }), max: 2 });
    boss.on("error", (e) => errors.push(e));
    await boss.start();
  });
  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 2000 }).catch(() => {});
    await fx?.close();
  });

  it("pornește fără migrare: schema instalată, versiunea așteptată", async () => {
    expect(await boss.isInstalled()).toBe(true);
    expect(await boss.schemaVersion()).toBe(46);
  });

  it("creează o coadă, programează, trimite și procesează un job", async () => {
    await boss.createQueue("test.q", { policy: "stately", retryLimit: 1 });
    await boss.schedule("test.q", "0 * * * *", null, { tz: "Europe/Bucharest", key: "orar" });
    expect((await boss.getSchedules("test.q")).length).toBe(1);
    const done = new Promise<unknown>((resolve) => {
      void boss.work<{ n: number }>("test.q", async ([job]) => {
        resolve(job!.data);
        return { ok: true };
      });
    });
    await boss.send("test.q", { n: 1 }, { singletonKey: "k" });
    expect(await done).toEqual({ n: 1 });
    await boss.offWork("test.q");
  });

  it("supravegherea (mentenanța) rulează fără erori de drepturi", async () => {
    await boss.supervise();
    expect(errors.map((e) => String((e as { code?: string }).code ?? e))).toEqual([]);
  });

  it("finet_app nu poate face DDL și nu poate scrie în version/bam", async () => {
    const sql = fx.client;
    for (const statement of [
      "create table pgboss.x (id int)",
      "update pgboss.version set version = 47",
      "insert into pgboss.bam (name, version, table_name, command) values ('x', 1, 'job_common', 'select 1')",
      "drop table pgboss.job_common",
    ]) {
      await expect(sql.unsafe(statement)).rejects.toMatchObject({ code: "42501" });
    }
  });
});

/**
 * Workerul complet (`startWorker`) pe Postgres-ul efemer: cozi, programarea orară, semnalul de
 * viață, jobul la cerere procesat cap-coadă și oprirea grațioasă.
 */
describe.skipIf(!TEST_ADMIN_URL)("startWorker (pg-boss real, finet_app)", () => {
  let f: LedgerFixture;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_worker_boss");
    const acc = (
      await createAccount(f.deps, f.A, f.HA, { name: "Card", type: "bank", currency: "RON" })
    ).id;
    await createRecurringRule(f.deps, f.A, f.HA, {
      accountId: acc,
      type: "expense",
      amountMinor: 999,
      description: "Spotify",
      frequency: "monthly",
      startOn: "2026-01-05",
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  it("pornește, programează orar, scrie semnalul, procesează generate-now și se oprește curat", async () => {
    const w = await startWorker({
      databaseUrl: f.fx.scratch.appUrl,
      databaseCa: null,
      allowInsecure: true,
      log: (e) => logs.push({ ...e }),
    });
    try {
      const schedules = await w.boss.getSchedules(JOB_GENERATE);
      expect(schedules.map((s) => s.cron)).toEqual([GENERATE_CRON]);
      const [hb] = await f.admin<{ stopped: boolean }[]>`
        select stopped_at is not null as stopped from finet.service_heartbeats where service = 'worker'`;
      expect(hb).toEqual({ stopped: false });

      await enqueueGenerateNow(w.boss, f.HA, f.A.userId);
      const deadline = Date.now() + 30_000;
      let rows: readonly unknown[] = [];
      while (Date.now() < deadline) {
        rows = await f.admin`select 1 from finet.transactions where source = 'recurring'`;
        if (rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await w.stop();
    }
    const [hb] = await f.admin<{ stopped: boolean }[]>`
      select stopped_at is not null as stopped from finet.service_heartbeats where service = 'worker'`;
    expect(hb).toEqual({ stopped: true });
    expect(logs.map((l) => l.event).filter(Boolean)).toEqual(
      expect.arrayContaining(["started", "stopped"]),
    );
    expect(logs.filter((l) => l.event === "boss_error")).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("Spotify");
  });
});

/** Faza 6 (F6-B): cozile bonurilor pe schema reală pg-boss, ca `finet_app`. */
describe.skipIf(!TEST_ADMIN_URL)("startWorker cu bonurile (pg-boss real)", () => {
  let fx: AuthFixture;
  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_worker_rcpt");
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("receipt.sweep programat la minut; receipt.process `exclusive`: același document o singură dată în coadă", async () => {
    const w = await startWorker({
      databaseUrl: fx.scratch.appUrl,
      databaseCa: null,
      allowInsecure: true,
      log: () => {},
      receipts: {
        storage: new LocalStorage("/tmp/finet-nu-exista", { readOnly: true }),
        limits: {
          maxImagePixels: 50_000_000,
          maxPdfPages: 6,
          timeoutMs: 30_000,
          duplicateMaxDistance: 6,
        },
        ai: null,
      },
    });
    try {
      const schedules = await w.boss.getSchedules(JOB_RECEIPT_SWEEP);
      expect(schedules.map((s) => s.cron)).toEqual([RECEIPT_SWEEP_CRON]);
      const queue = await w.boss.getQueue(JOB_RECEIPT_PROCESS);
      expect(queue?.policy).toBe("exclusive");
      // Fără workerul pornit pe coadă între cele două trimiteri: a doua e respinsă (null).
      await w.boss.offWork(JOB_RECEIPT_PROCESS);
      const key = "00000000-0000-4000-8000-00000000abcd";
      const data = { documentId: key, householdId: key };
      expect(await w.boss.send(JOB_RECEIPT_PROCESS, data, { singletonKey: key })).not.toBeNull();
      expect(await w.boss.send(JOB_RECEIPT_PROCESS, data, { singletonKey: key })).toBeNull();
    } finally {
      await w.stop();
    }
  });
});
