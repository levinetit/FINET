import { createRecurringHandler, listRecurringHandler } from "@/app/api/v1/_lib/recurring-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Regulile recurente ale gospodăriei (filtru opțional pe stare) și contorul lor. */
export const GET = (request: Request) => listRecurringHandler(request, getAuthRuntime());

/** Creează o regulă recurentă (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createRecurringHandler(request, getAuthRuntime());
