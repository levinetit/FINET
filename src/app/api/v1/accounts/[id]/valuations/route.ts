import {
  createValuationHandler,
  listValuationsHandler,
} from "@/app/api/v1/_lib/net-worth-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Evaluările contului (cele mai noi primele). */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return listValuationsHandler(request, getAuthRuntime(), id);
}

/** O evaluare nouă (`Idempotency-Key` opțional). */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return createValuationHandler(request, getAuthRuntime(), id);
}
