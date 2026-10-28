import { appEventsHandler } from "@/app/api/v1/_lib/me-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Evenimentele de utilizare (listă fixă; fără consimțământ nu se stochează). */
export const POST = (request: Request) => appEventsHandler(request, getAuthRuntime());
