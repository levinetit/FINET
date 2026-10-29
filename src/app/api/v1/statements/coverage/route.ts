import { coverageHandler } from "@/app/api/v1/_lib/statements-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** „Acoperire extrase”: conturi × luni (`from`, `to` = AAAA-LL). */
export const GET = (request: Request) => coverageHandler(request, getAuthRuntime());
