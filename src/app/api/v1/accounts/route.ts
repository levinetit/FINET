import { createAccountHandler, listAccountsHandler } from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Conturile gospodăriei curente, cu solduri calculate și totaluri pe monedă. */
export const GET = (request: Request) => listAccountsHandler(request, getAuthRuntime());

/** Creează un cont (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createAccountHandler(request, getAuthRuntime());
