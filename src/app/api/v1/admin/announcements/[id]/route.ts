import { adminUpdateAnnouncementHandler } from "@/app/api/v1/_lib/admin-handlers";
import { getAuthRuntime } from "@/modules/auth/auth";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

/** Faza 11-B (ADR 0028), doar `saas`. */
export const PATCH = async (request: Request, { params }: { params: Params }) =>
  adminUpdateAnnouncementHandler(request, getAuthRuntime(), (await params).id);
