import { shoppingReceiptsHandler } from "@/app/api/v1/_lib/shopping-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Bonurile confirmate recente, pentru alegerea celui cu care se compară o listă. */
export const GET = (request: Request) => shoppingReceiptsHandler(request, getAuthRuntime());
