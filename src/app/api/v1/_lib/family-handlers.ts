import "server-only";

import { z } from "zod";

import { withRlsOn } from "@/db";
import { ValidationError } from "@/lib/errors";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import { requireSession } from "@/modules/auth/session";
import {
  balancesToJson,
  inviteToJson,
  memberToJson,
  settlementToJson,
  splitToJson,
} from "@/modules/family/family.schema";
import {
  acceptInvite,
  createInvite,
  listInvites,
  revokeInvite,
} from "@/modules/family/invites.service";
import {
  changeMemberRole,
  leaveHousehold,
  listMembers,
  removeMember,
  setActiveHousehold,
  transferOwnership,
} from "@/modules/family/members.service";
import {
  cancelSettlement,
  createSettlement,
  getBalances,
  listSettlements,
} from "@/modules/family/settlements.service";
import {
  clearTransactionSplit,
  getTransactionSplit,
  listSplits,
  setTransactionSplit,
} from "@/modules/family/splits.service";
import { type LiveMessage, subscribeLive } from "@/modules/live/live-bus";

import {
  ApiError,
  type ApiDeps,
  currentHousehold,
  handle,
  idempotencyKeyOf,
  idempotentCreate,
  json,
  parseWith,
  readJsonBody,
  readOptionalJsonBody,
  readQuery,
  routeId,
} from "./http";
import { householdAudience, notifyLive } from "./live";

/**
 * Handlerele familiei (Faza 8, F8-B; ADR 0016, 0017): membri, invitații, acceptarea, gospodăria
 * activă, împărțiri, solduri, decontări și fluxul de evenimente live. Aceleași reguli ca restul
 * `/api/v1` (ADR 0005): sesiune, CSRF pe mutațiile cu cookie, gospodăria din bază (niciodată din
 * cerere), Zod strict în servicii, 404 uniform, rate limiting.
 *
 * - **Invitația creată** întoarce tokenul în clar O SINGURĂ DATĂ. Crearea NU acceptă
 *   `Idempotency-Key` (decizia mea): răspunsul unei chei se memorează în `idempotency_keys`, deci
 *   tokenul ar ajunge în bază în clar. Duplicatele sunt limitate oricum (20/zi/gospodărie).
 * - **Acceptarea** (`POST /api/v1/invites/accept`, tokenul în corp, niciodată în URL-ul API-ului)
 *   rulează direct pe client (`acceptInvite` cere un `Db`: limita de rată e în afara tranzacției),
 *   fără `Idempotency-Key`: e natural idempotentă (a doua oară = deja membru, nimic consumat).
 * - **Împărțirea** se înlocuiește integral: `PUT /transactions/{id}/split` (idempotent prin natură).
 * - **Decontările**: `POST` cu `Idempotency-Key` opțional (replay).
 */

const noBody = () => json(null, 204);
const deps = (d: ApiDeps) => ({ db: d.db });
const emptyBody = z.strictObject({});

/**
 * Avertismentul de sold nedecontat (plecare / eliminare): serviciul poate întoarce
 * `{ unsettledBalance }`; o versiune care nu întoarce nimic înseamnă „fără avertisment”.
 */
function unsettledOf(result: unknown): boolean {
  return Boolean(
    result &&
    typeof result === "object" &&
    (result as { unsettledBalance?: unknown }).unsettledBalance,
  );
}

// --- Membrii ---------------------------------------------------------------------------------

export function listMembersHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const list = await listMembers(deps(d), ctx.actor, hh);
    return json({ data: list.map(memberToJson) });
  });
}

export function patchMemberHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const userId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await changeMemberRole(deps(d), ctx.actor, hh, userId, body);
    notifyLive(hh, "member", userId, householdAudience());
    return json({ data: memberToJson(view) });
  });
}

/** Un owner scoate alt membru; răspunsul spune dacă rămăseseră solduri nedecontate. */
export function deleteMemberHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const userId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    const result: unknown = await removeMember(deps(d), ctx.actor, hh, userId);
    notifyLive(hh, "member", userId, householdAudience());
    return json({ data: { unsettledBalance: unsettledOf(result) } });
  });
}

export function transferOwnershipHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const userId = routeId(id);
    parseWith(emptyBody, (await readOptionalJsonBody(request)) ?? {});
    const hh = await currentHousehold(ctx);
    const list = await transferOwnership(deps(d), ctx.actor, hh, userId);
    notifyLive(hh, "member", userId, householdAudience());
    return json({ data: list.map(memberToJson) });
  });
}

/** Utilizatorul pleacă din gospodăria CURENTĂ (cea activă). */
export function leaveHouseholdHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    parseWith(emptyBody, (await readOptionalJsonBody(request)) ?? {});
    const hh = await currentHousehold(ctx);
    const result: unknown = await leaveHousehold(deps(d), ctx.actor, hh);
    notifyLive(hh, "member", ctx.actor.userId, householdAudience());
    return json({ data: { unsettledBalance: unsettledOf(result) } });
  });
}

// --- Gospodăria activă -----------------------------------------------------------------------

export function setActiveHouseholdHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    return json({ data: await setActiveHousehold(deps(d), ctx.actor, body) });
  });
}

// --- Invitațiile -----------------------------------------------------------------------------

export function listInvitesHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const list = await listInvites(deps(d), ctx.actor, hh);
    return json({ data: list.map(inviteToJson) });
  });
}

/** Creează o invitație; tokenul în clar apare DOAR în acest răspuns (nu se stochează). */
export function createInviteHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    if (idempotencyKeyOf(request) !== null) {
      throw new ValidationError(
        { "Idempotency-Key": "Crearea invitațiilor nu acceptă Idempotency-Key." },
        "Antetul Idempotency-Key nu e acceptat aici.",
      );
    }
    const body = (await readOptionalJsonBody(request)) ?? {};
    const hh = await currentHousehold(ctx);
    const created = await createInvite(deps(d), ctx.actor, hh, body);
    return json(
      {
        data: {
          invite: inviteToJson(created.invite),
          token: created.token,
          joinPath: `/join/${created.token}`,
        },
      },
      201,
    );
  });
}

export function revokeInviteHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const inviteId = routeId(id);
    parseWith(emptyBody, (await readOptionalJsonBody(request)) ?? {});
    const hh = await currentHousehold(ctx);
    return json({ data: inviteToJson(await revokeInvite(deps(d), ctx.actor, hh, inviteId)) });
  });
}

/**
 * Acceptă invitația pentru utilizatorul autentificat. Orice token inutilizabil (inexistent,
 * malformat, expirat, folosit, revocat) → același 404 `invite_unavailable`; prea multe încercări
 * → 429 cu `Retry-After`. Nu întoarce numele gospodăriei (clientul îl citește după, ca membru).
 */
export function acceptInviteHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const result = await acceptInvite(
      { db: d.db, now: () => new Date(ctx.now), acceptLimit: ctx.limits.inviteAccept },
      ctx.actor,
      body,
    );
    if (result.joined) {
      notifyLive(result.householdId, "member", ctx.actor.userId, householdAudience());
    }
    return json({ data: { householdId: result.householdId, joined: result.joined } });
  });
}

// --- Împărțirile -----------------------------------------------------------------------------

export function listSplitsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { limit: "int" });
    const hh = await currentHousehold(ctx);
    const list = await listSplits(deps(d), ctx.actor, hh, query);
    return json({ data: list.map(splitToJson) });
  });
}

export function getSplitHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const transactionId = routeId(id);
    const hh = await currentHousehold(ctx);
    return json({
      data: splitToJson(await getTransactionSplit(deps(d), ctx.actor, hh, transactionId)),
    });
  });
}

export function putSplitHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const transactionId = routeId(id);
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    const view = await setTransactionSplit(deps(d), ctx.actor, hh, transactionId, body);
    notifyLive(hh, "split", transactionId, householdAudience());
    return json({ data: splitToJson(view) });
  });
}

export function deleteSplitHandler(request: Request, d: ApiDeps, id: string): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const transactionId = routeId(id);
    await readOptionalJsonBody(request);
    const hh = await currentHousehold(ctx);
    await clearTransactionSplit(deps(d), ctx.actor, hh, transactionId);
    notifyLive(hh, "split", transactionId, householdAudience());
    return noBody();
  });
}

// --- Soldurile și decontările ----------------------------------------------------------------

export function balancesHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    return json({ data: balancesToJson(await getBalances(deps(d), ctx.actor, hh)) });
  });
}

export function listSettlementsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const query = readQuery(request, { includeCancelled: "bool", limit: "int" });
    const hh = await currentHousehold(ctx);
    const list = await listSettlements(deps(d), ctx.actor, hh, query);
    return json({ data: list.map(settlementToJson) });
  });
}

export function createSettlementHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const body = await readJsonBody(request);
    const hh = await currentHousehold(ctx);
    let createdId: string | null = null;
    const response = await idempotentCreate(ctx, hh, body, async (db) => {
      const view = await createSettlement({ db }, ctx.actor, hh, body);
      createdId = view.id;
      return { status: 201, body: { data: settlementToJson(view) } };
    });
    // După COMMIT-ul cheii (nu din interiorul tranzacției): cine reîncarcă vede deja decontarea.
    if (createdId && response.ok) notifyLive(hh, "settlement", createdId, householdAudience());
    return response;
  });
}

export function cancelSettlementHandler(
  request: Request,
  d: ApiDeps,
  id: string,
): Promise<Response> {
  return handle(request, d, async (ctx) => {
    const settlementId = routeId(id);
    parseWith(emptyBody, (await readOptionalJsonBody(request)) ?? {});
    const hh = await currentHousehold(ctx);
    const view = await cancelSettlement(deps(d), ctx.actor, hh, settlementId);
    notifyLive(hh, "settlement", settlementId, householdAudience());
    return json({ data: settlementToJson(view) });
  });
}

// --- Evenimentele live (SSE) -----------------------------------------------------------------

/** Ritmul fluxului (decizia mea, ADR 0017); testele îl scurtează prin `ApiDeps.live`. */
export const LIVE_HEARTBEAT_MS = 25_000;
export const LIVE_LIFETIME_MS = 5 * 60_000;
export const LIVE_RETRY_MS = 5_000;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // `no-transform`: compresia Next (pachetul `compression`) nu bufferizează fluxul.
  "Cache-Control": "no-store, no-transform",
  // Proxy-urile de tip nginx; Traefik și Cloudflare nu bufferizează `text/event-stream`.
  "X-Accel-Buffering": "no",
} as const;

/**
 * `GET /api/v1/events`: Server-Sent Events pentru gospodăria CURENTĂ. Fiecare mesaj `change` are
 * DOAR `{ type, id }`. La fiecare puls (25 s, sub pragul de inactivitate al Cloudflare) se
 * reverifică sesiunea și apartenența (gospodăria curentă trebuie să fie aceeași); altfel fluxul
 * se închide cu `event: close`. Durata maximă 5 minute (`event: reconnect`), ca o sesiune revocată
 * sau un membru scos să nu rămână conectat. Plafon: 4 conexiuni per utilizator, 200 total (429).
 */
export function eventsHandler(request: Request, d: ApiDeps): Promise<Response> {
  return handle(request, d, async (ctx) => {
    readQuery(request, {});
    const hh = await currentHousehold(ctx);
    const heartbeatMs = d.live?.heartbeatMs ?? LIVE_HEARTBEAT_MS;
    const lifetimeMs = d.live?.lifetimeMs ?? LIVE_LIFETIME_MS;
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const pending: string[] = [];
    const write = (chunk: string) => {
      if (closed) return;
      if (!controller) {
        pending.push(chunk);
        return;
      }
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        close();
      }
    };
    const subscription = subscribeLive(hh, ctx.actor.userId, (m: LiveMessage) =>
      write(`event: change\ndata: ${JSON.stringify({ type: m.type, id: m.id })}\n\n`),
    );
    if (!subscription) {
      throw new ApiError(429, "rate_limited", "Prea multe conexiuni deschise.", {
        headers: { "Retry-After": "30" },
      });
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    function close(final?: string) {
      if (closed) return;
      if (final) write(final);
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (lifetime) clearTimeout(lifetime);
      subscription!.unsubscribe();
      request.signal.removeEventListener("abort", onAbort);
      try {
        controller?.close();
      } catch {
        // deja închis
      }
    }
    const onAbort = () => close();
    request.signal.addEventListener("abort", onAbort);

    let checking = false;
    const recheck = async () => {
      if (closed || checking) return;
      checking = true;
      try {
        const session = await requireSession(request, d);
        const current = await withRlsOn(d.db, { userId: session.userId }, (tx) =>
          currentHouseholdIdOf(tx, session.userId),
        );
        if (session.userId !== ctx.actor.userId || current !== hh) {
          close("event: close\ndata: {}\n\n");
          return;
        }
        write(": ping\n\n");
      } catch {
        close("event: close\ndata: {}\n\n");
      } finally {
        checking = false;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(`retry: ${LIVE_RETRY_MS}\nevent: ready\ndata: {}\n\n`));
        for (const chunk of pending.splice(0)) c.enqueue(encoder.encode(chunk));
        heartbeat = setInterval(() => void recheck(), heartbeatMs);
        lifetime = setTimeout(() => close("event: reconnect\ndata: {}\n\n"), lifetimeMs);
      },
      cancel() {
        close();
      },
    });
    if (request.signal.aborted) close();
    return new Response(stream, { status: 200, headers: SSE_HEADERS });
  });
}
