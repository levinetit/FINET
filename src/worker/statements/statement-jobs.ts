import "server-only";

import { and, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { DbOrTx } from "@/db";
import { STATEMENT_UPLOAD_MAX_ATTEMPTS, statementUploads } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError } from "@/lib/errors";
import { type Storage, StorageNotFoundError, isKeyOfHousehold } from "@/lib/storage";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { parsePdfItems } from "@/modules/statements/detect";
import { createStatementPreview } from "@/modules/statements/statements.service";
import { StatementError } from "@/modules/statements/types";

import {
  STATEMENT_PDF_LIMITS,
  StatementPdfError,
  extractStatementPdfItems,
} from "./pdf-items-sandbox";

/**
 * Joburile extraselor PDF (F7-B; ADR 0018 §11), legate de pg-boss în `src/worker/main.ts`, pe
 * modelul bonurilor (ADR 0014), dar FĂRĂ coada AI a bonurilor:
 *
 * - `statement.sweep` (cron la fiecare minut, coadă `singleton`): încărcările în așteptare (funcția
 *   SECURITY DEFINER `queued_statement_uploads`, doar identificatori) → câte un `statement.parse`
 *   pe încărcare (`singletonKey` = încărcarea; coada `exclusive`).
 * - `statement.parse` (concurență 1: UN singur proces copil PDF odată, chiar și pentru un ZIP cu
 *   20 de PDF-uri; revizuirea F7-A): datele jobului (`uploadId`, `householdId`) se validează cu Zod
 *   strict și se RE-CITESC prin `queued_statement_upload` (gospodăria trebuie să coincidă; membrul
 *   vine din bază). Revendicarea numără o încercare ÎNAINTE de lucru (un PDF care omoară copilul nu
 *   e reluat la infinit: cel mult 3). Fișierul se citește din storage (doar citire), plafonat la
 *   mărimea înregistrată; elementele de text vin din procesul copil (prlimit, termen); parserul
 *   băncii produce previzualizarea ca membrul care a încărcat (RLS: cont personal ⇒ proprietarul).
 *   Cota a fost consumată la încărcare.
 *
 * Nimic din conținut nu ajunge în `pgboss.job` (doar id-uri) și nici în jurnal: rezultatul e
 * `{ outcome, code? }` cu coduri fixe; erorile neașteptate se transformă în `job_failed:<cod>` de
 * `safeHandler`.
 */

export const JOB_STATEMENT_SWEEP = "statement.sweep";
export const JOB_STATEMENT_PARSE = "statement.parse";
export const STATEMENT_SWEEP_CRON = "* * * * *";
export const STATEMENT_SWEEP_BATCH = 20;
/** Termenul de lucru: după el, o încărcare `processing` e reluată (worker oprit brusc). */
export const STATEMENT_PROCESSING_STALE_SECONDS = 15 * 60;

export const statementParseSchema = z.strictObject({
  uploadId: z.uuid(),
  householdId: z.uuid(),
});

export type StatementJobDeps = LedgerDeps &
  Readonly<{
    storage: Storage;
    log?: (event: Readonly<Record<string, string | number | boolean>>) => void;
    now?: () => Date;
    /** Doar teste: alt script copil / alt termen. */
    childScript?: string;
    timeoutMs?: number;
  }>;

export type UploadRef = Readonly<{ uploadId: string; householdId: string; actorUserId: string }>;

type RefRow = { upload_id: string; household_id: string; actor_user_id: string };
const refOf = (r: RefRow): UploadRef => ({
  uploadId: r.upload_id,
  householdId: r.household_id,
  actorUserId: r.actor_user_id,
});

export async function listQueuedUploads(db: DbOrTx, limit = STATEMENT_SWEEP_BATCH) {
  const rows = await db.execute<RefRow>(
    sql`select upload_id, household_id, actor_user_id
          from finet.queued_statement_uploads(${limit}::int, ${STATEMENT_PROCESSING_STALE_SECONDS}::int)`,
  );
  return rows.map(refOf);
}

async function selectQueuedUpload(db: DbOrTx, uploadId: string): Promise<UploadRef | null> {
  const rows = await db.execute<RefRow>(
    sql`select upload_id, household_id, actor_user_id
          from finet.queued_statement_upload(${uploadId}::uuid)`,
  );
  return rows[0] ? refOf(rows[0]) : null;
}

export type SendFn = (uploadId: string, householdId: string) => Promise<unknown>;

export async function handleStatementSweep(
  deps: Pick<StatementJobDeps, "db" | "log">,
  send: SendFn,
): Promise<number> {
  const queued = await listQueuedUploads(deps.db);
  for (const q of queued) await send(q.uploadId, q.householdId);
  deps.log?.({ job: JOB_STATEMENT_SWEEP, enqueued: queued.length });
  return queued.length;
}

export type StatementParseOutcome =
  | Readonly<{ outcome: "parsed" }>
  | Readonly<{ outcome: "failed"; code: string }>
  | Readonly<{ outcome: "skipped" }>;

const actorOf = (ref: UploadRef): Actor => ({ userId: ref.actorUserId });

/** Revendică încărcarea (încercare numărată înainte de lucru); `null` dacă e luată/terminată. */
async function claimUpload(deps: StatementJobDeps, ref: UploadRef, now: Date) {
  return inHousehold(deps, actorOf(ref), ref.householdId, async (tx) => {
    const staleBefore = new Date(now.getTime() - STATEMENT_PROCESSING_STALE_SECONDS * 1000);
    const [row] = await tx
      .select()
      .from(statementUploads)
      .where(
        and(
          eq(statementUploads.householdId, ref.householdId),
          eq(statementUploads.id, ref.uploadId),
          lt(statementUploads.attempts, STATEMENT_UPLOAD_MAX_ATTEMPTS),
          sql`${statementUploads.storageKey} is not null`,
          sql`(${statementUploads.status} = 'queued' or (${statementUploads.status} = 'processing' and (${statementUploads.processingStartedAt} is null or ${statementUploads.processingStartedAt} < ${staleBefore.toISOString()}::timestamptz)))`,
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);
    if (!row) return null;
    const [claimed] = await tx
      .update(statementUploads)
      .set({
        status: "processing",
        attempts: row.attempts + 1,
        processingStartedAt: now,
        errorCode: null,
        updatedAt: now,
      })
      .where(eq(statementUploads.id, row.id))
      .returning();
    return claimed ?? null;
  });
}

async function finish(
  deps: StatementJobDeps,
  ref: UploadRef,
  patch: { status: "parsed" | "failed"; errorCode: string | null; importId?: string },
): Promise<void> {
  await inHousehold(deps, actorOf(ref), ref.householdId, (tx) =>
    tx
      .update(statementUploads)
      .set({ ...patch, processingStartedAt: null, updatedAt: new Date() })
      .where(and(eq(statementUploads.id, ref.uploadId), eq(statementUploads.status, "processing"))),
  );
}

/** Codurile de domeniu care închid încărcarea ca `failed` (fără reîncercare). */
const DOMAIN_CONFLICTS = new Set([
  "statement_currency_mismatch",
  "account_archived",
  "statement_daily_limit",
]);

export async function processStatementUpload(
  deps: StatementJobDeps,
  ref: UploadRef,
): Promise<StatementParseOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  let row: Awaited<ReturnType<typeof claimUpload>>;
  try {
    row = await claimUpload(deps, ref, now);
  } catch (error) {
    if (error instanceof NotFoundError) return { outcome: "skipped" };
    throw error;
  }
  if (!row) return { outcome: "skipped" };

  const fail = async (code: string): Promise<StatementParseOutcome> => {
    await finish(deps, ref, { status: "failed", errorCode: code });
    deps.log?.({ job: JOB_STATEMENT_PARSE, outcome: "failed", code });
    return { outcome: "failed", code };
  };

  let bytes: Buffer;
  try {
    if (!row.storageKey || !isKeyOfHousehold(row.storageKey, ref.householdId)) {
      return fail("file_missing");
    }
    // Citire plafonată la mărimea înregistrată (un fișier înlocuit pe disc nu ocolește limita).
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of await deps.storage.openRead(row.storageKey)) {
      size += chunk.byteLength;
      if (size > row.sizeBytes) return fail("file_changed");
      parts.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(parts, size);
  } catch (error) {
    if (error instanceof StorageNotFoundError) return fail("file_missing");
    throw error;
  }
  if (bytes.byteLength !== row.sizeBytes) return fail("file_changed");

  try {
    const items = await extractStatementPdfItems(bytes, {
      deadline: Date.now() + (deps.timeoutMs ?? STATEMENT_PDF_LIMITS.cpuSeconds * 1000 + 15_000),
      ...(deps.childScript ? { childScript: deps.childScript } : {}),
    });
    const parsed = parsePdfItems(items);
    const preview = await createStatementPreview(
      { db: deps.db, now: () => now, quotaCharged: true },
      actorOf(ref),
      ref.householdId,
      { accountId: row.accountId, sourceSha256: row.sha256, parsed },
    );
    await finish(deps, ref, { status: "parsed", errorCode: null, importId: preview.import.id });
    deps.log?.({ job: JOB_STATEMENT_PARSE, outcome: "parsed" });
    return { outcome: "parsed" };
  } catch (error) {
    if (error instanceof StatementPdfError || error instanceof StatementError) {
      return fail(error.code);
    }
    if (error instanceof ConflictError && DOMAIN_CONFLICTS.has(error.reason)) {
      return fail(error.reason);
    }
    throw error;
  }
}

export async function handleStatementParse(
  deps: StatementJobDeps,
  data: unknown,
): Promise<StatementParseOutcome | { rejected: "invalid_data" | "not_found" }> {
  const parsed = statementParseSchema.safeParse(data);
  if (!parsed.success) {
    deps.log?.({ job: JOB_STATEMENT_PARSE, rejected: "invalid_data" });
    return { rejected: "invalid_data" };
  }
  const ref = await selectQueuedUpload(deps.db, parsed.data.uploadId);
  if (!ref || ref.householdId.toLowerCase() !== parsed.data.householdId.toLowerCase()) {
    deps.log?.({ job: JOB_STATEMENT_PARSE, rejected: "not_found" });
    return { rejected: "not_found" };
  }
  return processStatementUpload(deps, ref);
}
