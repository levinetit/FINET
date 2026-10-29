import { balancesHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Soldurile reciproce și rezumatul utilizatorului. */
export const GET = (request: Request) => balancesHandler(request, getAuthRuntime());
