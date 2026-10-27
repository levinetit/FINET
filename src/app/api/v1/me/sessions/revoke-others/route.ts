import { revokeOthersHandler } from "@/app/api/v1/_lib/me-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Revocă toate sesiunile proprii, în afară de cea curentă. */
export const POST = (request: Request) => revokeOthersHandler(request, getAuthRuntime());
