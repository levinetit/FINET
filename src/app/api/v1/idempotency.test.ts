import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { addMemberByEmail, createUserWithHousehold } from "@/modules/auth/users.service";
import { canonicalJson, requestHash } from "@/modules/idempotency/idempotency";
import { main as adminMain } from "@/tools/admin/cli";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import { type Sessions, apiRequest, assertContract, readJson, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

describe("hash-ul cererii", () => {
  it("JSON canonic: ordinea cheilor nu contează; corpul, calea, metoda și utilizatorul da", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    const base = {
      method: "POST",
      path: "/api/v1/transactions",
      userId: "u1",
      body: { a: 1, b: 2 },
    };
    const h = requestHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash({ ...base, body: { b: 2, a: 1 } })).toBe(h);
    expect(requestHash({ ...base, body: { a: 1, b: 3 } })).not.toBe(h);
    expect(requestHash({ ...base, path: "/api/v1/accounts" })).not.toBe(h);
    expect(requestHash({ ...base, userId: "u2" })).not.toBe(h);
  });
});

describe.skipIf(!TEST_ADMIN_URL)("Idempotency-Key pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  // Ceasul pornește de la momentul rulării: o dată fixă ar îmbătrâni față de ceasul bazei
  // (`now()`) și ar strica numărul de rânduri șterse de curățare după 24 h.
  let clock = Date.now();
  let A: Sessions;
  let B: Sessions;
  let C: Sessions;
  let HA: string;
  let acc: string;
  const PASS = "parola-idempotenta-1";

  const txBody = (amountMinor: number) => ({
    accountId: acc,
    type: "expense",
    amountMinor,
    occurredOn: "2026-10-10",
  });

  async function postTx(s: Sessions, key: string | null, body: unknown, extra: ApiDeps = env) {
    const r = await L.createTransactionHandler(
      apiRequest("/api/v1/transactions", {
        bearer: s.bearer,
        body,
        headers: key === null ? {} : { "idempotency-key": key },
      }),
      extra,
    );
    await assertContract(L.createTransactionHandler, r);
    return r;
  }

  async function txCount(): Promise<number> {
    const [row] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where household_id = ${HA}`;
    return row?.n ?? 0;
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_idem");
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
    HA = (await mk("ana@exemplu.ro", "Ana")).householdId!;
    await mk("bogdan@exemplu.ro", "Bogdan");
    // Cristi e membru DOAR în HA (fără gospodărie personală mai veche): o adăugăm după ce îi ștergem
    // gospodăria personală, ca HA să fie gospodăria lui curentă.
    const c = await mk("cristi@exemplu.ro", "Cristi");
    await addMemberByEmail(fx.db, HA, "cristi@exemplu.ro", "member");
    await fx.scratch.admin`delete from finet.households where id = ${c.householdId!}`;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    C = await sessionsFor(env, "cristi@exemplu.ro", PASS);
    const r = await L.createAccountHandler(
      apiRequest("/api/v1/accounts", {
        bearer: A.bearer,
        body: { name: "Idem", type: "bank", currency: "RON" },
      }),
      env,
    );
    acc = ((await readJson(r)).data as { id: string }).id;
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("aceeași cerere de două ori → o singură tranzacție; al doilea răspuns e reluat identic", async () => {
    const key = "11111111-2222-4333-8444-555555555555";
    const before = await txCount();
    const first = await postTx(A, key, txBody(1234));
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replay")).toBeNull();
    const firstBody = await readJson(first);
    // Ordinea cheilor diferă: același hash canonic.
    const { accountId, ...rest } = txBody(1234);
    const second = await postTx(A, key, { ...rest, accountId });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replay")).toBe("true");
    expect(await readJson(second)).toEqual(firstBody);
    expect(await txCount()).toBe(before + 1);
    const rows = await fx.scratch.admin<{ status_code: number }[]>`
      select status_code from finet.idempotency_keys where household_id = ${HA} and key = ${key}`;
    expect(rows).toEqual([{ status_code: 201 }]);
  });

  it("aceeași cheie, corp diferit → 422; alt membru al gospodăriei → 422; altă gospodărie → independentă", async () => {
    const key = "cheie-reutilizata-0001";
    expect((await postTx(A, key, txBody(10))).status).toBe(201);
    const before = await txCount();
    const other = await postTx(A, key, txBody(11));
    expect(other.status).toBe(422);
    expect((await readJson(other)).error?.code).toBe("idempotency_key_reused");
    const sameBodyOtherUser = await postTx(C, key, txBody(10));
    expect(sameBodyOtherUser.status).toBe(422);
    expect(await txCount()).toBe(before);

    // B are altă gospodărie: aceeași cheie nu îl afectează (și contul lui A îi e invizibil: 404,
    // memorat în gospodăria lui B, fără să atingă cheia lui A).
    const b = await postTx(B, key, txBody(10));
    expect(b.status).toBe(404);
    const keys = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.idempotency_keys where key = ${key}`;
    expect(keys[0]?.n).toBe(2);
  });

  it("corp prea adânc cu cheie → 400 înainte de hash (fără recursie nelimitată)", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 2000; i++) deep = [deep];
    const before = await txCount();
    const r = await postTx(A, "corp-adanc-00000000001", { ...txBody(9), notes: deep });
    expect(r.status).toBe(400);
    expect((await readJson(r)).error?.fields).toEqual({ _: "Cererea are prea multe niveluri." });
    expect(await txCount()).toBe(before);
    expect(() => requestHash({ method: "POST", path: "/x", userId: "u", body: deep })).toThrow(
      RangeError,
    );
  });

  it("cheie invalidă → 400; fără cheie: fiecare cerere scrie", async () => {
    for (const key of [
      "scurta",
      "a".repeat(129),
      "cu spatii in cheie 123",
      "cheie.cu.puncte.invalida",
    ]) {
      const r = await L.createTransactionHandler(
        apiRequest("/api/v1/transactions", {
          bearer: A.bearer,
          body: txBody(5),
          headers: { "idempotency-key": key },
        }),
        env,
      );
      expect(r.status, key).toBe(400);
    }
    const before = await txCount();
    await postTx(A, null, txBody(5));
    await postTx(A, null, txBody(5));
    expect(await txCount()).toBe(before + 2);
  });

  it("erorile 4xx se memorează (reluare), erorile 5xx NU (cheia rămâne liberă)", async () => {
    const key400 = "eroare-de-validare-01";
    const bad = { ...txBody(5), amountMinor: -1 };
    const first = await postTx(A, key400, bad);
    expect(first.status).toBe(400);
    const again = await postTx(A, key400, bad);
    expect(again.status).toBe(400);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(await readJson(again)).toEqual(await readJson(first));

    // 5xx forțat: un trigger care aruncă o eroare neașteptată (P0001) la INSERT.
    await fx.scratch.admin.unsafe(`
      create function finet.test_boom() returns trigger language plpgsql as
        $$ begin raise exception 'boom'; end $$;
      create trigger test_boom before insert on finet.transactions
        for each row execute function finet.test_boom();`);
    const key500 = "eroare-interna-000001";
    const before = await txCount();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const boom = await postTx(A, key500, txBody(77));
      expect(boom.status).toBe(500);
      expect(await readJson(boom)).toEqual({
        error: { code: "internal_error", message: "Eroare internă." },
      });
    } finally {
      spy.mockRestore();
      await fx.scratch.admin.unsafe(
        "drop trigger test_boom on finet.transactions; drop function finet.test_boom();",
      );
    }
    const stored = await fx.scratch
      .admin`select 1 from finet.idempotency_keys where key = ${key500}`;
    expect(stored).toHaveLength(0);
    expect(await txCount()).toBe(before);
    const retry = await postTx(A, key500, txBody(77));
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotent-replay")).toBeNull();
    expect(await txCount()).toBe(before + 1);
  });

  it("o eroare Postgres în savepoint-ul serviciului (23505 → 409) se memorează; tranzacția exterioară rămâne utilizabilă", async () => {
    const post = (key: string | null) =>
      L.createAccountHandler(
        apiRequest("/api/v1/accounts", {
          bearer: A.bearer,
          body: { name: "Dublură", type: "cash", currency: "RON" },
          headers: key === null ? {} : { "idempotency-key": key },
        }),
        env,
      );
    expect((await post(null)).status).toBe(201);
    const count = async () => {
      const [row] = await fx.scratch.admin<{ n: number }[]>`
        select count(*)::int as n from finet.accounts where household_id = ${HA}`;
      return row?.n ?? 0;
    };
    const before = await count();
    const key = "cont-dublat-0000000001";
    const first = await post(key);
    expect(first.status).toBe(409);
    await assertContract(L.createAccountHandler, first);
    const firstBody = await readJson(first);
    expect(firstBody.error).toMatchObject({ code: "conflict", reason: "account_name_taken" });
    const again = await post(key);
    expect(again.status).toBe(409);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(await readJson(again)).toEqual(firstBody);
    expect(await count()).toBe(before);
    const rows = await fx.scratch.admin<{ status_code: number }[]>`
      select status_code from finet.idempotency_keys where key = ${key}`;
    expect(rows).toEqual([{ status_code: 409 }]);
  });

  it("cerere identică în desfășurare → 409 request_in_progress; cereri concurente → o singură scriere", async () => {
    const key = "in-desfasurare-00001";
    // O altă conexiune ține lock-ul cheii (ca o cerere în curs), într-o tranzacție deschisă.
    const lockName = `finet.idempotency:${HA}:${key}`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const before = await txCount();
    const other = testClient(fx.scratch.adminUrl, 1);
    const holder = other.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`;
      locked();
      await held;
    });
    await isLocked;
    const busy = await postTx(A, key, txBody(42));
    expect(busy.status).toBe(409);
    expect((await readJson(busy)).error).toMatchObject({
      code: "request_in_progress",
      reason: "request_in_progress",
    });
    release();
    await holder;
    await other.end({ timeout: 5 });
    expect(await txCount()).toBe(before);

    const key2 = "concurente-000000001";
    const results = await Promise.all([1, 2, 3].map(() => postTx(A, key2, txBody(43))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(statuses).toContain(201);
    expect(await txCount()).toBe(before + 1);
    // După ce prima s-a terminat, o reluare întoarce răspunsul inițial.
    const replay = await postTx(A, key2, txBody(43));
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
  });

  it("expirarea la 24 h (ceas controlat) și curățarea prin finet-admin cleanup-idempotency", async () => {
    const key = "expira-dupa-o-zi-0001";
    expect((await postTx(A, key, txBody(500))).status).toBe(201);
    const before = await txCount();
    clock += 23 * 60 * 60 * 1000;
    expect((await postTx(A, key, txBody(501))).status).toBe(422);
    clock += 2 * 60 * 60 * 1000;
    // Peste 24 h cheia nu mai contează: o cerere nouă (chiar cu alt corp) scrie din nou.
    const fresh = await postTx(A, key, txBody(501));
    expect(fresh.status).toBe(201);
    expect(fresh.headers.get("idempotent-replay")).toBeNull();
    expect(await txCount()).toBe(before + 1);

    // Curățarea (ceasul bazei): rândurile vechi dispar, cele recente rămân.
    await fx.scratch
      .admin`update finet.idempotency_keys set created_at = now() - interval '25 hours'
      where key in ('cheie-reutilizata-0001', 'eroare-de-validare-01')`;
    const [{ total }] = (await fx.scratch.admin<{ total: number }[]>`
      select count(*)::int as total from finet.idempotency_keys`) as unknown as [{ total: number }];
    const run = async () => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await adminMain({
        env: {
          APP_MODE: "personal",
          NODE_ENV: "test",
          FINET_ROLE: "admin",
          DATABASE_URL: "postgres://x:y@localhost:5432/fictiv",
        },
        argv: ["cleanup-idempotency"],
        readStdin: async () => "",
        out: (l) => void out.push(l),
        err: (l) => void err.push(l),
        db: fx.db,
      });
      return { code, out, err };
    };
    const first = await run();
    expect(first).toEqual({ code: 0, out: ["3"], err: [] });
    const second = await run();
    expect(second).toEqual({ code: 0, out: ["0"], err: [] });
    const [{ left }] = (await fx.scratch.admin<{ left: number }[]>`
      select count(*)::int as left from finet.idempotency_keys`) as unknown as [{ left: number }];
    expect(left).toBe(total - 3);
    const stale = await fx.scratch.admin`
      select 1 from finet.idempotency_keys where created_at < now() - interval '24 hours'`;
    expect(stale).toHaveLength(0);
  });

  it("funcția de curățare: SECURITY DEFINER, search_path fix, EXECUTE doar finet_app; fără context nu vede alte chei", async () => {
    const [fn] = await fx.scratch.admin<
      {
        definer: boolean;
        config: string[];
        owner: string;
        app: boolean;
        anon: boolean;
        pub: boolean;
      }[]
    >`
      select p.prosecdef as definer, p.proconfig as config, r.rolname as owner,
             has_function_privilege('finet_app', p.oid, 'EXECUTE') as app,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as pub
        from pg_proc p join pg_roles r on r.oid = p.proowner
       where p.proname = 'purge_idempotency_keys'`;
    expect(fn).toEqual({
      definer: true,
      config: ["search_path=pg_catalog"],
      owner: "finet_migrator",
      app: true,
      anon: false,
      pub: false,
    });
    // finet_app fără context de gospodărie nu vede și nu șterge chei direct (RLS).
    expect(await fx.client`select * from finet.idempotency_keys`).toHaveLength(0);
    expect(await fx.client`delete from finet.idempotency_keys returning id`).toHaveLength(0);
  });
});
