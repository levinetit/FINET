import { getConsentsHandler, putConsentsHandler } from "@/app/api/v1/_lib/me-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Consimțămintele utilizatorului curent. */
export const GET = (request: Request) => getConsentsHandler(request, getAuthRuntime());

/** Acordă sau revocă consimțăminte (auditat). */
export const PUT = (request: Request) => putConsentsHandler(request, getAuthRuntime());
