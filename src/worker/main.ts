import "server-only";

import { PgBoss } from "pg-boss";

import { type Db, createDb } from "@/db";

import { bossOptions } from "./boss";
import { HEARTBEAT_INTERVAL_MS, heartbeatBeat, heartbeatStart, heartbeatStop } from "./heartbeat";
import {
  GENERATE_CRON,
  GENERATE_TZ,
  JOB_GENERATE,
  JOB_GENERATE_NOW,
  type LogFn,
  handleGenerate,
  handleGenerateNow,
} from "./jobs";
import type { DocumentJobDeps } from "./receipts/documents-job";
import {
  JOB_STATEMENT_PARSE,
  JOB_STATEMENT_SWEEP,
  STATEMENT_SWEEP_CRON,
  handleStatementParse,
  handleStatementSweep,
} from "./statements/statement-jobs";
import type { AiRuntime } from "./receipts/receipt-job";
import {
  JOB_RECEIPT_PROCESS,
  JOB_RECEIPT_SWEEP,
  RECEIPT_SWEEP_CRON,
  handleReceiptProcess,
  handleReceiptSweep,
} from "./receipts/receipt-jobs";

/**
 * Procesul worker (`FINET_ROLE=worker`, ADR 0011): pg-boss peste Postgres (schema `pgboss`,
 * creată de migrația 0007), conectat ca `finet_app` prin pooler-ul Supabase în modul SESIUNE
 * (5432), fără DDL la rulare. Două conexiuni-pool mici: `pg` pentru pg-boss și postgres.js
 * (Drizzle) pentru servicii, cu contextul RLS al fiecărei gospodării.
 *
 * - `recurring.generate`: programat orar (cron, `Europe/Bucharest`), coadă `singleton`: cel mult
 *   un job activ, deci două rulări nu se suprapun; în plus fiecare regulă e blocată
 *   `FOR UPDATE SKIP LOCKED`, iar ocurențele sunt unice în bază.
 * - `recurring.generate-now`: la cerere, pe gospodărie (`singletonKey` = gospodăria).
 * - reîncercări limitate (2, cu pauză), expirare 10 minute;
 * - semnalul de viață la 60 s (`finet.service_heartbeats`, citit de `/api/health`);
 * - bonurile (Faza 6, F6-B; ADR 0014), doar cu `receipts` în opțiuni: `receipt.sweep` (cron la
 *   fiecare minut, coadă `singleton`) trimite `receipt.process` pe document (coadă `exclusive`,
 *   `singletonKey` = documentul, concurență 1: un singur document în memorie odată);
 * - extrasele PDF (Faza 7, F7-B; ADR 0018 §11), doar cu `statements` în opțiuni: `statement.sweep`
 *   (cron la fiecare minut, `singleton`) trimite `statement.parse` pe încărcare (`exclusive`,
 *   `singletonKey` = încărcarea, concurență 1: un singur proces copil PDF odată); fără AI;
 * - oprire grațioasă la SIGTERM/SIGINT: pg-boss termină jobul curent (cel mult 25 s), apoi
 *   semnalul `stopped_at`, apoi închiderea conexiunilor.
 */

export const QUEUE_OPTIONS = {
  retryLimit: 2,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 600,
  retentionSeconds: 7 * 24 * 3600,
  deleteAfterSeconds: 7 * 24 * 3600,
} as const;

/**
 * Opțiunile cozii extraselor: o citire PDF durează ≤ 45 s (copilul are 30 s CPU); o singură
 * reîncercare (încercările sunt plafonate și în bază, la 3).
 */
export const STATEMENT_QUEUE_OPTIONS = {
  retryLimit: 1,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 300,
  retentionSeconds: 7 * 24 * 3600,
  deleteAfterSeconds: 7 * 24 * 3600,
} as const;

/** Opțiunile cozii bonurilor: preprocesare (≤ 60 s) + extragere + categorisire, cu reîncercări. */
export const RECEIPT_QUEUE_OPTIONS = {
  retryLimit: 1,
  retryDelay: 120,
  retryBackoff: true,
  expireInSeconds: 900,
  retentionSeconds: 7 * 24 * 3600,
  deleteAfterSeconds: 7 * 24 * 3600,
} as const;

export type ReceiptWorkerOptions = Readonly<{
  storage: DocumentJobDeps["storage"];
  limits: DocumentJobDeps["limits"];
  ai: AiRuntime | null;
}>;

export type WorkerOptions = Readonly<{
  databaseUrl: string;
  databaseCa: string | null;
  /** `config.database.allowInsecure` (doar teste/CI); implicit TLS verificat cu CA (`boss.ts`). */
  allowInsecure: boolean;
  log: LogFn;
  /** Procesarea bonurilor (Faza 6); fără ea, workerul face doar recurențele. */
  receipts?: ReceiptWorkerOptions;
  /** Citirea extraselor PDF (Faza 7); storage-ul doar pentru citire. */
  statements?: Readonly<{ storage: DocumentJobDeps["storage"] }>;
}>;

export type RunningWorker = Readonly<{ boss: PgBoss; db: Db; stop: () => Promise<void> }>;

/** Codul unei erori, fără mesaj (mesajele Postgres pot conține valori din rânduri). */
export function errorCode(error: unknown): string {
  // Drizzle învelește eroarea driverului (`cause`); se caută codul pe cel mult 5 niveluri.
  let e: unknown = error;
  for (let i = 0; i < 5 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return "unknown";
}

/**
 * Înfășoară handlerul unui job: orice eroare devine `Error("job_failed:<cod>")`, cu un cod fix
 * (SQLSTATE sau `unknown`), niciodată eroarea originală. pg-boss serializează eroarea aruncată în
 * `pgboss.job.output` (fără RLS, păstrat 7 zile, în backup), iar mesajul unei erori a bazei poate
 * conține parametrii interogării, adică date financiare (revizuirea F6-A+B).
 */
export function safeHandler<A extends unknown[], R>(
  job: string,
  log: LogFn,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      const code = errorCode(error);
      log({ event: "job_failed", job, code });
      throw new Error(`job_failed:${code}`);
    }
  };
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { log } = options;
  // Întâi validarea TLS (aruncă `PgTlsConfigError`), înainte de a deschide vreo conexiune.
  const bossConfig = bossOptions(options.databaseUrl, options.databaseCa, {
    allowInsecure: options.allowInsecure,
  });
  const { db, client } = createDb(options.databaseUrl, {
    ca: options.databaseCa,
    applicationName: "finet-worker",
    max: 2,
  });
  const boss = new PgBoss(bossConfig);
  boss.on("error", (error) => log({ event: "boss_error", code: errorCode(error) }));

  await boss.start();
  await boss.createQueue(JOB_GENERATE, { policy: "singleton", ...QUEUE_OPTIONS });
  await boss.createQueue(JOB_GENERATE_NOW, { policy: "singleton", ...QUEUE_OPTIONS });
  await boss.schedule(JOB_GENERATE, GENERATE_CRON, null, {
    tz: GENERATE_TZ,
    singletonKey: JOB_GENERATE,
  });

  const deps = { db, log };
  await boss.work(
    JOB_GENERATE,
    { localConcurrency: 1 },
    safeHandler(JOB_GENERATE, log, async () => {
      const s = await handleGenerate(deps);
      return { rules: s.rules, generated: s.generated, failed: s.failed };
    }),
  );
  await boss.work(
    JOB_GENERATE_NOW,
    { localConcurrency: 1 },
    safeHandler(JOB_GENERATE_NOW, log, async ([job]: { data?: unknown }[]) => {
      const r = await handleGenerateNow(deps, job?.data);
      return "rejected" in r ? r : { rules: r.rules, generated: r.generated, failed: r.failed };
    }),
  );

  const receipts = options.receipts;
  if (receipts) {
    await boss.createQueue(JOB_RECEIPT_SWEEP, { policy: "singleton", ...QUEUE_OPTIONS });
    await boss.createQueue(JOB_RECEIPT_PROCESS, { policy: "exclusive", ...RECEIPT_QUEUE_OPTIONS });
    await boss.schedule(JOB_RECEIPT_SWEEP, RECEIPT_SWEEP_CRON, null, {
      tz: GENERATE_TZ,
      singletonKey: JOB_RECEIPT_SWEEP,
    });
    const receiptDeps = {
      db,
      log,
      storage: receipts.storage,
      limits: receipts.limits,
      ai: receipts.ai,
    };
    await boss.work(
      JOB_RECEIPT_SWEEP,
      { localConcurrency: 1 },
      safeHandler(JOB_RECEIPT_SWEEP, log, async () => {
        const enqueued = await handleReceiptSweep(receiptDeps, (documentId, householdId) =>
          boss.send(
            JOB_RECEIPT_PROCESS,
            { documentId, householdId },
            { singletonKey: documentId.toLowerCase() },
          ),
        );
        return { enqueued };
      }),
    );
    await boss.work(
      JOB_RECEIPT_PROCESS,
      { localConcurrency: 1 },
      safeHandler(JOB_RECEIPT_PROCESS, log, async ([job]: { data?: unknown }[]) => {
        const r = await handleReceiptProcess(receiptDeps, job?.data);
        return "rejected" in r ? r : { outcome: r.outcome };
      }),
    );
  }

  const statements = options.statements;
  if (statements) {
    await boss.createQueue(JOB_STATEMENT_SWEEP, { policy: "singleton", ...QUEUE_OPTIONS });
    await boss.createQueue(JOB_STATEMENT_PARSE, {
      policy: "exclusive",
      ...STATEMENT_QUEUE_OPTIONS,
    });
    await boss.schedule(JOB_STATEMENT_SWEEP, STATEMENT_SWEEP_CRON, null, {
      tz: GENERATE_TZ,
      singletonKey: JOB_STATEMENT_SWEEP,
    });
    const statementDeps = { db, log, storage: statements.storage };
    await boss.work(
      JOB_STATEMENT_SWEEP,
      { localConcurrency: 1 },
      safeHandler(JOB_STATEMENT_SWEEP, log, async () => {
        const enqueued = await handleStatementSweep(statementDeps, (uploadId, householdId) =>
          boss.send(
            JOB_STATEMENT_PARSE,
            { uploadId, householdId },
            { singletonKey: uploadId.toLowerCase() },
          ),
        );
        return { enqueued };
      }),
    );
    await boss.work(
      JOB_STATEMENT_PARSE,
      { localConcurrency: 1 },
      safeHandler(JOB_STATEMENT_PARSE, log, async ([job]: { data?: unknown }[]) => {
        const r = await handleStatementParse(statementDeps, job?.data);
        if ("rejected" in r) return r;
        return r.outcome === "failed"
          ? { outcome: r.outcome, code: r.code }
          : { outcome: r.outcome };
      }),
    );
  }

  await heartbeatStart(db);
  const timer = setInterval(() => {
    heartbeatBeat(db).catch((e) => log({ event: "heartbeat_failed", code: errorCode(e) }));
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  log({ event: "started" });

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, timeout: 25_000 }).catch(() => {});
      await heartbeatStop(db).catch(() => {});
      await client.end({ timeout: 5 }).catch(() => {});
      log({ event: "stopped" });
    })();
    return stopping;
  };
  return { boss, db, stop };
}

/**
 * Trimite jobul la cerere (pentru F5-B sau unelte): unul singur pe gospodărie în așteptare
 * (`singletonKey`). Datele: doar id-urile gospodăriei și ale membrului.
 */
export async function enqueueGenerateNow(
  boss: PgBoss,
  householdId: string,
  userId: string,
): Promise<string | null> {
  return boss.send(
    JOB_GENERATE_NOW,
    { householdId, userId },
    { singletonKey: householdId.toLowerCase() },
  );
}
