import { getHouseholdHandler } from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O gospodărie a utilizatorului, cu membrii (id, nume, rol; fără emailuri). */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getHouseholdHandler(request, getAuthRuntime(), id);
}
