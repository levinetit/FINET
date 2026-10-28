import { exportGoalsHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Exportul CSV al obiectivelor. */
export const GET = (request: Request) => exportGoalsHandler(request, getAuthRuntime());
