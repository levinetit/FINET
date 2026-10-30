import { inflationHandler } from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Inflația personală: estimare din bonurile confirmate, pe articole cumpărate în ambele perioade. */
export const GET = (request: Request) => inflationHandler(request, getAuthRuntime());
