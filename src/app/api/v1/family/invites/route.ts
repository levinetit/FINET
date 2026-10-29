import { createInviteHandler, listInvitesHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Invitațiile (fără tokenuri; doar owner). */
export const GET = (request: Request) => listInvitesHandler(request, getAuthRuntime());

/** Creează o invitație; tokenul apare doar în acest răspuns. */
export const POST = (request: Request) => createInviteHandler(request, getAuthRuntime());
