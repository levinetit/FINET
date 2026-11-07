import "server-only";

import type { Db } from "@/db";
import type { Mailer } from "@/modules/auth/mailer";
import {
  type EvaluateResult,
  evaluateForMember,
  selectNotificationTargets,
} from "@/modules/notifications/notifications.service";
import type { LogFn } from "@/worker/jobs";

/**
 * Jobul zilnic al notificărilor (modernizare 2026, pasul J; ADR 0048): pentru fiecare
 * (gospodărie, membru activ) din `finet.notification_targets`, evaluarea în contextul RLS al
 * membrului, apoi inserarea candidaților noi și, cu `email = true` și SMTP configurat, un digest.
 * Logurile: doar contoare și coduri de eroare, fără id-uri de utilizator sau conținut.
 */

export const JOB_NOTIFY_EVALUATE = "notify.evaluate";
/** Zilnic la 07:30, ora Bucureștiului (după generarea recurențelor de la :05; decizia mea). */
export const NOTIFY_CRON = "30 7 * * *";
export const NOTIFY_TARGETS_LIMIT = 10_000;

export type NotifyJobDeps = Readonly<{
  db: Db;
  log?: LogFn;
  now?: () => Date;
  mailer: Mailer | null;
  appUrl: string | null;
}>;

export type NotifySummary = Readonly<{
  targets: number;
  candidates: number;
  inserted: number;
  emailed: number;
  failed: number;
  skipped: number;
}>;

export async function handleNotifyEvaluate(deps: NotifyJobDeps): Promise<NotifySummary> {
  const targets = await selectNotificationTargets(deps.db, NOTIFY_TARGETS_LIMIT);
  const summary = {
    targets: targets.length,
    candidates: 0,
    inserted: 0,
    emailed: 0,
    failed: 0,
    skipped: 0,
  };
  for (const t of targets) {
    let r: EvaluateResult;
    try {
      r = await evaluateForMember(
        { db: deps.db, now: deps.now },
        { userId: t.userId },
        t.householdId,
        { mailer: deps.mailer, appUrl: deps.appUrl },
      );
    } catch (error) {
      summary.failed += 1;
      deps.log?.({ job: JOB_NOTIFY_EVALUATE, event: "member_failed", code: codeOf(error) });
      continue;
    }
    summary.candidates += r.candidates;
    summary.inserted += r.inserted;
    summary.emailed += r.emailed;
    if (r.skipped) summary.skipped += 1;
  }
  deps.log?.({ job: JOB_NOTIFY_EVALUATE, ...summary });
  return summary;
}

function codeOf(error: unknown): string {
  let e: unknown = error;
  for (let i = 0; i < 5 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return "unknown";
}
