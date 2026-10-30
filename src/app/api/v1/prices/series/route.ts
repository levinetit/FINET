import { seriesHandler } from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Evoluția prețului unui produs (lunar sau săptămânal), generală și pe comerciant. */
export const GET = (request: Request) => seriesHandler(request, getAuthRuntime());
