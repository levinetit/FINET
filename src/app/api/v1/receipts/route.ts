import { listReceiptsHandler } from "@/app/api/v1/_lib/receipts-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Bonurile gospodăriei (filtre, căutare, cursor). */
export const GET = (request: Request) => listReceiptsHandler(request, getAuthRuntime());
