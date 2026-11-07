import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import type { MailMessage } from "@/modules/auth/mailer";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { systemCategoryId } from "@/modules/ledger/testing";
import { evaluateForMember } from "@/modules/notifications/notifications.service";
import { handleNotifyEvaluate } from "@/worker/notifications/notify-jobs";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as NT from "./_lib/notifications-handlers";
import * as P from "./_lib/planning-handlers";
import * as RC from "./_lib/recurring-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

/**
 * Notificările (modernizare 2026, pasul J; ADR 0048) pe PostgreSQL real: evaluarea în numele unui
 * membru (candidați din reguli recurente, bugete depășite, documente), deduplicarea la a doua
 * rulare, preferințele (tipuri oprite, `inApp = false`), digestul pe email cu un expeditor fals,
 * API-ul (listă, citită, toate citite, ștergere, preferințe), izolarea (Bogdan nu vede nimic) și
 * jobul workerului peste toate țintele.
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;
type NotificationJson = {
  id: string;
  kind: string;
  title: string;
  readAt: string | null;
  link: string | null;
};

describe.skipIf(!TEST_ADMIN_URL)("Notificări pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  // 28 octombrie 2026, 10:00 UTC → azi în București: 2026-10-28.
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions;
  let B: Sessions;
  let anaId: string;
  let HA: string;
  let keySeq = 0;
  const PASS = "parola-notificari-1";
  const newKey = () => `notificari-cheie-${String(++keySeq).padStart(6, "0")}`;
  const sent: MailMessage[] = [];
  const mailer = { send: async (m: MailMessage) => void sent.push(m) };

  async function call(handler: Handler, path: string, init: ApiInit, ...rest: string[]) {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      env,
      ...rest,
    );
    await assertContract(handler, res);
    const text = await res.clone().text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body, res };
  }
  const deps = () => ({ db: env.db, now: () => new Date(clock) });

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_notifications_api");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: { mutations: { max: 100_000, windowSeconds: 60 } },
    };
    const mk = (email: string, name: string) =>
      createUserWithHousehold(fx.db, {
        email,
        name,
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
    const ana = await mk("ana@exemplu.ro", "Ana");
    anaId = ana.userId;
    HA = ana.householdId!;
    await mk("bogdan@exemplu.ro", "Bogdan");
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    const groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");
    const acc = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      body: { name: "Bancă", type: "bank", currency: "RON", openingBalance: "1000" },
    });
    const bank = (acc.body.data as { id: string }).id;
    // Chirie pe 30 octombrie (în 2 zile) → `payment_due` și `subscription_renewal`.
    const rule = await call(RC.createRecurringHandler, "/api/v1/recurring", {
      bearer: A.bearer,
      headers: { "idempotency-key": newKey() },
      body: {
        accountId: bank,
        type: "expense",
        amount: "1500",
        description: "Chirie",
        frequency: "monthly",
        dayOfMonth: 30,
        startOn: "2026-10-30",
      },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    // Buget de 100 lei pe alimente, depășit de o cheltuială de 150.
    const budget = await call(P.createBudgetHandler, "/api/v1/budgets", {
      bearer: A.bearer,
      headers: { "idempotency-key": newKey() },
      body: { categoryId: groceries, amount: "100", currency: "RON" },
    });
    expect(budget.status).toBe(201);
    const tx = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: A.bearer,
      headers: { "idempotency-key": newKey() },
      body: {
        type: "expense",
        accountId: bank,
        categoryId: groceries,
        amount: "150",
        occurredOn: "2026-10-10",
        description: "Cumpărături",
      },
    });
    expect(tx.status).toBe(201);
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("evaluarea: candidați din reguli și bugete, inserare, deduplicare la a doua rulare", async () => {
    const first = await evaluateForMember(deps(), { userId: anaId }, HA, {
      mailer: null,
      appUrl: null,
    });
    expect(first.skipped).toBeNull();
    expect(first.inserted).toBeGreaterThanOrEqual(3);
    expect(first.emailed).toBe(0);
    const second = await evaluateForMember(deps(), { userId: anaId }, HA, {
      mailer: null,
      appUrl: null,
    });
    expect(second.candidates).toBe(first.candidates);
    expect(second.inserted).toBe(0);

    const list = await call(NT.listNotificationsHandler, "/api/v1/notifications", {
      bearer: A.bearer,
    });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const items = list.body.data as NotificationJson[];
    const kinds = new Set(items.map((n) => n.kind));
    expect(kinds.has("payment_due")).toBe(true);
    expect(kinds.has("subscription_renewal")).toBe(true);
    expect(kinds.has("budget_exceeded")).toBe(true);
    expect(list.body.unread).toBe(items.length);
    expect(items.every((n) => n.readAt === null)).toBe(true);
    expect(items.find((n) => n.kind === "payment_due")!.title).toBe("Plată programată: Chirie");
  });

  it("API: citită (idempotent), toate citite, ștergere, 404 pentru alt utilizator; filtrul unread", async () => {
    const list = await call(NT.listNotificationsHandler, "/api/v1/notifications", {
      bearer: A.bearer,
    });
    const items = list.body.data as NotificationJson[];
    const first = items[0]!;
    const read = await call(
      NT.readNotificationHandler,
      `/api/v1/notifications/${first.id}/read`,
      { bearer: A.bearer, method: "POST" },
      first.id,
    );
    expect(read.status).toBe(204);
    const again = await call(
      NT.readNotificationHandler,
      `/api/v1/notifications/${first.id}/read`,
      { bearer: A.bearer, method: "POST" },
      first.id,
    );
    expect(again.status).toBe(204);
    const unreadOnly = await call(
      NT.listNotificationsHandler,
      "/api/v1/notifications?unread=true",
      { bearer: A.bearer },
    );
    expect((unreadOnly.body.data as NotificationJson[]).some((n) => n.id === first.id)).toBe(false);
    expect(unreadOnly.body.unread).toBe(items.length - 1);

    // Bogdan: nu vede nimic, nu poate marca sau șterge ale Anei.
    const b = await call(NT.listNotificationsHandler, "/api/v1/notifications", {
      bearer: B.bearer,
    });
    expect(b.body.data).toEqual([]);
    const bRead = await call(
      NT.readNotificationHandler,
      `/api/v1/notifications/${first.id}/read`,
      { bearer: B.bearer, method: "POST" },
      first.id,
    );
    expect(bRead.status).toBe(404);
    const bDel = await call(
      NT.deleteNotificationHandler,
      `/api/v1/notifications/${first.id}`,
      { bearer: B.bearer, method: "DELETE" },
      first.id,
    );
    expect(bDel.status).toBe(404);

    const all = await call(NT.readAllNotificationsHandler, "/api/v1/notifications/read-all", {
      bearer: A.bearer,
      method: "POST",
    });
    expect(all.status).toBe(200);
    expect((all.body.data as { updated: number }).updated).toBe(items.length - 1);
    const del = await call(
      NT.deleteNotificationHandler,
      `/api/v1/notifications/${first.id}`,
      { bearer: A.bearer, method: "DELETE" },
      first.id,
    );
    expect(del.status).toBe(204);
    const delAgain = await call(
      NT.deleteNotificationHandler,
      `/api/v1/notifications/${first.id}`,
      { bearer: A.bearer, method: "DELETE" },
      first.id,
    );
    expect(delAgain.status).toBe(404);
    const after = await call(NT.listNotificationsHandler, "/api/v1/notifications", {
      bearer: A.bearer,
    });
    expect(after.body.unread).toBe(0);
    expect((after.body.data as NotificationJson[]).length).toBe(items.length - 1);
  });

  it("preferințele: implicit toate; tipuri oprite nu se mai generează; inApp = false oprește evaluarea; email = digest", async () => {
    const def = await call(
      NT.getNotificationPreferencesHandler,
      "/api/v1/me/notification-preferences",
      { bearer: A.bearer },
    );
    expect(def.status).toBe(200);
    expect(def.body.data).toMatchObject({ inApp: true, email: false });
    expect((def.body.data as { kinds: string[] }).kinds).toHaveLength(8);

    const put = await call(
      NT.putNotificationPreferencesHandler,
      "/api/v1/me/notification-preferences",
      {
        bearer: A.bearer,
        method: "PUT",
        body: { kinds: ["payment_due"], email: true },
      },
    );
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toEqual({ inApp: true, email: true, kinds: ["payment_due"] });
    const bad = await call(
      NT.putNotificationPreferencesHandler,
      "/api/v1/me/notification-preferences",
      {
        bearer: A.bearer,
        method: "PUT",
        body: { kinds: ["spam"] },
      },
    );
    expect(bad.status).toBe(400);

    // Ștergem tot și reevaluăm: doar `payment_due` intră; digestul pleacă pe email o singură dată.
    await fx.scratch.admin`delete from finet.notifications where user_id = ${anaId}`;
    sent.length = 0;
    const r = await evaluateForMember(deps(), { userId: anaId }, HA, {
      mailer,
      appUrl: "https://finet.exemplu.ro",
    });
    expect(r.inserted).toBe(1);
    expect(r.emailed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ana@exemplu.ro");
    expect(sent[0]!.subject).toBe("FINET: o notificare nouă");
    expect(sent[0]!.text).toContain("Chirie");
    expect(sent[0]!.text).toContain("https://finet.exemplu.ro/recurring/");
    const r2 = await evaluateForMember(deps(), { userId: anaId }, HA, { mailer, appUrl: null });
    expect(r2.emailed).toBe(0);
    expect(sent).toHaveLength(1);

    const off = await call(
      NT.putNotificationPreferencesHandler,
      "/api/v1/me/notification-preferences",
      {
        bearer: A.bearer,
        method: "PUT",
        body: { inApp: false },
      },
    );
    expect(off.status).toBe(200);
    const r3 = await evaluateForMember(deps(), { userId: anaId }, HA, { mailer, appUrl: null });
    expect(r3.skipped).toBe("preferences_off");
    await call(NT.putNotificationPreferencesHandler, "/api/v1/me/notification-preferences", {
      bearer: A.bearer,
      method: "PUT",
      body: {
        inApp: true,
        email: false,
        kinds: ["payment_due", "budget_exceeded", "subscription_renewal"],
      },
    });
  });

  it("jobul workerului: parcurge toate țintele, numără, nu cade la un membru fără date", async () => {
    await fx.scratch.admin`delete from finet.notifications where user_id = ${anaId}`;
    const events: Record<string, unknown>[] = [];
    const s = await handleNotifyEvaluate({
      db: env.db,
      now: () => new Date(clock),
      mailer: null,
      appUrl: null,
      log: (e) => void events.push(e),
    });
    expect(s.targets).toBe(2);
    expect(s.failed).toBe(0);
    expect(s.inserted).toBe(3);
    expect(events.at(-1)).toMatchObject({ job: "notify.evaluate", targets: 2, inserted: 3 });
    const b = await call(NT.listNotificationsHandler, "/api/v1/notifications", {
      bearer: B.bearer,
    });
    expect(b.body.data).toEqual([]);
    const none = await call(NT.listNotificationsHandler, "/api/v1/notifications", {});
    expect(none.status).toBe(401);
  });
});
