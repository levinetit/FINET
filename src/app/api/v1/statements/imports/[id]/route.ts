import { discardImportHandler, getImportHandler } from "@/app/api/v1/_lib/statements-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Previzualizarea / importul cu rândurile lui. */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return getImportHandler(request, getAuthRuntime(), id);
}

/** Renunță la o previzualizare neconfirmată. */
export async function DELETE(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return discardImportHandler(request, getAuthRuntime(), id);
}
