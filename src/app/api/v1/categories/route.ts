import { createCategoryHandler, listCategoriesHandler } from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Categoriile de sistem și ale gospodăriei. */
export const GET = (request: Request) => listCategoriesHandler(request, getAuthRuntime());

/** Creează o categorie (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createCategoryHandler(request, getAuthRuntime());
