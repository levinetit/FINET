import { createTagHandler, listTagsHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Etichetele de sistem și ale gospodăriei, cu numărul de utilizări (`?includeHidden=true`). */
export const GET = (request: Request) => listTagsHandler(request, getAuthRuntime());

/** Creează o etichetă (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createTagHandler(request, getAuthRuntime());
