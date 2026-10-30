import { completeRegisterHandler } from "@/app/api/v1/_lib/register-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Faza 11-C (ADR 0029): înregistrarea publică, pasul 2 (confirmarea emailului și parola). */
export const POST = (request: Request) => completeRegisterHandler(request, getAuthRuntime());
