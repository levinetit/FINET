import { listImportsHandler } from "@/app/api/v1/_lib/statements-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Importurile de extrase (cele mai noi întâi), opțional pe un cont. */
export const GET = (request: Request) => listImportsHandler(request, getAuthRuntime());
