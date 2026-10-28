import { generateRecurringHandler } from "@/app/api/v1/_lib/recurring-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Generează tranzacțiile scadente ale gospodăriei curente (`Idempotency-Key` obligatoriu). */
export const POST = (request: Request) => generateRecurringHandler(request, getAuthRuntime());
