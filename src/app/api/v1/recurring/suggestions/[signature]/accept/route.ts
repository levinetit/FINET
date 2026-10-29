import { acceptSuggestionHandler } from "@/app/api/v1/_lib/matching-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ signature: string }> };

/** Acceptă propunerea: creează regula de recurență (`Idempotency-Key` opțional). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { signature } = await context.params;
  return acceptSuggestionHandler(request, getAuthRuntime(), signature);
}
