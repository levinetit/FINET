import { deleteValuationHandler } from "@/app/api/v1/_lib/net-worth-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; valuationId: string }> };

/** Șterge o evaluare a contului. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id, valuationId } = await context.params;
  return deleteValuationHandler(request, getAuthRuntime(), id, valuationId);
}
