import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { parseClientHeader, parseClientInfo } from "@/modules/auth/request";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as M from "./_lib/me-handlers";
import { type Sessions, apiRequest, assertContract, readJson, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const INSTALL = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const HEADER = `platform=android; version=1.0.2; code=10002; installation=${INSTALL}; os=14; model=Pixel 8; locale=ro-RO`;

describe("X-FINET-Client: parsare strictă", () => {
  it("forma completă e acceptată; cea veche rămâne validă pentru sesiuni", () => {
    expect(parseClientInfo(HEADER)).toEqual({
      platform: "android",
      installationId: INSTALL,
      appVersion: "1.0.2",
      versionCode: 10002,
      osVersion: "14",
      deviceModel: "Pixel 8",
      locale: "ro-RO",
    });
    expect(parseClientInfo(`platform=web; installation=${INSTALL.toUpperCase()}`)).toMatchObject({
      platform: "web",
      installationId: INSTALL,
      appVersion: null,
    });
    expect(parseClientHeader(HEADER)).toEqual({ platform: "android", version: "1.0.2" });
    expect(parseClientHeader("android/1.4.2")).toEqual({ platform: "android", version: "1.4.2" });
    expect(parseClientInfo("android/1.4.2")).toBeNull();
  });

  it("orice abatere → antet ignorat (null)", () => {
    const bad = [
      "",
      `platform=ios; installation=${INSTALL}`,
      "platform=android; version=1.0",
      `platform=android; installation=nu-e-uuid`,
      `platform=android; installation=${INSTALL}; color=red`,
      `platform=android; platform=web; installation=${INSTALL}`,
      `platform=android; installation=${INSTALL}; code=99999999999`,
      `platform=android; installation=${INSTALL}; code=-1`,
      `platform=android; installation=${INSTALL}; locale=romana`,
      `platform=android; installation=${INSTALL}; model=${"x".repeat(65)}`,
      `platform=android; installation=${INSTALL}; model=Pixel<script>`,
      `platform=android; installation=${INSTALL}; version=`,
      `platform=android; installation=${INSTALL}; os=14\u0007`,
      `platform=android; installation=${INSTALL}; model=Telefon ăîș`,
      `${HEADER}; ${"x".repeat(400)}`,
    ];
    for (const value of bad) expect(parseClientInfo(value), value).toBeNull();
  });
});

describe.skipIf(!TEST_ADMIN_URL)("statistici de utilizare pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  let clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions;
  let B: Sessions;
  let anaId: string;
  const PASS = "parola-statistici-12";

  const iso = (ms: number) => new Date(ms).toISOString();

  async function events(s: Sessions, body: unknown, headers: Record<string, string> = {}) {
    const r = await M.appEventsHandler(
      apiRequest("/api/v1/app/events", { bearer: s.bearer, body, headers }),
      env,
    );
    await assertContract(M.appEventsHandler, r);
    return r;
  }

  async function eventRows(userId: string) {
    return fx.scratch.admin<
      { name: string; installation_id: string | null; app_version: string | null }[]
    >`
      select name, installation_id, app_version from finet.app_events where user_id = ${userId} order by occurred_at`;
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_usage");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: { mutations: { max: 100_000, windowSeconds: 60 } },
    };
    anaId = (
      await createUserWithHousehold(fx.db, {
        email: "ana@exemplu.ro",
        name: "Ana",
        password: PASS,
        firstUserBecomesAdmin: true,
        emailVerified: true,
      })
    ).userId;
    await createUserWithHousehold(fx.db, {
      email: "bogdan@exemplu.ro",
      name: "Bogdan",
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("client_installations: inserare, apoi cel mult o scriere la 15 minute (ceas controlat)", async () => {
    const get = (headers: Record<string, string>) =>
      L.listAccountsHandler(apiRequest("/api/v1/accounts", { bearer: A.bearer, headers }), env);
    const row = async () => {
      const rows = await fx.scratch.admin<
        { app_version: string; last_seen_at: Date; first_seen_at: Date }[]
      >`
        select app_version, last_seen_at, first_seen_at from finet.client_installations
         where user_id = ${anaId} and installation_id = ${INSTALL}`;
      return rows;
    };
    expect((await get({ "x-finet-client": HEADER })).status).toBe(200);
    const [first] = await row();
    expect(first).toMatchObject({ app_version: "1.0.2" });
    expect(first!.last_seen_at.getTime()).toBe(clock);
    expect(first!.first_seen_at.getTime()).toBe(clock);

    clock += 14 * 60 * 1000;
    await get({ "x-finet-client": HEADER.replace("version=1.0.2", "version=1.0.3") });
    const [mid] = await row();
    expect(mid).toMatchObject({ app_version: "1.0.2" });
    expect(mid!.last_seen_at.getTime()).toBe(first!.last_seen_at.getTime());

    clock += 2 * 60 * 1000;
    await get({ "x-finet-client": HEADER.replace("version=1.0.2", "version=1.0.3") });
    const [late] = await row();
    expect(late).toMatchObject({ app_version: "1.0.3" });
    expect(late!.last_seen_at.getTime()).toBe(clock);
    expect(late!.first_seen_at.getTime()).toBe(first!.first_seen_at.getTime());

    // Fără antet, cu antet vechi sau invalid: cererea merge, nimic nou în tabel.
    for (const headers of [
      {},
      { "x-finet-client": "android/1.0" },
      { "x-finet-client": "platform=x" },
    ] as Record<string, string>[]) {
      expect((await get(headers)).status).toBe(200);
    }
    const [{ n }] = (await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.client_installations`) as unknown as [{ n: number }];
    expect(n).toBe(1);

    // Același id de instalare la alt utilizator: rând separat (unic per utilizator).
    await L.listAccountsHandler(
      apiRequest("/api/v1/accounts", { bearer: B.bearer, headers: { "x-finet-client": HEADER } }),
      env,
    );
    const both = await fx.scratch
      .admin`select 1 from finet.client_installations where installation_id = ${INSTALL}`;
    expect(both).toHaveLength(2);
  });

  it("consimțăminte: GET implicit fără acord; PUT acordă/revocă, cu audit; validare strictă", async () => {
    const initial = await M.getConsentsHandler(
      apiRequest("/api/v1/me/consents", { cookie: A.cookie }),
      env,
    );
    expect(initial.status).toBe(200);
    expect((await readJson(initial)).data).toEqual([
      { kind: "usageStats", granted: false, grantedAt: null, revokedAt: null },
      { kind: "externalAi", granted: false, grantedAt: null, revokedAt: null },
      { kind: "externalAiStatements", granted: false, grantedAt: null, revokedAt: null },
    ]);
    const put = (body: unknown) =>
      M.putConsentsHandler(
        apiRequest("/api/v1/me/consents", { method: "PUT", cookie: A.cookie, body }),
        env,
      );
    expect((await put({ usage_stats: true })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    const granted = await put({ usageStats: true });
    expect(granted.status).toBe(200);
    expect((await readJson(granted)).data).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "usageStats", granted: true })]),
    );
    // A doua acordare nu dublează rândul și nu se auditează din nou.
    await put({ usageStats: true });
    const audits = await fx.scratch.admin<{ action: string; metadata: { kind: string } }[]>`
      select action, metadata from finet.audit_events where actor_user_id = ${anaId} and action like 'consent.%'`;
    expect(audits).toEqual([{ action: "consent.granted", metadata: { kind: "usage_stats" } }]);
    const noCsrf = await M.putConsentsHandler(
      apiRequest("/api/v1/me/consents", {
        method: "PUT",
        cookie: A.cookie,
        headers: { origin: "" },
        body: { usageStats: false },
      }),
      env,
    );
    expect(noCsrf.status).toBe(403);
  });

  it("evenimente: cu consimțământ se stochează (cu instalarea și versiunea din antet)", async () => {
    const r = await events(
      A,
      {
        events: [
          { name: "app_open", occurredAt: iso(clock - 60_000) },
          { name: "screen_view", screen: "dashboard", occurredAt: iso(clock) },
          {
            name: "error_shown",
            errorCode: "network_timeout",
            screen: "scan",
            occurredAt: iso(clock),
          },
        ],
      },
      { "x-finet-client": HEADER },
    );
    expect(r.status).toBe(204);
    const rows = await eventRows(anaId);
    expect(rows).toHaveLength(3);
    expect(rows.every((e) => e.installation_id === INSTALL)).toBe(true);
    expect(rows[0]!.app_version).toBe("1.0.2");
  });

  it("evenimente: un câmp nepermis (o sumă) respinge lotul cu 400, mesaj fix, fără ecoul valorii", async () => {
    const before = (await eventRows(anaId)).length;
    const cases: unknown[] = [
      { events: [{ name: "transaction_created", occurredAt: iso(clock), amountMinor: 987654 }] },
      {
        events: [
          { name: "transaction_created", occurredAt: iso(clock), merchant: "Magazinul-Secret-X" },
        ],
      },
      { events: [{ name: "nume_inventat", occurredAt: iso(clock) }] },
      { events: [{ name: "app_open", occurredAt: "ieri" }] },
      { events: [{ name: "app_open", occurredAt: iso(clock - 40 * 24 * 3600 * 1000) }] },
      { events: [{ name: "error_shown", errorCode: "NETWORK_TIMEOUT", occurredAt: iso(clock) }] },
      { events: [] },
      { events: Array.from({ length: 21 }, () => ({ name: "app_open", occurredAt: iso(clock) })) },
      { events: [{ name: "app_open", occurredAt: iso(clock) }], userId: "altcineva" },
    ];
    for (const body of cases) {
      const r = await events(A, body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      const text = await r.text();
      expect(JSON.parse(text).error).toMatchObject({ code: "invalid_request" });
      expect(text).not.toMatch(/987654|Magazinul-Secret-X|nume_inventat|NETWORK_TIMEOUT|altcineva/);
    }
    const amount = await events(A, cases[0]);
    expect((await readJson(amount)).error).toEqual({
      code: "invalid_request",
      message: "Evenimentele nu sunt valide.",
      fields: { "events.0.amountMinor": "Câmp nepermis." },
    });
    expect((await eventRows(anaId)).length).toBe(before);
  });

  it("evenimente: fără consimțământ activ (niciodată acordat sau revocat) → 204, nimic stocat", async () => {
    const bogdan = await events(B, { events: [{ name: "app_open", occurredAt: iso(clock) }] });
    expect(bogdan.status).toBe(204);
    const [{ n }] = (await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.app_events e join finet.users u on u.id = e.user_id
       where u.email = 'bogdan@exemplu.ro'`) as unknown as [{ n: number }];
    expect(n).toBe(0);

    const before = (await eventRows(anaId)).length;
    await M.putConsentsHandler(
      apiRequest("/api/v1/me/consents", {
        method: "PUT",
        bearer: A.bearer,
        body: { usageStats: false },
      }),
      env,
    );
    const after = await events(A, { events: [{ name: "logout", occurredAt: iso(clock) }] });
    expect(after.status).toBe(204);
    expect((await eventRows(anaId)).length).toBe(before);
    const states = (
      await readJson(
        await M.getConsentsHandler(apiRequest("/api/v1/me/consents", { bearer: A.bearer }), env),
      )
    ).data as { kind: string; granted: boolean; revokedAt: string | null }[];
    expect(states[0]).toMatchObject({
      kind: "usageStats",
      granted: false,
      revokedAt: expect.any(String),
    });
  });

  it("evenimente: fără sesiune 401; rate limit propriu → 429", async () => {
    const anon = await M.appEventsHandler(
      apiRequest("/api/v1/app/events", {
        body: { events: [{ name: "app_open", occurredAt: iso(clock) }] },
      }),
      env,
    );
    expect(anon.status).toBe(401);
    const strict = {
      ...env,
      limits: { ...env.limits, events: { max: 1, windowSeconds: 60 } },
      now: () => clock + 9_999_999,
    };
    const send = () =>
      M.appEventsHandler(
        apiRequest("/api/v1/app/events", {
          bearer: B.bearer,
          body: { events: [{ name: "app_open", occurredAt: iso(clock) }] },
        }),
        strict,
      );
    expect((await send()).status).toBe(204);
    expect((await send()).status).toBe(429);
  });
});
