import "server-only";

import { withRlsOn } from "@/db";
import { type Storage, getStorage } from "@/lib/storage";
import { zipStream } from "@/lib/zip";
import { readAndroidRelease } from "@/modules/app-release/android";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import { hitRateLimit, rateLimitKey } from "@/modules/auth/rate-limit";
import { trustedClientIp } from "@/modules/auth/request";
import {
  AccountDeletionError,
  deleteAccount,
  previewAccountDeletion,
} from "@/modules/gdpr/account-deletion";
import {
  type ExportLimits,
  ExportTooLargeError,
  assertExportFits,
  dataExportEntries,
  estimateExport,
} from "@/modules/gdpr/data-export";
import { deleteAccountSchema } from "@/modules/gdpr/gdpr.schema";
import { getUsageStats } from "@/modules/usage/stats";

import {
  type ApiContext,
  ApiError,
  type ApiDeps,
  enforceRateLimit,
  handle,
  json,
  parseWith,
  readJsonBody,
  readQuery,
} from "./http";

/**
 * GDPR și statistici (Faza 9, F9-B, ADR 0021):
 * - `GET /api/v1/me/deletion`: ce s-ar întâmpla la ștergere (gospodării șterse / părăsite /
 *   blocate de regula ultimului owner), fără sume;
 * - `POST /api/v1/me/delete`: ștergerea contului (parola + „ȘTERGE”); CSRF ca orice mutație cu
 *   cookie; două limite: pe IP + utilizator (regula schimbării parolei) și doar pe utilizator (5/oră);
 * - `GET /api/v1/me/export`: arhiva ZIP în flux (JSON, CSV, fișierele bonurilor), doar cu
 *   `Sec-Fetch-Site: same-origin|none` pe cookie (ca exporturile CSV, LOW-2 din Faza 3) și 3/oră;
 * - `GET /api/v1/admin/stats`: statisticile (6.5), doar administratorul platformei (403 altfel).
 */

export type GdprApiDeps = ApiDeps &
  Readonly<{
    storage?: Storage;
    /** Doar pentru teste: limitele arhivei (implicit cele ale formatului ZIP fără ZIP64). */
    exportLimits?: ExportLimits;
  }>;

const storageOf = (d: GdprApiDeps): Storage => d.storage ?? getStorage();

export function deletionPreviewHandler(request: Request, d: GdprApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    return json({ data: await previewAccountDeletion(d.db, ctx.actor.userId) });
  });
}

const DELETION_STATUS: Readonly<Record<AccountDeletionError["code"], number>> = {
  invalid_password: 400,
  reauth_required: 403,
  last_owner: 409,
  platform_admin: 409,
  not_deletable: 409,
};

export function deleteAccountHandler(request: Request, d: GdprApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const ip = trustedClientIp(request.headers, {
      accessVerified: d.config.access.clientIpTrusted,
    });
    // Două limite (revizuirea F9): pe IP de încredere + utilizator (regula schimbării parolei) și
    // DOAR pe utilizator (5/oră), ca încercările să nu se poată împărți pe mai multe IP-uri.
    for (const [key, rule] of [
      [
        rateLimitKey("account_delete", ip, ctx.actor.userId),
        d.config.auth.rateLimits.passwordChange,
      ],
      [rateLimitKey("account_delete_user", null, ctx.actor.userId), ctx.limits.accountDelete],
    ] as const) {
      const limit = await hitRateLimit(d.db, key, rule, ctx.now);
      if (!limit.allowed) {
        throw new ApiError(
          429,
          "rate_limited",
          "Prea multe încercări. Încearcă din nou mai târziu.",
          { headers: { "Retry-After": String(limit.retryAfterSeconds) } },
        );
      }
    }
    const input = parseWith(deleteAccountSchema, await readJsonBody(request));
    try {
      const result = await deleteAccount(
        { db: d.db, storage: storageOf(d), now: () => new Date(ctx.now) },
        ctx.session,
        input,
      );
      return json({ data: result });
    } catch (error) {
      if (error instanceof AccountDeletionError) {
        throw new ApiError(DELETION_STATUS[error.code], error.code, error.message, {
          ...(error.code === "invalid_password" ? { fields: { password: error.message } } : {}),
        });
      }
      throw error;
    }
  });
}

function assertDownloadFetchSite(ctx: ApiContext): void {
  if (ctx.session.viaBearer) return;
  const site = ctx.request.headers.get("sec-fetch-site");
  if (site !== "same-origin" && site !== "none") {
    throw new ApiError(403, "forbidden", "Cerere refuzată.");
  }
}

/** Numele arhivei: fix, fără date ale utilizatorului. */
export const EXPORT_ARCHIVE_NAME = "finet-export.zip";

export function dataExportHandler(request: Request, d: GdprApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    assertDownloadFetchSite(ctx);
    await enforceRateLimit(ctx, "gdpr_export", ctx.limits.gdprExport);
    const userId = ctx.actor.userId;
    // Revizuirea F9: limitele ZIP se verifică ÎNAINTE de flux (413 cu cod fix), nu la jumătate.
    try {
      assertExportFits(await estimateExport(d.db, userId), d.exportLimits);
    } catch (error) {
      if (error instanceof ExportTooLargeError) {
        throw new ApiError(413, "export_too_large", error.message);
      }
      throw error;
    }
    const auditHousehold = await withRlsOn(d.db, { userId }, (tx) =>
      currentHouseholdIdOf(tx, userId),
    );
    const gen = zipStream(
      dataExportEntries({ db: d.db, storage: storageOf(d) }, userId, auditHousehold),
      new Date(ctx.now),
    );
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await gen.next();
          if (cancelled) return;
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch {
          if (cancelled) return;
          console.error("[api] export GDPR întrerupt");
          controller.error(new Error("export întrerupt"));
        }
      },
      async cancel() {
        cancelled = true;
        await gen.return(undefined).catch(() => {});
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${EXPORT_ARCHIVE_NAME}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

export function usageStatsHandler(request: Request, d: GdprApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const latestAndroid = await readAndroidRelease(d.config.storage.dir).catch(() => null);
    return json({
      data: await getUsageStats(d.db, ctx.actor.userId, {
        appMode: d.config.appMode,
        latestAndroid,
      }),
    });
  });
}
