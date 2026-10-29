import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { liveConnectionsOf } from "@/modules/live/live-bus";

import type { ApiDeps } from "./_lib/http";
import * as F from "./_lib/family-handlers";
import * as L from "./_lib/ledger-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Acceptarea F8-B prin API (handlere reale, PostgreSQL real, aplicația ca `finet_app`): invitațiile
 * (tokenul o singură dată, fără `Idempotency-Key`, răspuns uniform, limită de rată 429), rolurile
 * (403 pentru member), gospodăria activă, împărțirea (409 `transaction_split` la modificarea sumei
 * și la ștergere), soldurile și decontările parțiale (replay cu cheie), evenimentele live (doar
 * tip + id, fără tranzacțiile din contul personal al altuia, plafonul de conexiuni, curățarea la
 * abort), plecarea și ultimul owner. Contractul OpenAPI se verifică la fiecare răspuns.
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;
type Member = { userId: string; name: string; role: string };
type Balances = {
  currencies: {
    currency: string;
    pairs: { debtorUserId: string; creditorUserId: string; amountMinor: number }[];
  }[];
  me: { currency: string; owesMinor: number; owedMinor: number }[];
};

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1 familie pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  let A: Sessions; // owner HA
  let B: Sessions; // owner HB, apoi member în HA
  let C: Sessions; // owner HC, din afară
  let idA: string;
  let idB: string;
  let idC: string;
  let hhA: string;
  let hhB: string;
  let hhC: string;
  const PASS = "parola-familie-12345";
  let keySeq = 0;
  const newKey = () => `familie-cheie-${String(++keySeq).padStart(6, "0")}`;

  async function callWith(
    deps: ApiDeps,
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ): Promise<{ status: number; body: Body; res: Response }> {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      deps,
      ...rest,
    );
    await assertContract(handler, res);
    const text = await res.clone().text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {}, res };
  }
  const call = (handler: Handler, path: string, init: ApiInit, ...rest: string[]) =>
    callWith(env, handler, path, init, ...rest);

  async function newInvite(s: Sessions) {
    const r = await call(F.createInviteHandler, "/api/v1/family/invites", {
      bearer: s.bearer,
      method: "POST",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as { invite: { id: string }; token: string; joinPath: string };
  }

  const accept = (s: Sessions, token: unknown, deps: ApiDeps = env) =>
    callWith(deps, F.acceptInviteHandler, "/api/v1/invites/accept", {
      bearer: s.bearer,
      body: { token },
    });

  const balances = async (s: Sessions) => {
    const r = await call(F.balancesHandler, "/api/v1/family/balances", { bearer: s.bearer });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as Balances;
  };

  /** Deschide fluxul SSE și întoarce un cititor de evenimente `change`. */
  async function openEvents(s: Sessions, deps: ApiDeps = env) {
    const abort = new AbortController();
    const request = new Request(apiRequest("/api/v1/events", { bearer: s.bearer }), {
      signal: abort.signal,
    });
    const res = await F.eventsHandler(request, deps);
    await assertContract(F.eventsHandler, res);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    async function next(ms = 1500): Promise<string | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return frame;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        // O singură citire în zbor: o citire abandonată la timeout ar pierde bucata următoare.
        inflight ??= reader.read();
        const chunk = await Promise.race([
          inflight,
          new Promise<null>((r) => setTimeout(() => r(null), left)),
        ]);
        if (chunk === null) return null;
        inflight = null;
        if (chunk.done) return buffer.length > 0 ? buffer : "__end__";
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    /** Următorul `change` (sărind ping-urile), ca obiect; `null` dacă nu vine nimic. */
    async function nextChange(ms = 1500): Promise<{ type: string; id: string } | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const frame = await next(Math.max(1, deadline - Date.now()));
        if (frame === null || frame === "__end__") return null;
        if (frame.includes("event: change")) {
          const data = frame
            .split("\n")
            .find((l) => l.startsWith("data: "))!
            .slice(6);
          return JSON.parse(data) as { type: string; id: string };
        }
      }
    }
    const first = await next();
    expect(first).toContain("event: ready");
    expect(first).toContain("retry: 5000");
    return { next, nextChange, abort: () => abort.abort(), reader };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_family_api");
    env = {
      ...authEnv(fx.db),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        inviteAccept: { max: 1000, windowSeconds: 60 },
      },
    };
    const mk = async (email: string, name: string) =>
      createUserWithHousehold(fx.db, {
        email,
        name,
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
    const a = await mk("ana@exemplu.ro", "Ana");
    const b = await mk("bogdan@exemplu.ro", "Bogdan");
    const c = await mk("cora@exemplu.ro", "Cora");
    idA = a.userId;
    idB = b.userId;
    idC = c.userId;
    hhA = a.householdId!;
    hhB = b.householdId!;
    hhC = c.householdId!;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    C = await sessionsFor(env, "cora@exemplu.ro", PASS);
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("fără sesiune → 401 pe rutele noi", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const cases: [Handler, string, ApiInit, ...string[]][] = [
      [F.listMembersHandler, "/api/v1/family/members", {}],
      [F.createInviteHandler, "/api/v1/family/invites", { method: "POST" }],
      [F.acceptInviteHandler, "/api/v1/invites/accept", { body: { token: "x" } }],
      [F.balancesHandler, "/api/v1/family/balances", {}],
      [F.listSettlementsHandler, "/api/v1/family/settlements", {}],
      [F.getSplitHandler, `/api/v1/transactions/${id}/split`, {}, id],
      [F.setActiveHouseholdHandler, "/api/v1/households/active", { method: "PUT", body: {} }],
      [F.eventsHandler, "/api/v1/events", {}],
    ];
    for (const [h, path, init, ...rest] of cases) {
      expect((await call(h, path, init, ...rest)).status, path).toBe(401);
    }
  });

  it("invitația: tokenul doar la creare, fără Idempotency-Key, listare fără token, member → 403", async () => {
    const created = await newInvite(A);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.joinPath).toBe(`/join/${created.token}`);

    const keyed = await call(F.createInviteHandler, "/api/v1/family/invites", {
      bearer: A.bearer,
      method: "POST",
      headers: { "idempotency-key": newKey() },
    });
    expect(keyed.status).toBe(400);
    // Tokenul nu ajunge niciodată în tabela de idempotență (nici hash-ul, nici textul).
    const stored = await fx.scratch.admin`
      select count(*)::int as n from finet.idempotency_keys k
       where row_to_json(k)::text like ${`%${created.token}%`}`;
    expect(stored[0]!.n).toBe(0);

    const list = await call(F.listInvitesHandler, "/api/v1/family/invites", { bearer: A.bearer });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(created.token);
    expect((list.body.data as { id: string; status: string }[])[0]!.status).toBe("active");

    // B (owner în gospodăria LUI) nu vede invitațiile lui A.
    const bList = await call(F.listInvitesHandler, "/api/v1/family/invites", { bearer: B.bearer });
    expect(JSON.stringify(bList.body)).not.toContain(created.invite.id);
  });

  it("acceptarea: intră și devine activă; a doua oară / token greșit / revocat → același 404; deja membru nu consumă", async () => {
    const inv = await newInvite(A);
    const ok = await accept(B, inv.token);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toEqual({ householdId: hhA, joined: true });

    const hs = await call(L.listHouseholdsHandler, "/api/v1/households", { bearer: B.bearer });
    const current = (hs.body.data as { id: string; current: boolean }[]).find((h) => h.current);
    expect(current?.id).toBe(hhA);

    const again = await accept(C, inv.token);
    const wrong = await accept(C, "A".repeat(43));
    const malformed = await accept(C, "scurt");
    const revoked = await newInvite(A);
    expect(
      (
        await call(
          F.revokeInviteHandler,
          `/api/v1/family/invites/${revoked.invite.id}/revoke`,
          { bearer: A.bearer, method: "POST" },
          revoked.invite.id,
        )
      ).status,
    ).toBe(200);
    const afterRevoke = await accept(C, revoked.token);
    for (const r of [again, wrong, malformed, afterRevoke]) {
      expect(r.status).toBe(404);
      expect(r.body.error).toEqual(again.body.error);
      expect(r.body.error?.code).toBe("invite_unavailable");
    }

    // Deja membru: `joined: false`, invitația rămâne activă (pentru cel invitat).
    const spare = await newInvite(A);
    const member = await accept(B, spare.token);
    expect(member.body.data).toEqual({ householdId: hhA, joined: false });
    const list = await call(F.listInvitesHandler, "/api/v1/family/invites", { bearer: A.bearer });
    const row = (list.body.data as { id: string; status: string }[]).find(
      (i) => i.id === spare.invite.id,
    );
    expect(row?.status).toBe("active");
  });

  it("limita de rată a acceptării → 429 cu Retry-After (și pentru tokenurile greșite)", async () => {
    const strict = {
      ...env,
      limits: { ...env.limits, inviteAccept: { max: 2, windowSeconds: 600 } },
    };
    await accept(C, "B".repeat(43), strict);
    await accept(C, "C".repeat(43), strict);
    const r = await accept(C, "D".repeat(43), strict);
    expect(r.status).toBe(429);
    expect(r.body.error?.code).toBe("rate_limited");
    expect(Number(r.res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("roluri: member → 403 la invitații și roluri; owner schimbă rolul; ultimul owner nu pleacă", async () => {
    const members = await call(F.listMembersHandler, "/api/v1/family/members", {
      bearer: B.bearer,
    });
    expect(members.status).toBe(200);
    const list = members.body.data as Member[];
    expect(list.map((m) => m.userId).sort()).toEqual([idA, idB].sort());
    expect(JSON.stringify(list)).not.toContain("@exemplu.ro");

    expect(
      (
        await call(F.createInviteHandler, "/api/v1/family/invites", {
          bearer: B.bearer,
          method: "POST",
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(F.listInvitesHandler, "/api/v1/family/invites", { bearer: B.bearer })).status,
    ).toBe(403);
    const patchB = (s: Sessions, role: string) =>
      call(
        F.patchMemberHandler,
        `/api/v1/family/members/${idA}`,
        { bearer: s.bearer, method: "PATCH", body: { role } },
        idA,
      );
    expect((await patchB(B, "member")).status).toBe(403);

    // A e singurul owner: nu se poate retrograda, nu poate pleca, nu se poate scoate pe sine.
    const demote = await patchB(A, "member");
    expect(demote.status).toBe(409);
    expect(demote.body.error?.reason).toBe("last_owner");
    const leave = await call(F.leaveHouseholdHandler, "/api/v1/family/leave", {
      bearer: A.bearer,
      method: "POST",
    });
    expect(leave.status).toBe(409);
    expect(leave.body.error?.reason).toBe("last_owner");
    const self = await call(
      F.deleteMemberHandler,
      `/api/v1/family/members/${idA}`,
      { bearer: A.bearer, method: "DELETE" },
      idA,
    );
    expect(self.status).toBe(409);
    expect(self.body.error?.reason).toBe("use_leave");

    // Promovare și înapoi.
    const up = await call(
      F.patchMemberHandler,
      `/api/v1/family/members/${idB}`,
      { bearer: A.bearer, method: "PATCH", body: { role: "owner" } },
      idB,
    );
    expect((up.body.data as Member).role).toBe("owner");
    const down = await call(
      F.patchMemberHandler,
      `/api/v1/family/members/${idB}`,
      { bearer: A.bearer, method: "PATCH", body: { role: "member" } },
      idB,
    );
    expect((down.body.data as Member).role).toBe("member");

    // Un străin nu vede membrii lui A (gospodăria lui curentă e HC).
    const c = await call(F.listMembersHandler, "/api/v1/family/members", { bearer: C.bearer });
    expect((c.body.data as Member[]).map((m) => m.userId)).not.toContain(idA);
  });

  it("împărțire, solduri, decontare parțială (replay), 409 transaction_split, evenimente live filtrate", async () => {
    // Contul personal al lui B (vizibil doar lui) și unul comun.
    const personal = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: B.bearer,
      body: { name: "Card Bogdan", type: "bank", currency: "RON", ownerUserId: idB },
    });
    expect(personal.status, JSON.stringify(personal.body)).toBe(201);
    const accB = (personal.body.data as { id: string }).id;

    const liveA = await openEvents(A);
    expect(liveConnectionsOf(idA)).toBe(1);

    const txr = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: B.bearer,
      body: {
        type: "expense",
        accountId: accB,
        amountMinor: 10001,
        occurredOn: "2026-10-20",
        description: "Cumpărături",
      },
    });
    expect(txr.status, JSON.stringify(txr.body)).toBe(201);
    const txId = (txr.body.data as { id: string }).id;
    // Tranzacția din contul personal al lui B NU ajunge la A (nici măcar id-ul).
    expect(await liveA.nextChange(800)).toBeNull();

    const split = await call(
      F.putSplitHandler,
      `/api/v1/transactions/${txId}/split`,
      { bearer: B.bearer, method: "PUT", body: { mode: "equal", userIds: [idA, idB] } },
      txId,
    );
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    const shares = (split.body.data as { shares: { shareMinor: number }[] }).shares;
    expect(shares.reduce((a, s) => a + s.shareMinor, 0)).toBe(10001);
    expect(await liveA.nextChange()).toEqual({ type: "split", id: txId });

    // A vede împărțirea (cine, cât), dar nu tranzacția (404).
    expect(
      (
        await call(
          F.getSplitHandler,
          `/api/v1/transactions/${txId}/split`,
          { bearer: A.bearer },
          txId,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          L.getTransactionHandler,
          `/api/v1/transactions/${txId}`,
          { bearer: A.bearer },
          txId,
        )
      ).status,
    ).toBe(404);
    // Un străin: 404 pe împărțire.
    expect(
      (
        await call(
          F.getSplitHandler,
          `/api/v1/transactions/${txId}/split`,
          { bearer: C.bearer },
          txId,
        )
      ).status,
    ).toBe(404);

    // Suma și ștergerea refuzate cât timp e împărțită.
    const patch = await call(
      L.patchTransactionHandler,
      `/api/v1/transactions/${txId}`,
      { bearer: B.bearer, method: "PATCH", body: { amountMinor: 5000 } },
      txId,
    );
    expect(patch.status).toBe(409);
    expect(patch.body.error?.reason).toBe("transaction_split");
    const del = await call(
      L.deleteTransactionHandler,
      `/api/v1/transactions/${txId}`,
      { bearer: B.bearer, method: "DELETE" },
      txId,
    );
    expect(del.status).toBe(409);
    expect(del.body.error?.reason).toBe("transaction_split");

    // Soldurile: A îi datorează lui B partea lui (aceleași perechi la amândoi).
    const owed = shares.find(
      (_, i) => (split.body.data as { shares: { userId: string }[] }).shares[i]!.userId === idA,
    )!.shareMinor;
    const bA = await balances(A);
    expect(bA.me).toEqual([{ currency: "RON", owesMinor: owed, owedMinor: 0 }]);
    expect((await balances(B)).currencies).toEqual(bA.currencies);

    // Decontare parțială cu cheie: replay → același răspuns, fără a doua decontare.
    const key = newKey();
    const settle = (k: string) =>
      call(F.createSettlementHandler, "/api/v1/family/settlements", {
        bearer: A.bearer,
        headers: { "idempotency-key": k },
        body: {
          fromUserId: idA,
          toUserId: idB,
          amountMinor: 2000,
          currency: "RON",
          settledOn: "2026-10-21",
        },
      });
    const s1 = await settle(key);
    expect(s1.status, JSON.stringify(s1.body)).toBe(201);
    const s2 = await settle(key);
    expect(s2.res.headers.get("idempotent-replay")).toBe("true");
    expect(s2.body).toEqual(s1.body);
    const sid = (s1.body.data as { id: string }).id;
    expect((await balances(A)).me[0]!.owesMinor).toBe(owed - 2000);

    // B vede decontarea live.
    const liveB = await openEvents(B);
    const cancel = await call(
      F.cancelSettlementHandler,
      `/api/v1/family/settlements/${sid}/cancel`,
      { bearer: A.bearer, method: "POST" },
      sid,
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(await liveB.nextChange()).toEqual({ type: "settlement", id: sid });
    expect((await balances(A)).me[0]!.owesMinor).toBe(owed);

    // Decontarea completă → sold 0.
    const full = await settle(newKey());
    expect(full.status).toBe(201);
    const rest = await call(F.createSettlementHandler, "/api/v1/family/settlements", {
      bearer: A.bearer,
      body: {
        fromUserId: idA,
        toUserId: idB,
        amountMinor: owed - 2000,
        currency: "RON",
        settledOn: "2026-10-22",
      },
    });
    expect(rest.status).toBe(201);
    const zero = await balances(A);
    expect(zero.me.every((m) => m.owesMinor === 0 && m.owedMinor === 0)).toBe(true);

    const listS = await call(
      F.listSettlementsHandler,
      "/api/v1/family/settlements?includeCancelled=true",
      { bearer: B.bearer },
    );
    expect((listS.body.data as unknown[]).length).toBe(3);
    const splits = await call(F.listSplitsHandler, "/api/v1/family/splits?limit=10", {
      bearer: A.bearer,
    });
    expect((splits.body.data as { transactionId: string }[])[0]!.transactionId).toBe(txId);

    // O tranzacție dintr-un cont COMUN ajunge la ceilalți membri (doar tip + id).
    const common = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      body: { name: "Cont comun", type: "cash", currency: "RON" },
    });
    const accCommon = (common.body.data as { id: string }).id;
    const shared = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: A.bearer,
      body: { type: "expense", accountId: accCommon, amountMinor: 1500, occurredOn: "2026-10-22" },
    });
    expect(shared.status, JSON.stringify(shared.body)).toBe(201);
    const sharedId = (shared.body.data as { id: string }).id;
    // Întâi cele două decontări de mai sus, apoi tranzacția.
    expect((await liveB.nextChange())?.type).toBe("settlement");
    expect((await liveB.nextChange())?.type).toBe("settlement");
    const ev = await liveB.nextChange();
    expect(ev).toEqual({ type: "transaction", id: sharedId });
    expect(Object.keys(ev!).sort()).toEqual(["id", "type"]);

    // Curățarea la abort: contorul conexiunilor scade.
    liveA.abort();
    liveB.abort();
    await liveA.next(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(liveConnectionsOf(idA)).toBe(0);
    expect(liveConnectionsOf(idB)).toBe(0);
  });

  it("SSE: la plafonul de 4 conexiuni per utilizator cea mai veche e evacuată; puls; durata maximă", async () => {
    const quick = { ...env, live: { heartbeatMs: 100, lifetimeMs: 3000 } };
    const opened = [];
    for (let i = 0; i < 4; i++) opened.push(await openEvents(C, quick));
    expect(liveConnectionsOf(idC)).toBe(4);
    // A cincea conexiune e acceptată, iar prima primește `event: evicted` și se închide.
    const fifth = await openEvents(C, quick);
    expect(liveConnectionsOf(idC)).toBe(4);
    let evicted = false;
    for (let i = 0; i < 20 && !evicted; i++) {
      const f = await opened[0]!.next(500);
      if (f?.includes("event: evicted")) evicted = true;
      if (f === "__end__") break;
    }
    expect(evicted).toBe(true);
    const frames: string[] = [];
    for (;;) {
      const f = await fifth.next(5000);
      if (f === null || f === "__end__") break;
      frames.push(f);
      if (f.includes("event: reconnect")) break;
    }
    expect(frames.some((f) => f.startsWith(": ping"))).toBe(true);
    expect(frames.some((f) => f.includes("event: reconnect"))).toBe(true);
    for (const o of [...opened, fifth]) o.abort();
    await new Promise((r) => setTimeout(r, 300));
    expect(liveConnectionsOf(idC)).toBe(0);
  });

  it("SSE: după comutarea gospodăriei, fluxul vechi se închide (`event: close`)", async () => {
    const quick = { ...env, live: { heartbeatMs: 100, lifetimeMs: 60_000 } };
    const stream = await openEvents(B, quick);
    const sw = await call(F.setActiveHouseholdHandler, "/api/v1/households/active", {
      bearer: B.bearer,
      method: "PUT",
      body: { householdId: hhB },
    });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      const f = await stream.next(500);
      if (f?.includes("event: close") || f === "__end__") closed = true;
    }
    expect(closed).toBe(true);
    // Înapoi în HA; o gospodărie străină → 404.
    await call(F.setActiveHouseholdHandler, "/api/v1/households/active", {
      bearer: B.bearer,
      method: "PUT",
      body: { householdId: hhA },
    });
    const foreign = await call(F.setActiveHouseholdHandler, "/api/v1/households/active", {
      bearer: B.bearer,
      method: "PUT",
      body: { householdId: hhC },
    });
    expect(foreign.status).toBe(404);
  });

  it("plecarea: B pleacă din HA (soldul decontat), revine în gospodăria lui; A rămâne singur", async () => {
    // Puls lung: închiderea vine din plecare, nu din reverificare.
    const slow = { ...env, live: { heartbeatMs: 600_000, lifetimeMs: 600_000 } };
    const stream = await openEvents(B, slow);
    const r = await call(F.leaveHouseholdHandler, "/api/v1/family/leave", {
      bearer: B.bearer,
      method: "POST",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ unsettledBalance: false });
    const closing = await stream.next(1000);
    expect(closing).toContain("event: close");
    expect(liveConnectionsOf(idB)).toBe(0);
    const hs = await call(L.listHouseholdsHandler, "/api/v1/households", { bearer: B.bearer });
    const list = hs.body.data as { id: string; current: boolean }[];
    expect(list.map((h) => h.id)).toEqual([hhB]);
    const members = await call(F.listMembersHandler, "/api/v1/family/members", {
      bearer: A.bearer,
    });
    expect((members.body.data as Member[]).map((m) => m.userId)).toEqual([idA]);
    const sole = await call(F.leaveHouseholdHandler, "/api/v1/family/leave", {
      bearer: A.bearer,
      method: "POST",
    });
    expect(sole.status).toBe(409);
    expect(sole.body.error?.reason).toBe("sole_member");
  });
});
