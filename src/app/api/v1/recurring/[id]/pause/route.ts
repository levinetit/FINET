import { pauseRecurringHandler } from "@/app/api/v1/_lib/recurring-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Pune regula pe pauză. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return pauseRecurringHandler(request, getAuthRuntime(), id);
}
