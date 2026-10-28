import { createTransferHandler } from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Creează un transfer atomic (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createTransferHandler(request, getAuthRuntime());
