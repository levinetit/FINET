import {
  createTransactionHandler,
  listTransactionsHandler,
} from "@/app/api/v1/_lib/ledger-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Tranzacțiile: filtre, căutare, sortare, cursor. */
export const GET = (request: Request) => listTransactionsHandler(request, getAuthRuntime());

/** Creează un venit sau o cheltuială (`Idempotency-Key` opțional). */
export const POST = (request: Request) => createTransactionHandler(request, getAuthRuntime());
