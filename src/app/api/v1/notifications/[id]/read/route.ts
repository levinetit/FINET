import { readNotificationHandler } from "@/app/api/v1/_lib/notifications-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Marchează notificarea citită (idempotent). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return readNotificationHandler(request, getAuthRuntime(), id);
}
