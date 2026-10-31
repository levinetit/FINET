import { meReferralHandler } from "@/app/api/v1/_lib/referral-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Faza 12-C (ADR 0037), doar `saas`. */
export const GET = (request: Request) => meReferralHandler(request, getAuthRuntime());
