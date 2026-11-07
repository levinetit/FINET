import { forecastHandler } from "@/app/api/v1/_lib/intelligence-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Prognoza de cash-flow la 30/60/90 de zile (`?days=`), separat pe monedă (ADR 0045). */
export const GET = (request: Request) => forecastHandler(request, getAuthRuntime());
