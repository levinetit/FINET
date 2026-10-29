import { leaveHouseholdHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Părăsește gospodăria curentă. */
export const POST = (request: Request) => leaveHouseholdHandler(request, getAuthRuntime());
