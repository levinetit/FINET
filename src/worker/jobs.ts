import "server-only";

import { z } from "zod";

import { NotFoundError } from "@/lib/authz";
import type { LedgerDeps } from "@/modules/ledger/context";
import {
  type GenerationSummary,
  generateDueForHousehold,
  runDueRecurring,
  todayLocal,
} from "@/modules/recurring/recurring.service";

/**
 * Joburile workerului (Faza 5; ADR 0011). Handlerele sunt funcții simple (apelate direct în
 * teste, fără pg-boss și fără rețea); `src/worker/main.ts` le leagă de cozi.
 *
 * Logurile (`log`) conțin doar numele jobului, contoare și coduri de eroare: fără sume,
 * descrieri, comercianți sau id-uri de gospodărie/utilizator.
 */

/** Jobul orar: toate scadențele (programat cu cron, o singură instanță activă). */
export const JOB_GENERATE = "recurring.generate";
/** Jobul la cerere: scadențele unei gospodării, în numele unui membru. */
export const JOB_GENERATE_NOW = "recurring.generate-now";
/** Cron-ul orar (minutul 5, ora Bucureștiului; decizia mea). */
export const GENERATE_CRON = "5 * * * *";
export const GENERATE_TZ = "Europe/Bucharest";

export type LogFn = (event: Readonly<Record<string, string | number | boolean>>) => void;

export type JobDeps = LedgerDeps & Readonly<{ now?: () => Date; log?: LogFn }>;

/** Datele jobului la cerere (validate: un job străin sau stricat nu ajunge în servicii). */
export const generateNowSchema = z.strictObject({
  householdId: z.uuid(),
  userId: z.uuid(),
});
export type GenerateNowData = z.infer<typeof generateNowSchema>;

function logSummary(log: LogFn | undefined, job: string, s: GenerationSummary): void {
  const event: Record<string, string | number | boolean> = {
    job,
    rules: s.rules,
    generated: s.generated,
    failed: s.failed,
    skipped: s.skipped,
  };
  for (const [code, n] of Object.entries(s.errors)) event[`error.${code}`] = n;
  log?.(event);
}

export async function handleGenerate(deps: JobDeps): Promise<GenerationSummary> {
  const today = todayLocal((deps.now ?? (() => new Date()))());
  const summary = await runDueRecurring(deps, today);
  logSummary(deps.log, JOB_GENERATE, summary);
  return summary;
}

/**
 * Generarea la cerere. Membrul trebuie să aparțină gospodăriei (verificat de serviciu, în bază):
 * altfel jobul se termină fără efect (`not_member`), fără reîncercări inutile.
 */
export async function handleGenerateNow(
  deps: JobDeps,
  data: unknown,
): Promise<GenerationSummary | { rejected: "invalid_data" | "not_member" }> {
  const parsed = generateNowSchema.safeParse(data);
  if (!parsed.success) {
    deps.log?.({ job: JOB_GENERATE_NOW, rejected: "invalid_data" });
    return { rejected: "invalid_data" };
  }
  const today = todayLocal((deps.now ?? (() => new Date()))());
  try {
    const summary = await generateDueForHousehold(
      deps,
      { userId: parsed.data.userId },
      parsed.data.householdId,
      today,
    );
    logSummary(deps.log, JOB_GENERATE_NOW, summary);
    return summary;
  } catch (error) {
    if (error instanceof NotFoundError) {
      deps.log?.({ job: JOB_GENERATE_NOW, rejected: "not_member" });
      return { rejected: "not_member" };
    }
    throw error;
  }
}
