import { registerHandler } from "@/app/api/v1/_lib/register-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Faza 11-C (ADR 0029): înregistrarea publică, pasul 1. Doar `saas` cu `SIGNUP_ENABLED=1`. */
export const POST = (request: Request) => registerHandler(request, getAuthRuntime());
