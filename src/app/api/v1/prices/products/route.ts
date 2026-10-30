import { productsHandler } from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Produsele cumpărate, cu prețul mediu și cel mai ieftin comerciant (doar peste pragul de date). */
export const GET = (request: Request) => productsHandler(request, getAuthRuntime());
