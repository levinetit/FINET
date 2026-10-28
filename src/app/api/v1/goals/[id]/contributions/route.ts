import { contributeGoalHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O contribuție sau o retragere (`Idempotency-Key` obligatoriu). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return contributeGoalHandler(request, getAuthRuntime(), id);
}
