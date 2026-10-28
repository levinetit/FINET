import { resumeRecurringHandler } from "@/app/api/v1/_lib/recurring-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Reia regula (fără generarea retroactivă a scadențelor sărite). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return resumeRecurringHandler(request, getAuthRuntime(), id);
}
