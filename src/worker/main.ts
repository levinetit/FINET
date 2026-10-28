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

export type WorkerOptions = Readonly<{
  databaseUrl: string;
  databaseCa: string | null;
  /** `config.database.allowInsecure` (doar teste/CI); implicit TLS verificat cu CA (`boss.ts`). */
  allowInsecure: boolean;
  log: LogFn;
}>;

export type RunningWorker = Readonly<{ boss: PgBoss; db: Db; stop: () => Promise<void> }>;

/** Codul unei erori, fără mesaj (mesajele Postgres pot conține valori din rânduri). */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "unknown";
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
  await boss.work(JOB_GENERATE, { localConcurrency: 1 }, async () => {
    const s = await handleGenerate(deps);
    return { rules: s.rules, generated: s.generated, failed: s.failed };
  });
  await boss.work(JOB_GENERATE_NOW, { localConcurrency: 1 }, async ([job]) => {
    const r = await handleGenerateNow(deps, job?.data);
    return "rejected" in r ? r : { rules: r.rules, generated: r.generated, failed: r.failed };
  });

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
