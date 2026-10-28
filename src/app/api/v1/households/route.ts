import { listHouseholdsHandler } from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Gospodăriile utilizatorului curent, cu rolul. */
export const GET = (request: Request) => listHouseholdsHandler(request, getAuthRuntime());
