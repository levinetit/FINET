import "server-only";

import type { DbOrTx } from "@/db";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import {
  notificationToJson,
  preferencesToJson,
} from "@/modules/notifications/notifications.schema";
import {
  getPreferences,
  listNotifications,
  markAllRead,
  markNotificationRead,
  removeNotification,
  setPreferences,
} from "@/modules/notifications/notifications.service";

import {
  type ApiContext,
  type ApiDeps,
  currentHousehold,
  handle,
  handleAlways,
  json,
  readJsonBody,
  readOptionalJsonBody,
  readQuery,
  routeId,
} from "./http";

/**
 * Notificările și preferințele lor (modernizare 2026, pasul J; ADR 0048). Citirile și marcajele
 * merg și cu abonament expirat (`handleAlways`): utilizatorul trebuie să-și poată citi avertizările.
 */

function planning(db: DbOrTx, ctx: ApiContext): PlanningDeps {
  return { db, now: () => new Date(ctx.now) };
}

/** `GET /api/v1/notifications?unread=&limit=` — cele mai noi primele, cu numărul de necitite. */
export function listNotificationsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handleAlways(request, d, async (ctx) => {
    const query = readQuery(request, { unread: "bool", limit: "int" });
    const hh = await currentHousehold(ctx);
    const r = await listNotifications(planning(d.db, ctx), ctx.actor, hh, {
      ...(query.unread === undefined ? {} : { unread: query.unread }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return json({ data: r.data.map(notificationToJson), unread: r.unread });
  });
}

/** `POST /api/v1/notifications/{id}/read` — marchează citită (idempotent). */
export function readNotificationHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handleAlways(request, d, async (ctx) => {
    const nid = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await markNotificationRead(planning(d.db, ctx), ctx.actor, hh, nid);
    return json(null, 204);
  });
}

/** `POST /api/v1/notifications/read-all` — marchează toate citite. */
export function readAllNotificationsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handleAlways(request, d, async (ctx) => {
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const updated = await markAllRead(planning(d.db, ctx), ctx.actor, hh);
    return json({ data: { updated } });
  });
}

/** `DELETE /api/v1/notifications/{id}` — șterge notificarea. */
export function deleteNotificationHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handleAlways(request, d, async (ctx) => {
    const nid = routeId(id);
    const hh = await currentHousehold(ctx);
    await removeNotification(planning(d.db, ctx), ctx.actor, hh, nid);
    return json(null, 204);
  });
}

/** `GET /api/v1/me/notification-preferences`. */
export function getNotificationPreferencesHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handleAlways(request, d, async (ctx) =>
    json({ data: preferencesToJson(await getPreferences(d.db, ctx.actor.userId)) }),
  );
}

/** `PUT /api/v1/me/notification-preferences` — `inApp`, `email`, `kinds`. */
export function putNotificationPreferencesHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handleAlways(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const row = await setPreferences(d.db, ctx.actor.userId, body);
    return json({ data: preferencesToJson(row) });
  });
}

export { handle };
