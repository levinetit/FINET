import { getAuthRuntime } from "@/modules/auth/auth";
import { handleAuthRequest } from "@/modules/auth/handler";

// Better Auth (`/api/auth/*`), prin intrarea FINET (src/modules/auth/handler.ts). Cererea a
// trecut deja de src/proxy.ts (JWT Cloudflare Access, fail closed).
export const dynamic = "force-dynamic";

const handle = (request: Request) => handleAuthRequest(request, getAuthRuntime());

export const GET = handle;
export const POST = handle;
