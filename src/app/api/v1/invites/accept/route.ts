import { acceptInviteHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Acceptă o invitație (tokenul în corp). */
export const POST = (request: Request) => acceptInviteHandler(request, getAuthRuntime());
