import { deleteSessionHandler } from "@/app/api/v1/_lib/me-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Revocă o sesiune proprie (204); sesiunea altcuiva sau inexistentă → 404. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return deleteSessionHandler(request, getAuthRuntime(), id);
}
