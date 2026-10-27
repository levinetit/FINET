import { runHealthChecks, type HealthReport } from "@/app/api/health/checks";
import { getConfig } from "@/lib/config";
import { getStorage } from "@/lib/storage";

/**
 * `GET /api/health`: starea bazei de date, a storage-ului, a cozii și a furnizorului AI.
 * Protejat de `src/proxy.ts`: e nevoie de JWT Cloudflare Access sau de `X-Finet-Health-Token`.
 * 200 pentru `ok`/`degraded`, 503 pentru `down`. Răspunsul nu conține versiuni, căi, host sau
 * mesaje de eroare.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let report: HealthReport;
  try {
    const config = getConfig();
    let storage = null;
    try {
      storage = getStorage();
    } catch {
      storage = null;
    }
    report = await runHealthChecks({
      databaseUrl: config.database.url,
      storage,
      diskDir: config.storage.dir,
    });
  } catch {
    report = {
      status: "down",
      checks: { db: "unknown", storage: "unknown", queue: "unknown", ai: "unknown" },
    };
  }
  return Response.json(report, {
    status: report.status === "down" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
