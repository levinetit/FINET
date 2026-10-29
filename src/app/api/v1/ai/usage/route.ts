import { aiUsageHandler } from "@/app/api/v1/_lib/documents-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Contorul zilei: „X din Y documente azi”. */
export const GET = (request: Request) => aiUsageHandler(request, getAuthRuntime());
