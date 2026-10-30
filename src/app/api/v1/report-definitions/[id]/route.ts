import {
  deleteReportDefinitionHandler,
  getReportDefinitionHandler,
  patchReportDefinitionHandler,
} from "@/app/api/v1/_lib/prices-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = async (request: Request, { params }: Context) =>
  getReportDefinitionHandler(request, getAuthRuntime(), (await params).id);

export const PATCH = async (request: Request, { params }: Context) =>
  patchReportDefinitionHandler(request, getAuthRuntime(), (await params).id);

export const DELETE = async (request: Request, { params }: Context) =>
  deleteReportDefinitionHandler(request, getAuthRuntime(), (await params).id);
