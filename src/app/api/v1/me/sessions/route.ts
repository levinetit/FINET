import { listSessionsHandler } from "@/app/api/v1/_lib/me-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Sesiunile active proprii (dispozitiv, IP trunchiat, ultima activitate; fără tokenuri). */
export const GET = (request: Request) => listSessionsHandler(request, getAuthRuntime());
