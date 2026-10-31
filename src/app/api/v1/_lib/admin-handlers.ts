import "server-only";

import { NotFoundError } from "@/lib/authz";
import {
  adminAnnouncements,
  adminCreateAnnouncement,
  adminErrors,
  adminFeedback,
  adminHouseholds,
  adminJobs,
  adminSetFeedbackStatus,
  adminSetUserStatus,
  adminUpdateAnnouncement,
  adminUsers,
  createFeedback,
  listActiveAnnouncements,
  recordAppError,
} from "@/modules/admin/admin.service";

import {
  type ApiContext,
  type ApiDeps,
  json,
  readJsonBody,
  readQuery,
  routeId,
  handleAlways,
} from "./http";

/**
 * Feedback, anunțuri, raportarea erorilor și panoul de administrare (Faza 11-B, ADR 0028). TOATE
 * rutele există doar în modul `saas`: în `personal` răspund 404, ca și cum n-ar exista. Rutele
 * `/admin/*` răspund 404 (nu 403) și utilizatorilor care nu sunt administratori ai platformei
 * (verificarea o face serviciul, înaintea oricărei citiri). Nicio cerere nu primește `userId` sau
 * `householdId`; nimic financiar nu trece prin aceste rute.
 */

function saasOnly(d: ApiDeps): void {
  if (d.config.appMode !== "saas") throw new NotFoundError();
}

const guarded =
  (fn: (ctx: ApiContext, d: ApiDeps, request: Request) => Promise<Response>) =>
  (request: Request, d: ApiDeps): Promise<Response> =>
    handleAlways(request, d, async (ctx) => {
      saasOnly(d);
      return fn(ctx, d, request);
    });

export const createFeedbackHandler = guarded(async (ctx, d, request) => {
  const body = await readJsonBody(request);
  return json({ data: await createFeedback(d.db, ctx.actor.userId, body) }, 201);
});

export const listAnnouncementsHandler = guarded(async (ctx, d, request) => {
  readQuery(request, {});
  return json({ data: await listActiveAnnouncements(d.db, ctx.actor.userId) });
});

export const reportErrorHandler = guarded(async (ctx, d, request) => {
  const body = await readJsonBody(request);
  await recordAppError(d.db, ctx.actor.userId, body);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});

const PAGE_QUERY = { limit: "int", offset: "int", status: "string" } as const;

export const adminUsersHandler = guarded(async (ctx, d, request) =>
  json({ data: await adminUsers(d.db, ctx.actor.userId, readQuery(request, PAGE_QUERY)) }),
);
export const adminHouseholdsHandler = guarded(async (ctx, d, request) =>
  json({ data: await adminHouseholds(d.db, ctx.actor.userId, readQuery(request, PAGE_QUERY)) }),
);
export const adminJobsHandler = guarded(async (ctx, d, request) => {
  readQuery(request, {});
  return json({ data: await adminJobs(d.db, ctx.actor.userId) });
});
export const adminFeedbackHandler = guarded(async (ctx, d, request) =>
  json({ data: await adminFeedback(d.db, ctx.actor.userId, readQuery(request, PAGE_QUERY)) }),
);
export const adminErrorsHandler = guarded(async (ctx, d, request) => {
  readQuery(request, {});
  return json({ data: await adminErrors(d.db, ctx.actor.userId) });
});
export const adminAnnouncementsHandler = guarded(async (ctx, d, request) => {
  readQuery(request, {});
  return json({ data: await adminAnnouncements(d.db, ctx.actor.userId) });
});
export const adminCreateAnnouncementHandler = guarded(async (ctx, d, request) =>
  json(
    { data: await adminCreateAnnouncement(d.db, ctx.actor.userId, await readJsonBody(request)) },
    201,
  ),
);

type WithId = (request: Request, d: ApiDeps, id: string) => Promise<Response>;
const guardedById =
  (fn: (ctx: ApiContext, d: ApiDeps, request: Request, id: string) => Promise<Response>): WithId =>
  (request, d, id) =>
    handleAlways(request, d, async (ctx) => {
      saasOnly(d);
      return fn(ctx, d, request, routeId(id));
    });

export const adminSetUserStatusHandler = guardedById(async (ctx, d, request, id) =>
  json({ data: await adminSetUserStatus(d.db, ctx.actor.userId, id, await readJsonBody(request)) }),
);
export const adminSetFeedbackStatusHandler = guardedById(async (ctx, d, request, id) =>
  json({
    data: await adminSetFeedbackStatus(d.db, ctx.actor.userId, id, await readJsonBody(request)),
  }),
);
export const adminUpdateAnnouncementHandler = guardedById(async (ctx, d, request, id) =>
  json({
    data: await adminUpdateAnnouncement(d.db, ctx.actor.userId, id, await readJsonBody(request)),
  }),
);
