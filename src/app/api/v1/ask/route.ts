import { askHandler } from "@/app/api/v1/_lib/ask-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** „Întreabă FINET” (F10-C). */
export const POST = (request: Request) => askHandler(request, getAuthRuntime());
