import { createGoalHandler, listGoalsHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Obiectivele de economisire (`?status=`). */
export const GET = (request: Request) => listGoalsHandler(request, getAuthRuntime());

/** Creează un obiectiv (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createGoalHandler(request, getAuthRuntime());
