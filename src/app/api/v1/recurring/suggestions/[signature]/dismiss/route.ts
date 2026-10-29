import { dismissSuggestionHandler } from "@/app/api/v1/_lib/matching-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ signature: string }> };

/** Respinge propunerea (se memorează doar amprenta ei). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { signature } = await context.params;
  return dismissSuggestionHandler(request, getAuthRuntime(), signature);
}
