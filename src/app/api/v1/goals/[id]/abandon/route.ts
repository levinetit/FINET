import { abandonGoalHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Renunță la obiectiv (contribuțiile se blochează până la reluare). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return abandonGoalHandler(request, getAuthRuntime(), id);
}
