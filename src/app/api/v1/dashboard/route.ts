import { dashboardHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Dashboard-ul lunar, pe monedă (`?month=YYYY-MM`, implicit luna curentă). */
export const GET = (request: Request) => dashboardHandler(request, getAuthRuntime());
