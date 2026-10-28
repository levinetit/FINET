import {
  deleteAccountHandler,
  getAccountHandler,
  patchAccountHandler,
} from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Un cont, cu soldul calculat. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getAccountHandler(request, getAuthRuntime(), id);
}

/** Modifică un cont. */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchAccountHandler(request, getAuthRuntime(), id);
}

/** Șterge un cont gol (204); cu tranzacții → 409. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteAccountHandler(request, getAuthRuntime(), id);
}
