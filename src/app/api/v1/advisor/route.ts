import { advisorHandler } from "@/app/api/v1/_lib/intelligence-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Consilierul financiar al lunii (`?month=`), separat pe monedă (ADR 0045). */
export const GET = (request: Request) => advisorHandler(request, getAuthRuntime());
