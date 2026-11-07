import { fxRatesHandler } from "@/app/api/v1/_lib/intelligence-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Cursurile BCE cele mai recente (`?date=`), baza EUR (ADR 0049). */
export const GET = (request: Request) => fxRatesHandler(request, getAuthRuntime());
