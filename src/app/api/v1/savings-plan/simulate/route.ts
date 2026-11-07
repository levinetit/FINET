import { simulateSavingsHandler } from "@/app/api/v1/_lib/intelligence-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Simularea unui plan de economisire, fără scriere (ADR 0047). */
export const POST = (request: Request) => simulateSavingsHandler(request, getAuthRuntime());
