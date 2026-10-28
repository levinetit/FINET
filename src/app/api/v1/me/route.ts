import { getMeHandler, patchMeHandler } from "@/app/api/v1/_lib/me-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Profilul utilizatorului curent, preferințele și gospodăria curentă (cu rolul). */
export const GET = (request: Request) => getMeHandler(request, getAuthRuntime());

/** Nume și preferințe (Zod strict: `household_id`, `is_platform_admin` etc. sunt respinse). */
export const PATCH = (request: Request) => patchMeHandler(request, getAuthRuntime());
