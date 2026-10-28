import { changePasswordHandler } from "@/app/api/v1/_lib/me-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Schimbarea parolei (cere parola curentă; revocă celelalte sesiuni). */
export const POST = (request: Request) => changePasswordHandler(request, getAuthRuntime());
