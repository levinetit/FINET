import { exportTransactionsHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Exportul CSV al tranzacțiilor (filtrele listei), în flux. */
export const GET = (request: Request) => exportTransactionsHandler(request, getAuthRuntime());
