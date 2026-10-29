import { createSettlementHandler, listSettlementsHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Decontările gospodăriei. */
export const GET = (request: Request) => listSettlementsHandler(request, getAuthRuntime());

/** Înregistrează o decontare (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createSettlementHandler(request, getAuthRuntime());
