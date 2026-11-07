import { netWorthHandler } from "@/app/api/v1/_lib/net-worth-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Averea netă curentă și istoricul lunar (`?months=`), separat pe monedă (ADR 0046). */
export const GET = (request: Request) => netWorthHandler(request, getAuthRuntime());
