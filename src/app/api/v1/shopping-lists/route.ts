import {
  createShoppingListHandler,
  listShoppingListsHandler,
} from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Listele de cumpărături vizibile (comune + personale ale tale), cu numărătorile (`?status=`). */
export const GET = (request: Request) => listShoppingListsHandler(request, getAuthRuntime());

/** Creează o listă (comună sau `personal: true`), opțional cu articole (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createShoppingListHandler(request, getAuthRuntime());
