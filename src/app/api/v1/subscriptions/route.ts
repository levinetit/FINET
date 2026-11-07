import { subscriptionsHandler } from "@/app/api/v1/_lib/intelligence-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Abonamentele: regulile recurente de cheltuieli normalizate lunar/anual + cele detectate (ADR 0047). */
export const GET = (request: Request) => subscriptionsHandler(request, getAuthRuntime());
