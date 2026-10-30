import {
  createReportDefinitionHandler,
  listReportDefinitionsHandler,
} from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

/** Rapoartele de micro-cheltuieli: cele de sistem și cele ale gospodăriei. */
export const GET = (request: Request) => listReportDefinitionsHandler(request, getAuthRuntime());

/** Creează un raport propriu (reguli de potrivire pe numele produselor). */
export const POST = (request: Request) => createReportDefinitionHandler(request, getAuthRuntime());
