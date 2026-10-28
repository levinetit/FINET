import {
  deleteTransactionHandler,
  getTransactionHandler,
  patchTransactionHandler,
} from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** O tranzacție. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getTransactionHandler(request, getAuthRuntime(), id);
}

/** Modifică o tranzacție. */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return patchTransactionHandler(request, getAuthRuntime(), id);
}

/** Șterge o tranzacție (204). */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return deleteTransactionHandler(request, getAuthRuntime(), id);
}
