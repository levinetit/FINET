import { deleteNotificationHandler } from "@/app/api/v1/_lib/notifications-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Șterge o notificare. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteNotificationHandler(request, getAuthRuntime(), id);
}
