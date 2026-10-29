import { deleteAccountHandler } from "@/app/api/v1/_lib/gdpr-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Ștergerea contului (GDPR): parola curentă + confirmarea „ȘTERGE”; ireversibilă. */
export const POST = (request: Request) => deleteAccountHandler(request, getAuthRuntime());
