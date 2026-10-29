import { listSplitsHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Ultimele împărțiri. */
export const GET = (request: Request) => listSplitsHandler(request, getAuthRuntime());
