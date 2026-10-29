import { listMembersHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Membrii gospodăriei curente (id, nume, rol). */
export const GET = (request: Request) => listMembersHandler(request, getAuthRuntime());
