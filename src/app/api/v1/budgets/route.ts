import { createBudgetHandler, listBudgetsHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Bugetele vizibile (ale gospodăriei și cele personale proprii). */
export const GET = (request: Request) => listBudgetsHandler(request, getAuthRuntime());

/** Creează un buget lunar (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createBudgetHandler(request, getAuthRuntime());
