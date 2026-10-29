import { deletionPreviewHandler } from "@/app/api/v1/_lib/gdpr-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Ce s-ar întâmpla la ștergerea contului (gospodării șterse, părăsite, blocate), fără sume. */
export const GET = (request: Request) => deletionPreviewHandler(request, getAuthRuntime());
