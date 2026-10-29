import { androidLatestHandler } from "@/app/api/v1/_lib/app-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Ultima versiune a aplicației Android (metadate; APK-ul e pe GitHub Releases). */
export const GET = (request: Request) => androidLatestHandler(request, getAuthRuntime());
