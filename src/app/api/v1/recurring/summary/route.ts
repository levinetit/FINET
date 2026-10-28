import { recurringSummaryHandler } from "@/app/api/v1/_lib/recurring-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Contorul: reguli active · reguli scadente · total. */
export const GET = (request: Request) => recurringSummaryHandler(request, getAuthRuntime());
