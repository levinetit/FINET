import { exportBudgetsHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Exportul CSV al bugetelor, cu starea lunii. */
export const GET = (request: Request) => exportBudgetsHandler(request, getAuthRuntime());
