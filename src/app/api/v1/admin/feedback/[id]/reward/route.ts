import { adminRewardFeedbackHandler } from "@/app/api/v1/_lib/admin-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

/** Faza 12-C, felia 3 (ADR 0037), doar `saas` și doar administratorul platformei. */
export const POST = async (request: Request, { params }: { params: Params }) =>
  adminRewardFeedbackHandler(request, getAuthRuntime(), (await params).id);
