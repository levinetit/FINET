import { monthlySummaryHandler } from "@/app/api/v1/_lib/summary-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Rezumatul lunii (F10-C). */
export const GET = (request: Request) => monthlySummaryHandler(request, getAuthRuntime());
