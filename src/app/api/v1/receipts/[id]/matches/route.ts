import { decideMatchHandler, receiptMatchesHandler } from "@/app/api/v1/_lib/matching-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Tranzacțiile din extras propuse pentru bon (scor și motive). */
export async function GET(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return receiptMatchesHandler(request, getAuthRuntime(), id);
}

/** Decizia utilizatorului: confirmă (leagă bonul) sau respinge o propunere. */
export async function POST(request: Request, context: Ctx): Promise<Response> {
  const { id } = await context.params;
  return decideMatchHandler(request, getAuthRuntime(), id);
}
