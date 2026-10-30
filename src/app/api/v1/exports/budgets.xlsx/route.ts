import { exportBudgetsXlsxHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Exportul Excel al bugetelor (F10-C). */
export const GET = (request: Request) => exportBudgetsXlsxHandler(request, getAuthRuntime());
