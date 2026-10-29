import { setActiveHouseholdHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Setează gospodăria activă (apartenența verificată). */
export const PUT = (request: Request) => setActiveHouseholdHandler(request, getAuthRuntime());
