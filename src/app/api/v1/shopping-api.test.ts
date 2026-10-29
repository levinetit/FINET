import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { seedReceipt } from "@/modules/shopping/testing";

import type { ApiDeps } from "./_lib/http";
import * as F from "./_lib/family-handlers";
import * as SH from "./_lib/shopping-handlers";
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
 * Listele de cumpărături prin API (handlere reale, PostgreSQL real, aplicația ca `finet_app`;
 * ADR 0022): CRUD, bifare idempotentă, idempotența creării, lista personală invizibilă (404),
 * evenimente live (doar tip + id; lista personală doar la proprietar), comparația (limită de rată,
 * bon neconfirmat, acțiuni asupra propunerilor), sugestii. Contractul OpenAPI la fiecare răspuns.
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;
type ListDetail = {
  list: { id: string; name: string; shared: boolean; itemCount: number; checkedCount: number };
  items: { id: string; name: string; quantity: string; checked: boolean; position: number }[];
};

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1 liste de cumpărături pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  let A: Sessions; // owner HA
  let B: Sessions; // member în HA (gospodăria activă)
  let C: Sessions; // owner HC, din afară
  let idA: string;
  let idB: string;
  let hhA: string;
  const PASS = "parola-liste-12345";
  let keySeq = 0;
  const newKey = () => `liste-cheie-${String(++keySeq).padStart(6, "0")}`;

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
  const createList = (s: Sessions, body: unknown, headers: Record<string, string> = {}) =>
    call(SH.createShoppingListHandler, "/api/v1/shopping-lists", {
      bearer: s.bearer,
      body,
      headers,
    });
  const getList = (s: Sessions, id: string) =>
    call(SH.getShoppingListHandler, `/api/v1/shopping-lists/${id}`, { bearer: s.bearer }, id);
  const patchItem = (s: Sessions, list: string, item: string, body: unknown) =>
    call(
      SH.patchShoppingItemHandler,
      `/api/v1/shopping-lists/${list}/items/${item}`,
      { bearer: s.bearer, method: "PATCH", body },
      list,
      item,
    );

  async function openEvents(s: Sessions) {
    const abort = new AbortController();
    const request = new Request(apiRequest("/api/v1/events", { bearer: s.bearer }), {
      signal: abort.signal,
    });
    const res = await F.eventsHandler(request, env);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
    async function frame(ms: number): Promise<string | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const f = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          return f;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        inflight ??= reader.read();
        const chunk = await Promise.race([
          inflight,
          new Promise<null>((r) => setTimeout(() => r(null), left)),
        ]);
        if (chunk === null) return null;
        inflight = null;
        if (chunk.done) return null;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    await frame(1500); // ready
    return {
      async nextChange(ms = 1200): Promise<{ type: string; id: string } | null> {
        const deadline = Date.now() + ms;
        for (;;) {
          const f = await frame(Math.max(1, deadline - Date.now()));
          if (f === null) return null;
          if (f.includes("event: change")) {
            return JSON.parse(
              f
                .split("\n")
                .find((l) => l.startsWith("data: "))!
                .slice(6),
            );
          }
        }
      },
      abort: () => abort.abort(),
    };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_shop_api");
    env = {
      ...authEnv(fx.db),
      limits: { mutations: { max: 100_000, windowSeconds: 60 } },
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
    await mk("cora@exemplu.ro", "Cora");
    idA = a.userId;
    idB = b.userId;
    hhA = a.householdId!;
    // B devine membru în HA și o alege ca gospodărie activă.
    await fx.scratch.admin`insert into finet.household_members (household_id, user_id, role)
      values (${hhA}, ${idB}, 'member')`;
    await fx.scratch.admin`insert into finet.user_preferences (user_id, active_household_id)
      values (${idB}, ${hhA})
      on conflict (user_id) do update set active_household_id = excluded.active_household_id`;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    C = await sessionsFor(env, "cora@exemplu.ro", PASS);
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("fără sesiune → 401 pe toate rutele noi", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const cases: [Handler, string, ApiInit, ...string[]][] = [
      [SH.listShoppingListsHandler, "/api/v1/shopping-lists", {}],
      [SH.createShoppingListHandler, "/api/v1/shopping-lists", { body: { name: "x" } }],
      [SH.getShoppingListHandler, `/api/v1/shopping-lists/${id}`, {}, id],
      [SH.shoppingSuggestionsHandler, "/api/v1/shopping-lists/suggestions", {}],
      [SH.shoppingReceiptsHandler, "/api/v1/shopping-lists/receipts", {}],
      [
        SH.runShoppingComparisonHandler,
        `/api/v1/shopping-lists/${id}/comparisons`,
        { body: {} },
        id,
      ],
    ];
    for (const [h, path, init, ...rest] of cases) {
      expect((await call(h, path, init, ...rest)).status, path).toBe(401);
    }
  });

  it("creare cu articole, Idempotency-Key (replay), citire de alt membru, validare strictă", async () => {
    const key = newKey();
    const body = { name: "Weekend", items: [{ name: "Lapte", quantity: "2" }, { name: "Pâine" }] };
    const first = await createList(A, body, { "idempotency-key": key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await createList(A, body, { "idempotency-key": key });
    expect(replay.status).toBe(201);
    expect(replay.res.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body).toEqual(first.body);
    const reused = await createList(A, { name: "Altceva" }, { "idempotency-key": key });
    expect(reused.status).toBe(422);
    const detail = first.body.data as ListDetail;
    expect(detail.list).toMatchObject({ name: "Weekend", shared: true, itemCount: 2 });
    // B (membru) o vede; C (altă gospodărie) primește 404.
    expect((await getList(B, detail.list.id)).status).toBe(200);
    expect((await getList(C, detail.list.id)).status).toBe(404);
    const all = await call(SH.listShoppingListsHandler, "/api/v1/shopping-lists", {
      bearer: B.bearer,
    });
    expect((all.body.data as { id: string }[]).map((l) => l.id)).toContain(detail.list.id);
    // Cheile necunoscute / corp invalid / stare necunoscută.
    expect((await createList(A, { name: "x", householdId: hhA })).status).toBe(400);
    expect((await createList(A, { name: "x", ownerUserId: idA })).status).toBe(400);
    expect((await createList(A, { name: "" })).status).toBe(400);
    const badQuery = await call(SH.listShoppingListsHandler, "/api/v1/shopping-lists?foo=1", {
      bearer: A.bearer,
    });
    expect(badQuery.status).toBe(400);
    const badStatus = await call(SH.listShoppingListsHandler, "/api/v1/shopping-lists?status=x", {
      bearer: A.bearer,
    });
    expect(badStatus.status).toBe(400);
  });

  it("bifarea: stare explicită, idempotentă; ștergerea articolului; id invalid → 404", async () => {
    const created = await createList(A, { name: "Raft", items: [{ name: "Cafea" }] });
    const d = created.body.data as ListDetail;
    const item = d.items[0]!.id;
    const on = await patchItem(B, d.list.id, item, { checked: true });
    expect(on.status).toBe(200);
    const again = await patchItem(A, d.list.id, item, { checked: true });
    expect((again.body.data as { checkedAt: string }).checkedAt).toBe(
      (on.body.data as { checkedAt: string }).checkedAt,
    );
    expect((again.body.data as { checkedByMe: boolean }).checkedByMe).toBe(false);
    expect(((await getList(A, d.list.id)).body.data as ListDetail).list.checkedCount).toBe(1);
    expect((await patchItem(A, d.list.id, item, { checked: "da" })).status).toBe(400);
    expect((await patchItem(A, d.list.id, item, { checked: true, listId: "x" })).status).toBe(400);
    const add = await call(
      SH.addShoppingItemHandler,
      `/api/v1/shopping-lists/${d.list.id}/items`,
      {
        bearer: A.bearer,
        body: { name: "Ceai", quantity: "0,5", unit: "kg" },
        headers: { "idempotency-key": newKey() },
      },
      d.list.id,
    );
    expect(add.status).toBe(201);
    expect((add.body.data as { quantity: string }).quantity).toBe("0.5");
    const del = await call(
      SH.deleteShoppingItemHandler,
      `/api/v1/shopping-lists/${d.list.id}/items/${(add.body.data as { id: string }).id}`,
      { bearer: A.bearer, method: "DELETE" },
      d.list.id,
      (add.body.data as { id: string }).id,
    );
    expect(del.status).toBe(204);
    expect((await getList(A, "nu-e-uuid")).status).toBe(404);
  });

  it("lista personală: invizibilă pentru ceilalți (404 pe orice rută), comună la cerere", async () => {
    const created = await createList(B, {
      name: "Cadouri",
      personal: true,
      items: [{ name: "Eșarfă" }],
    });
    const d = created.body.data as ListDetail;
    expect(d.list.shared).toBe(false);
    expect((await getList(A, d.list.id)).status).toBe(404);
    const listA = await call(SH.listShoppingListsHandler, "/api/v1/shopping-lists", {
      bearer: A.bearer,
    });
    expect(JSON.stringify(listA.body)).not.toContain(d.list.id);
    expect((await patchItem(A, d.list.id, d.items[0]!.id, { checked: true })).status).toBe(404);
    const del = await call(
      SH.deleteShoppingListHandler,
      `/api/v1/shopping-lists/${d.list.id}`,
      { bearer: A.bearer, method: "DELETE" },
      d.list.id,
    );
    expect(del.status).toBe(404);
    const copy = await call(
      SH.copyShoppingListHandler,
      `/api/v1/shopping-lists/${d.list.id}/copy`,
      { bearer: A.bearer, method: "POST" },
      d.list.id,
    );
    expect(copy.status).toBe(404);
    const share = await call(
      SH.patchShoppingListHandler,
      `/api/v1/shopping-lists/${d.list.id}`,
      { bearer: B.bearer, method: "PATCH", body: { shared: true } },
      d.list.id,
    );
    expect(share.status).toBe(200);
    expect((await getList(A, d.list.id)).status).toBe(200);
    // Nu se poate cere „personal” pe PATCH (o listă comună nu devine personală).
    const toPersonal = await call(
      SH.patchShoppingListHandler,
      `/api/v1/shopping-lists/${d.list.id}`,
      { bearer: B.bearer, method: "PATCH", body: { shared: false } },
      d.list.id,
    );
    expect(toPersonal.status).toBe(400);
  });

  it("copiere și reordonare", async () => {
    const created = await createList(A, {
      name: "Ordine",
      items: [{ name: "a1" }, { name: "b2" }, { name: "c3" }],
    });
    const d = created.body.data as ListDetail;
    const ids = d.items.map((i) => i.id);
    const order = await call(
      SH.reorderShoppingItemsHandler,
      `/api/v1/shopping-lists/${d.list.id}/order`,
      { bearer: A.bearer, method: "PUT", body: { itemIds: [ids[2], ids[0], ids[1]] } },
      d.list.id,
    );
    expect(order.status).toBe(200);
    expect((order.body.data as ListDetail).items.map((i) => i.name)).toEqual(["c3", "a1", "b2"]);
    const mismatch = await call(
      SH.reorderShoppingItemsHandler,
      `/api/v1/shopping-lists/${d.list.id}/order`,
      { bearer: A.bearer, method: "PUT", body: { itemIds: [ids[0]] } },
      d.list.id,
    );
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error?.reason).toBe("order_mismatch");
    const copy = await call(
      SH.copyShoppingListHandler,
      `/api/v1/shopping-lists/${d.list.id}/copy`,
      {
        bearer: A.bearer,
        method: "POST",
        body: { name: "Copia" },
        headers: { "idempotency-key": newKey() },
      },
      d.list.id,
    );
    expect(copy.status).toBe(201);
    expect((copy.body.data as ListDetail).items.map((i) => i.name)).toEqual(["c3", "a1", "b2"]);
  });

  it("evenimente live: lista comună ajunge la B (doar tip + id), cea personală doar la proprietar", async () => {
    const shared = (await createList(A, { name: "Live", items: [{ name: "Ouă" }] })).body
      .data as ListDetail;
    const streamB = await openEvents(B);
    const streamA = await openEvents(A);
    try {
      await patchItem(A, shared.list.id, shared.items[0]!.id, { checked: true });
      const seen = await streamB.nextChange();
      expect(seen).toEqual({ type: "shopping_list", id: shared.list.id });
      // Doar tip + id: niciun nume sau conținut în cadru.
      expect(JSON.stringify(seen)).not.toContain("Ouă");
      // Lista personală a lui A: B nu primește nimic, A primește.
      const personal = (await createList(A, { name: "Secret", personal: true })).body
        .data as ListDetail;
      expect(await streamA.nextChange()).toMatchObject({
        type: "shopping_list",
        id: expect.any(String),
      });
      const leak = await streamB.nextChange(600);
      expect(leak?.id).not.toBe(personal.list.id);
    } finally {
      streamA.abort();
      streamB.abort();
    }
  });

  it("comparația: bon neconfirmat → 409, propuneri, acțiuni, GET persistat, limita de rată", async () => {
    const list = (
      await createList(A, {
        name: "Cumpărături",
        items: [{ name: "lapte" }, { name: "pâine" }, { name: "cafea" }],
      })
    ).body.data as ListDetail;
    const saved = await seedReceipt(fx.scratch.admin, hhA, idA, [
      ["LAPTE ZUZU 1,5% 1L"],
      ["PAINE FELIATA 500G"],
      ["SAMPON HAIR 400ML"],
    ]);
    const draft = await seedReceipt(fx.scratch.admin, hhA, idA, [["LAPTE"]], {
      status: "needs_review",
    });
    const run = (s: Sessions, receiptId: string, deps?: ApiDeps) =>
      call(
        SH.runShoppingComparisonHandler,
        `/api/v1/shopping-lists/${list.list.id}/comparisons`,
        { bearer: s.bearer, method: "POST", body: { receiptId } },
        list.list.id,
      ).then((r) => (deps ? r : r));
    expect((await run(A, draft.id)).status).toBe(409);
    expect((await run(C, saved.id)).status).toBe(404);
    const ok = await run(A, saved.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const view = ok.body.data as {
      matched: { item: { id: string; name: string }; line: { name: string }; status: string }[];
      unplanned: { name: string }[];
      forgotten: { name: string }[];
      ai: { status: string };
    };
    expect(view.matched.map((m) => [m.item.name, m.status])).toEqual([
      ["lapte", "suggested"],
      ["pâine", "suggested"],
    ]);
    expect(view.unplanned.map((l) => l.name)).toEqual(["SAMPON HAIR 400ML"]);
    expect(view.forgotten.map((i) => i.name)).toEqual(["cafea"]);
    expect(view.ai.status).toBe("none");

    // B confirmă laptele și respinge pâinea; A vede starea persistată.
    const matchPath = (item: string) =>
      `/api/v1/shopping-lists/${list.list.id}/items/${item}/match`;
    const lapte = view.matched[0]!.item.id;
    const paine = view.matched[1]!.item.id;
    const confirm = await call(
      SH.matchShoppingItemHandler,
      matchPath(lapte),
      { bearer: B.bearer, method: "POST", body: { action: "confirm" } },
      list.list.id,
      lapte,
    );
    expect(confirm.status).toBe(200);
    expect((confirm.body.data as { match: { status: string } }).match.status).toBe("confirmed");
    await call(
      SH.matchShoppingItemHandler,
      matchPath(paine),
      { bearer: B.bearer, method: "POST", body: { action: "reject" } },
      list.list.id,
      paine,
    );
    const bad = await call(
      SH.matchShoppingItemHandler,
      matchPath(paine),
      { bearer: B.bearer, method: "POST", body: { action: "set" } },
      list.list.id,
      paine,
    );
    expect(bad.status).toBe(400);
    const none = await call(
      SH.matchShoppingItemHandler,
      matchPath(lapte),
      { bearer: B.bearer, method: "POST", body: { action: "confirm", extra: 1 } },
      list.list.id,
      lapte,
    );
    expect(none.status).toBe(400);
    const got = await call(
      SH.getShoppingComparisonHandler,
      `/api/v1/shopping-lists/${list.list.id}/comparisons/${saved.id}`,
      { bearer: A.bearer },
      list.list.id,
      saved.id,
    );
    expect(got.status).toBe(200);
    const gv = got.body.data as { matched: { status: string }[]; unplanned: { name: string }[] };
    expect(gv.matched.map((m) => m.status)).toEqual(["confirmed"]);
    expect(gv.unplanned.map((l) => l.name)).toEqual(["PAINE FELIATA 500G", "SAMPON HAIR 400ML"]);

    // Bonurile oferite: doar cele confirmate din gospodărie.
    const rec = await call(SH.shoppingReceiptsHandler, "/api/v1/shopping-lists/receipts", {
      bearer: A.bearer,
    });
    const recIds = (rec.body.data as { id: string }[]).map((r) => r.id);
    expect(recIds).toContain(saved.id);
    expect(recIds).not.toContain(draft.id);

    // Limita de rată a comparației: a treia cerere dintr-o fereastră de 2 → 429.
    const strict: ApiDeps = {
      ...env,
      limits: { ...env.limits, shoppingCompare: { max: 2, windowSeconds: 600 } },
    };
    const runStrict = async () => {
      const res = await SH.runShoppingComparisonHandler(
        apiRequest(`/api/v1/shopping-lists/${list.list.id}/comparisons`, {
          bearer: B.bearer,
          method: "POST",
          body: { receiptId: saved.id },
        }),
        strict,
        list.list.id,
      );
      await assertContract(SH.runShoppingComparisonHandler, res);
      return res;
    };
    expect((await runStrict()).status).toBe(200);
    expect((await runStrict()).status).toBe(200);
    const limited = await runStrict();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("sugestiile: produse frecvente, parametri strict, limită de rată", async () => {
    await seedReceipt(fx.scratch.admin, hhA, idA, [["BANANE"], ["BANANE"]]);
    const sug = await call(
      SH.shoppingSuggestionsHandler,
      "/api/v1/shopping-lists/suggestions?q=ban",
      {
        bearer: A.bearer,
      },
    );
    expect(sug.status).toBe(200);
    expect((sug.body.data as { name: string }[]).map((s) => s.name)).toEqual(["banane"]);
    expect(
      (
        await call(SH.shoppingSuggestionsHandler, "/api/v1/shopping-lists/suggestions?z=1", {
          bearer: A.bearer,
        })
      ).status,
    ).toBe(400);
    const strict: ApiDeps = {
      ...env,
      limits: { ...env.limits, shoppingSuggest: { max: 1, windowSeconds: 600 } },
    };
    const hit = () =>
      SH.shoppingSuggestionsHandler(
        apiRequest("/api/v1/shopping-lists/suggestions", { bearer: C.bearer }),
        strict,
      );
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
  });
});
