import "server-only";

import { sql } from "drizzle-orm";

import type { DbOrTx } from "@/db";

/**
 * Semnalul de viață al workerului (`finet.service_heartbeats`, migrația 0006), citit de
 * `/api/health` (verificarea `queue`) fără ca serverul web să depindă de pg-boss (ADR 0011).
 * Rândul nu conține date de gospodărie: doar momentele pornirii, ultimului semnal și opririi.
 */

export const WORKER_SERVICE = "worker";
/** Cât de des scrie workerul semnalul (decizia mea). */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** Peste acest prag fără semnal (3 intervale), coada e „degradată”. */
export const HEARTBEAT_STALE_SECONDS = 180;

/** La pornire: rândul workerului, cu `stopped_at` șters. */
export async function heartbeatStart(db: DbOrTx): Promise<void> {
  await db.execute(sql`
    insert into finet.service_heartbeats (service, beat_at, started_at, stopped_at)
    values (${WORKER_SERVICE}, now(), now(), null)
    on conflict (service) do update
      set beat_at = excluded.beat_at, started_at = excluded.started_at, stopped_at = null`);
}

export async function heartbeatBeat(db: DbOrTx): Promise<void> {
  await db.execute(sql`
    update finet.service_heartbeats set beat_at = now(), stopped_at = null
     where service = ${WORKER_SERVICE}`);
}

/** La oprirea grațioasă: coada apare apoi ca `unknown` (oprită intenționat), nu degradată. */
export async function heartbeatStop(db: DbOrTx): Promise<void> {
  await db.execute(sql`
    update finet.service_heartbeats set stopped_at = now() where service = ${WORKER_SERVICE}`);
}

export type QueueState = "ok" | "degraded" | "unknown";

/**
 * Starea cozii din semnal: fără rând sau oprit grațios → `unknown`; semnal mai vechi de
 * `HEARTBEAT_STALE_SECONDS` → `degraded`; altfel `ok`. Funcție pură (vârsta în secunde).
 */
export function queueStateOf(
  row: Readonly<{ ageSeconds: number; stopped: boolean }> | null,
): QueueState {
  if (!row || row.stopped) return "unknown";
  return row.ageSeconds <= HEARTBEAT_STALE_SECONDS ? "ok" : "degraded";
}
