import { savingsPlanHandler } from "@/app/api/v1/_lib/intelligence-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Planul de economisire: obiectivele active cu rata necesară și fondul de urgență (ADR 0047). */
export const GET = (request: Request) => savingsPlanHandler(request, getAuthRuntime());
