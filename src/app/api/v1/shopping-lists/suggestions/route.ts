import { shoppingSuggestionsHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Produsele cumpărate des (nume normalizate din bonurile confirmate), opțional după prefix (`?q=`). */
export const GET = (request: Request) => shoppingSuggestionsHandler(request, getAuthRuntime());
