import { matchQueueHandler } from "@/app/api/v1/_lib/matching-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Coada potrivirilor: bonurile cu tranzacții din extras propuse. */
export const GET = (request: Request) => matchQueueHandler(request, getAuthRuntime());
