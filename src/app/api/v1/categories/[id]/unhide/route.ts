import { setCategoryHiddenHandler } from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Afișează din nou categoria. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return setCategoryHiddenHandler(request, getAuthRuntime(), id, false);
}
