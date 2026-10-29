import { eventsHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Evenimentele live (SSE): doar tip + id. */
export const GET = (request: Request) => eventsHandler(request, getAuthRuntime());
