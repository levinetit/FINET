import { listSuggestionsHandler } from "@/app/api/v1/_lib/matching-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Plățile recurente detectate în istoric (propuneri; nimic creat automat). */
export const GET = (request: Request) => listSuggestionsHandler(request, getAuthRuntime());
