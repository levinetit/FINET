import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import {
  type AuthEnv,
  type AuthFixture,
  authEnv,
  createAuthFixture,
  testConfig,
} from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import * as AD from "./_lib/admin-handlers";
import type { ApiDeps } from "./_lib/http";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Forma răspunsului e verificată prin contract (`assertContract`); în aserțiuni se citește liber.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Handler = (request: Request, deps: ApiDeps, ...rest: string[]) => Promise<Response>;

/**
 * Feedback, anunțuri, erori și panoul de administrare (F11-B; ADR 0028) prin API, pe PostgreSQL
 * real: rutele există doar în `saas` (404 în `personal`), cele `/admin/*` răspund 404 și
 * non-administratorilor, nimic financiar nu trece prin ele, acțiunile se auditează.
 */
describe.skipIf(!TEST_ADMIN_URL)("11-B: feedback, anunțuri, erori, administrare", () => {
  let fx: AuthFixture;
  let appSql: postgres.Sql;
  let saas: AuthEnv & ApiDeps;
  let personal: AuthEnv & ApiDeps;
  let ADMIN: Sessions;
  let USER: Sessions;
  let OTHER: Sessions;
  let adminId: string;
  let userId: string;
  let otherId: string;
  const PASS = "parola-admin-11b-1";
  const NIL = "00000000-0000-4000-8000-000000000000";
  const limits = {
    mutations: { max: 100_000, windowSeconds: 60 },
    exports: { max: 100_000, windowSeconds: 60 },
  };

  async function call(
    deps: ApiDeps,
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ) {
    const res = await handler(apiRequest(path, init), deps, ...rest);
    await assertContract(handler, res);
    const text = await res.clone().text();
    return {
      status: res.status,
      data: ((text ? JSON.parse(text) : {}) as Loose).data,
      text,
      body: text ? (JSON.parse(text) as Loose) : {},
    };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_admin_11b");
    saas = { ...authEnv(fx.db, { config: testConfig({ APP_MODE: "saas" }) }), limits };
    personal = { ...authEnv(fx.db), limits };
    const mk = (email: string, name: string) =>
      createUserWithHousehold(fx.db, {
        email,
        name,
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
    adminId = (await mk("admin@exemplu.ro", "Admin")).userId;
    userId = (await mk("ana@exemplu.ro", "Ana")).userId;
    otherId = (await mk("bogdan@exemplu.ro", "Bogdan")).userId;
    await fx.scratch.admin`update finet.users set is_platform_admin = true where id = ${adminId}`;
    ADMIN = await sessionsFor(saas, "admin@exemplu.ro", PASS);
    USER = await sessionsFor(saas, "ana@exemplu.ro", PASS);
    OTHER = await sessionsFor(saas, "bogdan@exemplu.ro", PASS);
    appSql = postgres(fx.scratch.appUrl, { max: 1, prepare: false, onnotice: () => {} });
    await fx.scratch.admin`delete from finet.audit_events`;
  });

  afterAll(async () => {
    await appSql?.end({ timeout: 5 });
    await fx?.close();
  });

  const ADMIN_ROUTES: [Handler, string, ApiInit, ...string[]][] = [
    [AD.adminUsersHandler, "/api/v1/admin/users", {}],
    [AD.adminHouseholdsHandler, "/api/v1/admin/households", {}],
    [AD.adminJobsHandler, "/api/v1/admin/jobs", {}],
    [AD.adminFeedbackHandler, "/api/v1/admin/feedback", {}],
    [AD.adminErrorsHandler, "/api/v1/admin/errors", {}],
    [AD.adminAnnouncementsHandler, "/api/v1/admin/announcements", {}],
    [
      AD.adminCreateAnnouncementHandler,
      "/api/v1/admin/announcements",
      { body: { title: "t", body: "b" } },
    ],
    [
      AD.adminSetUserStatusHandler,
      `/api/v1/admin/users/${NIL}`,
      { method: "PATCH", body: { status: "disabled" } },
      NIL,
    ],
    [
      AD.adminSetFeedbackStatusHandler,
      `/api/v1/admin/feedback/${NIL}`,
      { method: "PATCH", body: { status: "seen" } },
      NIL,
    ],
    [
      AD.adminUpdateAnnouncementHandler,
      `/api/v1/admin/announcements/${NIL}`,
      { method: "PATCH", body: { archived: true } },
      NIL,
    ],
  ];

  it("în `personal` toate rutele noi răspund 404, chiar și pentru un administrator", async () => {
    const adminInPersonal = await sessionsFor(personal, "admin@exemplu.ro", PASS);
    for (const [handler, path, init, ...rest] of ADMIN_ROUTES) {
      const r = await call(
        personal,
        handler,
        path,
        { ...init, bearer: adminInPersonal.bearer },
        ...rest,
      );
      expect(r.status, path).toBe(404);
    }
    for (const [handler, path, init] of [
      [
        AD.createFeedbackHandler,
        "/api/v1/feedback",
        { body: { kind: "feedback", message: "salut" } },
      ],
      [AD.listAnnouncementsHandler, "/api/v1/announcements", {}],
      [
        AD.reportErrorHandler,
        "/api/v1/errors",
        { body: { kind: "client", route: "/x", code: "E1" } },
      ],
    ] as [Handler, string, ApiInit][]) {
      const r = await call(personal, handler, path, { ...init, bearer: adminInPersonal.bearer });
      expect(r.status, path).toBe(404);
    }
  });

  it("în `saas`, un non-administrator primește 404 pe TOATE rutele de administrare; fără sesiune 401", async () => {
    for (const [handler, path, init, ...rest] of ADMIN_ROUTES) {
      const user = await call(saas, handler, path, { ...init, bearer: USER.bearer }, ...rest);
      expect(user.status, `${path} (utilizator)`).toBe(404);
      const anonymous = await call(saas, handler, path, init, ...rest);
      expect(anonymous.status, `${path} (anonim)`).toBe(401);
    }
  });

  it("feedback: utilizatorul trimite, validare strictă; administratorul listează, filtrează și schimbă starea (cu audit)", async () => {
    const created = await call(saas, AD.createFeedbackHandler, "/api/v1/feedback", {
      bearer: USER.bearer,
      body: {
        kind: "bug",
        message: "Butonul nu merge",
        page: "/transactions/[id]",
        appVersion: "1.0.0",
      },
    });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    for (const bad of [
      { kind: "bug", message: "ab" },
      { kind: "altceva", message: "mesaj ok" },
      { kind: "bug", message: "mesaj ok", userId: otherId },
      { kind: "bug", message: "mesaj ok", page: "/ceva?x=1" },
      { kind: "bug", message: "x".repeat(2001) },
    ]) {
      expect(
        (
          await call(saas, AD.createFeedbackHandler, "/api/v1/feedback", {
            bearer: USER.bearer,
            body: bad,
          })
        ).status,
        JSON.stringify(bad).slice(0, 60),
      ).toBe(400);
    }
    await call(saas, AD.createFeedbackHandler, "/api/v1/feedback", {
      bearer: OTHER.bearer,
      body: { kind: "feedback", message: "Mi-ar plăcea un mod întunecat" },
    });

    const list = await call(saas, AD.adminFeedbackHandler, "/api/v1/admin/feedback", {
      bearer: ADMIN.bearer,
    });
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(2);
    expect(Object.keys(list.data[0]).sort()).toEqual([
      "appVersion",
      "authorEmail",
      "createdAt",
      "id",
      "kind",
      "message",
      "page",
      "status",
    ]);
    const mine = list.data.find((f: Loose) => f.id === id);
    expect(mine).toMatchObject({
      authorEmail: "ana@exemplu.ro",
      kind: "bug",
      status: "new",
      page: "/transactions/[id]",
    });

    const patched = await call(
      saas,
      AD.adminSetFeedbackStatusHandler,
      `/api/v1/admin/feedback/${id}`,
      {
        method: "PATCH",
        bearer: ADMIN.bearer,
        body: { status: "seen" },
      },
      id,
    );
    expect(patched.data).toEqual({ id, status: "seen" });
    const filtered = await call(
      saas,
      AD.adminFeedbackHandler,
      "/api/v1/admin/feedback?status=new",
      { bearer: ADMIN.bearer },
    );
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].authorEmail).toBe("bogdan@exemplu.ro");
    // Starea necunoscută și id inexistent.
    expect(
      (
        await call(
          saas,
          AD.adminSetFeedbackStatusHandler,
          `/api/v1/admin/feedback/${id}`,
          { method: "PATCH", bearer: ADMIN.bearer, body: { status: "sters" } },
          id,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          saas,
          AD.adminSetFeedbackStatusHandler,
          `/api/v1/admin/feedback/${NIL}`,
          { method: "PATCH", bearer: ADMIN.bearer, body: { status: "seen" } },
          NIL,
        )
      ).status,
    ).toBe(404);

    const audits = await fx.scratch.admin<
      { action: string; metadata: Record<string, unknown>; target_id: string }[]
    >`
      select action, metadata, target_id from finet.audit_events where action = 'admin.feedback_status_changed'`;
    expect(audits).toEqual([
      { action: "admin.feedback_status_changed", metadata: { status: "seen" }, target_id: id },
    ]);
  });

  it("izolare la nivel de bază: un utilizator obișnuit nu poate citi sau modifica feedback-ul altora, nici anunțurile arhivate", async () => {
    const asUser = async (id: string, q: string) => {
      const sql = appSql;
      return sql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${id}, true)`;
        return tx.unsafe(q);
      });
    };
    expect((await asUser(userId, "select count(*)::int as n from finet.feedback"))[0]!.n).toBe(1);
    expect((await asUser(otherId, "select count(*)::int as n from finet.feedback"))[0]!.n).toBe(1);
    expect((await asUser(adminId, "select count(*)::int as n from finet.feedback"))[0]!.n).toBe(2);
    // RLS: UPDATE-ul unui non-administrator nu atinge niciun rând (politica `feedback_update`).
    expect(
      await asUser(userId, "update finet.feedback set status = 'closed' returning id"),
    ).toHaveLength(0);
    await expect(
      asUser(
        userId,
        `insert into finet.feedback (user_id, kind, message) values ('${otherId}', 'bug', 'în numele altcuiva')`,
      ),
    ).rejects.toThrow();
    await expect(asUser(userId, "select * from finet.admin_users(10, 0)")).rejects.toThrow(
      /doar administratorul/,
    );
    await expect(asUser(userId, "select * from finet.app_errors")).resolves.toHaveLength(0);
    await expect(
      asUser(
        userId,
        "insert into finet.app_errors (fingerprint, kind, route, code) values ('x','client','/x','E')",
      ),
    ).rejects.toThrow();
  });

  it("anunțuri: administratorul creează/arhivează cu audit; utilizatorii văd doar cele active", async () => {
    const mk = (body: Loose) =>
      call(saas, AD.adminCreateAnnouncementHandler, "/api/v1/admin/announcements", {
        bearer: ADMIN.bearer,
        body,
      });
    const active = await mk({ title: "Mentenanță", body: "Duminică, 02:00–03:00", level: "warn" });
    expect(active.status).toBe(201);
    const future = await mk({
      title: "Viitor",
      body: "încă nu",
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const expired = await mk({
      title: "Expirat",
      body: "a trecut",
      startsAt: new Date(Date.now() - 7_200_000).toISOString(),
      endsAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const toArchive = await mk({ title: "Arhivat", body: "va fi arhivat" });
    expect([active, future, expired, toArchive].map((r) => r.status)).toEqual([201, 201, 201, 201]);
    await call(
      saas,
      AD.adminUpdateAnnouncementHandler,
      `/api/v1/admin/announcements/${toArchive.data.id}`,
      { method: "PATCH", bearer: ADMIN.bearer, body: { archived: true } },
      toArchive.data.id,
    );

    const seen = await call(saas, AD.listAnnouncementsHandler, "/api/v1/announcements", {
      bearer: USER.bearer,
    });
    expect(seen.data.map((a: Loose) => a.title)).toEqual(["Mentenanță"]);
    expect(seen.data[0]).toMatchObject({ level: "warn" });
    const all = await call(saas, AD.adminAnnouncementsHandler, "/api/v1/admin/announcements", {
      bearer: ADMIN.bearer,
    });
    expect(all.data).toHaveLength(4);
    expect(all.data.find((a: Loose) => a.title === "Arhivat").archived).toBe(true);
    // Validare: titlu gol, nivel necunoscut, câmp în plus, sfârșit înaintea începutului.
    for (const bad of [
      { title: "", body: "b" },
      { title: "t", body: "b", level: "critic" },
      { title: "t", body: "b", createdByUserId: otherId },
      { title: "t", body: "b", startsAt: "2026-02-02T00:00:00Z", endsAt: "2026-01-01T00:00:00Z" },
    ]) {
      expect((await mk(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const audits = await fx.scratch.admin<{ action: string }[]>`
      select action from finet.audit_events where action like 'admin.announcement_%' order by created_at, id`;
    expect(audits.map((a) => a.action)).toEqual([
      "admin.announcement_created",
      "admin.announcement_created",
      "admin.announcement_created",
      "admin.announcement_created",
      "admin.announcement_updated",
    ]);
    // Un utilizator obișnuit nu poate scrie anunțuri nici direct în bază.
    await expect(
      appSql.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${userId}, true)`;
        await tx`insert into finet.announcements (title, body, created_by_user_id) values ('x', 'y', ${userId})`;
      }),
    ).rejects.toThrow();
  });

  it("erori: raportare cu valori valide, contor la repetare, valorile invalide ignorate; doar administratorul le vede", async () => {
    const report = (body: Loose) =>
      call(saas, AD.reportErrorHandler, "/api/v1/errors", { bearer: USER.bearer, body });
    expect(
      (
        await report({
          kind: "client",
          route: "/transactions/[id]",
          code: "TypeError",
          digest: "d123",
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await report({
          kind: "client",
          route: "/transactions/[id]",
          code: "TypeError",
          digest: "d123",
        })
      ).status,
    ).toBe(204);
    expect((await report({ kind: "server", route: "/api/v1/me", code: "E_DB" })).status).toBe(204);
    // Valori care nu respectă formele: 204 (nu strică nimic), dar nu se păstrează.
    expect((await report({ kind: "client", route: "/x?token=secret", code: "E" })).status).toBe(
      204,
    );
    expect(
      (await report({ kind: "client", route: "/x", code: "mesaj cu spații și date personale" }))
        .status,
    ).toBe(204);
    expect((await report({ kind: "client", route: "/x", code: "E", extra: 1 })).status).toBe(204);
    const list = await call(saas, AD.adminErrorsHandler, "/api/v1/admin/errors", {
      bearer: ADMIN.bearer,
    });
    expect(list.data).toHaveLength(2);
    const t = list.data.find((e: Loose) => e.code === "TypeError");
    expect(t).toMatchObject({
      kind: "client",
      route: "/transactions/[id]",
      digest: "d123",
      occurrences: 2,
    });
    expect(JSON.stringify(list.data)).not.toContain("secret");
    expect(JSON.stringify(list.data)).not.toContain("personale");
  });

  it("liste administrative: utilizatori, gospodării, cozi; doar coloane nefinanciare; dezactivarea unui cont (nu a propriului)", async () => {
    const users = await call(saas, AD.adminUsersHandler, "/api/v1/admin/users?limit=2&offset=0", {
      bearer: ADMIN.bearer,
    });
    expect(users.status, users.text).toBe(200);
    expect(users.data).toHaveLength(2);
    expect(Object.keys(users.data[0]).sort()).toEqual([
      "createdAt",
      "email",
      "households",
      "id",
      "isPlatformAdmin",
      "name",
      "status",
    ]);
    const all = await call(saas, AD.adminUsersHandler, "/api/v1/admin/users", {
      bearer: ADMIN.bearer,
    });
    expect(all.data.map((u: Loose) => u.email).sort()).toEqual([
      "admin@exemplu.ro",
      "ana@exemplu.ro",
      "bogdan@exemplu.ro",
    ]);
    const hh = await call(saas, AD.adminHouseholdsHandler, "/api/v1/admin/households", {
      bearer: ADMIN.bearer,
    });
    expect(hh.data).toHaveLength(3);
    expect(Object.keys(hh.data[0]).sort()).toEqual(["createdAt", "id", "members", "name"]);
    const jobs = await call(saas, AD.adminJobsHandler, "/api/v1/admin/jobs", {
      bearer: ADMIN.bearer,
    });
    expect(jobs.status).toBe(200);
    expect(Array.isArray(jobs.data)).toBe(true);
    for (const row of jobs.data) expect(Object.keys(row).sort()).toEqual(["jobs", "name", "state"]);
    // Pagini peste plafon → 400; parametri necunoscuți → 400.
    expect(
      (
        await call(saas, AD.adminUsersHandler, "/api/v1/admin/users?limit=500", {
          bearer: ADMIN.bearer,
        })
      ).status,
    ).toBe(400);
    expect(
      (await call(saas, AD.adminUsersHandler, "/api/v1/admin/users?x=1", { bearer: ADMIN.bearer }))
        .status,
    ).toBe(400);

    const set = (target: string, status: string, s = ADMIN) =>
      call(
        saas,
        AD.adminSetUserStatusHandler,
        `/api/v1/admin/users/${target}`,
        { method: "PATCH", bearer: s.bearer, body: { status } },
        target,
      );
    expect((await set(adminId, "disabled")).status).toBe(400); // nu propriul cont
    expect((await set(otherId, "dezactivat")).status).toBe(400);
    expect((await set(NIL, "disabled")).status).toBe(404);
    // Starea unui alt administrator nu se schimbă prin API, în niciun sens (0022).
    await fx.scratch.admin`update finet.users set is_platform_admin = true where id = ${otherId}`;
    expect((await set(otherId, "disabled")).status).toBe(400);
    expect((await set(otherId, "active")).status).toBe(400);
    await fx.scratch.admin`update finet.users set is_platform_admin = false where id = ${otherId}`;
    const [still] = await fx.scratch.admin<{ status: string }[]>`
      select status from finet.users where id = ${otherId}`;
    expect(still?.status).toBe("active");
    const off = await set(otherId, "disabled");
    expect(off.data).toEqual({ changed: true });
    // Contul dezactivat nu mai are sesiune validă.
    const me = await fetchMe(OTHER);
    expect(me).toBe(401);
    expect((await set(otherId, "active")).data).toEqual({ changed: true });
    const audits = await fx.scratch.admin<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from finet.audit_events where action = 'admin.user_status_changed' order by created_at, id`;
    expect(audits.map((a) => a.metadata.status)).toEqual(["disabled", "active"]);
  });

  async function fetchMe(s: Sessions): Promise<number> {
    const { getMeHandler } = await import("./_lib/me-handlers");
    const res = await getMeHandler(apiRequest("/api/v1/me", { bearer: s.bearer }), saas);
    return res.status;
  }
});
