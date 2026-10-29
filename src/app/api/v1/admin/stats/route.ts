import { usageStatsHandler } from "@/app/api/v1/_lib/gdpr-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Statisticile de utilizare (6.5), doar pentru administratorul platformei; fără date financiare. */
export const GET = (request: Request) => usageStatsHandler(request, getAuthRuntime());
