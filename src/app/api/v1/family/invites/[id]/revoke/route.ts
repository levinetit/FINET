import { revokeInviteHandler } from "@/app/api/v1/_lib/family-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Revocă o invitație activă. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return revokeInviteHandler(request, getAuthRuntime(), id);
}
