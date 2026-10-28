import { budgetStatusHandler } from "@/app/api/v1/_lib/planning-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Starea bugetelor într-o lună (semafor) și avertizările. */
export const GET = (request: Request) => budgetStatusHandler(request, getAuthRuntime());
