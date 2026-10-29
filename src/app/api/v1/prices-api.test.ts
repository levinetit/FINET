import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { addMemberByEmail, createUserWithHousehold } from "@/modules/auth/users.service";
import { seedReceipt } from "@/modules/prices/testing";
import { SYSTEM_REPORTS } from "@/modules/report-definitions/system-definitions";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as PR from "./_lib/prices-handlers";
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
 * Acceptarea F10-B prin API (handlere reale, PostgreSQL real, aplicația ca `finet_app`): prețuri,
 * serii, inflație, definiții de rapoarte (CRUD, Zod strict, `Idempotency-Key`), rulare,
 * previzualizare, export CSV (antete, BOM, garda `Sec-Fetch-Site`, escape), 401, izolare (404),
 * vizibilitatea conturilor personale, rate limit pe rulare (429) și contractul OpenAPI.
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;
const NIL = "00000000-0000-4000-8000-000000000000";
const SYS = Object.fromEntries(SYSTEM_REPORTS.map((r) => [r.key, r.id])) as Record<string, string>;

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1 prețuri și rapoarte pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions; // owner HA
  let B: Sessions; // owner HB
  let C: Sessions; // member HA
  let HA: string;
  let HB: string;
  let idA: string;
  let idC: string;
  let keySeq = 0;
  const PASS = "parola-preturi-1234";
  const newKey = () => `preturi-cheie-${String(++keySeq).padStart(6, "0")}`;

  async function callWith(
    deps: ApiDeps,
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ): Promise<{ status: number; body: Body; res: Response; text: string }> {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      deps,
      ...rest,
    );
    await assertContract(handler, res);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await res.clone().arrayBuffer(),
    );
    const isCsv = (res.headers.get("content-type") ?? "").startsWith("text/csv");
    return {
      status: res.status,
      body: isCsv || !text ? {} : (JSON.parse(text) as Body),
      res,
      text,
    };
  }
  const call = (handler: Handler, path: string, init: ApiInit, ...rest: string[]) =>
    callWith(env, handler, path, init, ...rest);

  const data = <T = Record<string, unknown>>(r: { body: Body }) => r.body.data as T;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_prices_api");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        exports: { max: 100_000, windowSeconds: 60 },
        reportRun: { max: 100_000, windowSeconds: 60 },
      },
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
    HA = ana.householdId!;
    const bogdan = await mk("bogdan@exemplu.ro", "Bogdan");
    HB = bogdan.householdId!;
    const c = await mk("cristi@exemplu.ro", "Cristi");
    await addMemberByEmail(fx.db, HA, "cristi@exemplu.ro", "member");
    await fx.scratch.admin`delete from finet.households where id = ${c.householdId!}`;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    C = await sessionsFor(env, "cristi@exemplu.ro", PASS);
    const ids = await fx.scratch.admin<{ id: string; email: string }[]>`
      select id, email from finet.users where email in ('ana@exemplu.ro', 'cristi@exemplu.ro')`;
    idA = ids.find((u) => u.email === "ana@exemplu.ro")!.id;
    idC = ids.find((u) => u.email === "cristi@exemplu.ro")!.id;

    const acc = async (s: Sessions, name: string, ownerUserId?: string) => {
      const r = await call(L.createAccountHandler, "/api/v1/accounts", {
        bearer: s.bearer,
        body: { name, type: "bank", currency: "RON", ...(ownerUserId ? { ownerUserId } : {}) },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return data<{ id: string }>(r).id;
    };
    const common = await acc(A, "Comun");
    const personalC = await acc(C, "Personal Cristi", idC);
    const accB = await acc(B, "Contul lui Bogdan");
    const base = { householdId: HA, actorId: idA, accountId: common };
    // 4 luni de lapte la două magazine, plus pungi, SGR și o reducere
    for (const [on, price, store] of [
      ["2026-07-08", 780, "L"],
      ["2026-08-09", 790, "L"],
      ["2026-09-10", 810, "L"],
      ["2026-10-09", 800, "L"],
      ["2026-09-20", 700, "K"],
      ["2026-10-20", 720, "K"],
    ] as const) {
      await seedReceipt(fx.scratch.admin, {
        ...base,
        on,
        merchant: store === "L" ? "LIDL DISCOUNT SRL" : "KAUFLAND ROMANIA SCS",
        cui: store === "L" ? "RO22891860" : "RO15991149",
        lines: [
          { name: "LAPTE ZUZU 1,5% 1L", quantity: "1", totalMinor: price },
          { name: "PUNGA RAFIE", quantity: "1", totalMinor: 50, kind: "bag" },
        ],
      });
    }
    await seedReceipt(fx.scratch.admin, {
      ...base,
      on: "2026-10-10",
      merchant: "=CMD|' /C calc'!A0",
      lines: [
        { name: "-1+1 PUNGA INJECTIE", quantity: "1", totalMinor: 10, kind: "bag" },
        { name: "GARANTIE SGR", quantity: "2", totalMinor: 100, kind: "deposit_sgr" },
        { name: "RETUR SGR", quantity: null, totalMinor: 50, kind: "discount" },
      ],
    });
    await seedReceipt(fx.scratch.admin, {
      householdId: HA,
      actorId: idC,
      accountId: personalC,
      on: "2026-10-11",
      merchant: "KAUFLAND ROMANIA SCS",
      cui: "RO15991149",
      lines: [{ name: "PUNGA PERSONALA", quantity: "4", totalMinor: 400, kind: "bag" }],
    });
    await seedReceipt(fx.scratch.admin, {
      householdId: HB,
      actorId: bogdan.userId,
      accountId: accB,
      on: "2026-10-10",
      lines: [{ name: "PUNGA STRAINA", quantity: "1", totalMinor: 9999, kind: "bag" }],
    });
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("fără sesiune (și cu bearer inventat): 401 pe FIECARE endpoint nou", async () => {
    const cases: [Handler, string, ApiInit, ...string[]][] = [
      [PR.productsHandler, "/api/v1/prices/products", {}],
      [PR.seriesHandler, "/api/v1/prices/series?product=l%7Cx", {}],
      [PR.inflationHandler, "/api/v1/inflation", {}],
      [PR.listReportDefinitionsHandler, "/api/v1/report-definitions", {}],
      [PR.createReportDefinitionHandler, "/api/v1/report-definitions", { body: {} }],
      [PR.previewReportHandler, "/api/v1/report-definitions/preview", { body: {} }],
      [PR.getReportDefinitionHandler, `/api/v1/report-definitions/${NIL}`, {}, NIL],
      [
        PR.patchReportDefinitionHandler,
        `/api/v1/report-definitions/${NIL}`,
        { method: "PATCH", body: {} },
        NIL,
      ],
      [
        PR.deleteReportDefinitionHandler,
        `/api/v1/report-definitions/${NIL}`,
        { method: "DELETE" },
        NIL,
      ],
      [PR.runReportHandler, `/api/v1/report-definitions/${NIL}/run`, {}, NIL],
      [PR.exportReportHandler, `/api/v1/report-definitions/${NIL}/export.csv`, {}, NIL],
    ];
    for (const [handler, path, init, ...rest] of cases) {
      for (const auth of [{}, { bearer: "inventat-123456" }]) {
        const r = await call(handler, path, { ...init, ...auth }, ...rest);
        expect(r.status, path).toBe(401);
      }
    }
  });

  it("prețuri: produse cu prag de date, cel mai ieftin comerciant, parametri stricți", async () => {
    const r = await call(PR.productsHandler, "/api/v1/prices/products?months=12", {
      bearer: A.bearer,
    });
    expect(r.status, r.text).toBe(200);
    const d = data<{
      products: {
        name: string;
        enough: boolean;
        priceMinor: number | null;
        cheapest: null | { cheapest: { merchantKey: string } };
      }[];
      thresholds: { minObservations: number; minMonths: number };
    }>(r);
    expect(d.thresholds).toEqual({ minObservations: 3, minMonths: 2 });
    const milk = d.products.find((p) => p.name === "lapte zuzu 1.5%")!;
    expect(milk).toMatchObject({ enough: true, priceMinor: 767 }); // 4600 bani / 6 l = 766,67 → 767
    expect(milk.cheapest!.cheapest.merchantKey).toBe("15991149");
    // sub prag, dacă îl cerem strict
    const strict = await call(PR.productsHandler, "/api/v1/prices/products?minObservations=50", {
      bearer: A.bearer,
    });
    expect(
      data<{ products: { enough: boolean; priceMinor: number | null }[] }>(strict).products.every(
        (p) => !p.enough && p.priceMinor === null,
      ),
    ).toBe(true);
    for (const bad of [
      "?months=0",
      "?months=abc",
      "?limit=9999",
      "?necunoscut=1",
      "?currency=XYZ",
      "?months=1&months=2",
    ]) {
      const b = await call(PR.productsHandler, `/api/v1/prices/products${bad}`, {
        bearer: A.bearer,
      });
      expect(b.status, bad).toBe(400);
    }
  });

  it("serie lunară; produs inexistent → 404; fără `product` → 400", async () => {
    const r = await call(
      PR.seriesHandler,
      `/api/v1/prices/series?product=${encodeURIComponent("l|lapte zuzu 1.5%")}&months=6`,
      { bearer: A.bearer },
    );
    expect(r.status, r.text).toBe(200);
    const s = data<{
      overall: { bucket: string }[];
      byMerchant: { merchantKey: string }[];
      enough: boolean;
    }>(r);
    expect(s.enough).toBe(true);
    expect(s.overall.map((p) => p.bucket)).toEqual(["2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(s.byMerchant.map((m) => m.merchantKey)).toEqual(["15991149", "22891860"]);
    expect(
      (
        await call(PR.seriesHandler, "/api/v1/prices/series?product=l%7Cnimic", {
          bearer: A.bearer,
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(PR.seriesHandler, "/api/v1/prices/series", { bearer: A.bearer })).status,
    ).toBe(400);
  });

  it("inflația: structură, praguri, parametri stricți", async () => {
    const r = await call(
      PR.inflationHandler,
      "/api/v1/inflation?months=3&baseline=previous&minItems=1&minObservations=1",
      {
        bearer: A.bearer,
      },
    );
    expect(r.status, r.text).toBe(200);
    const d = data<{
      base: { from: string; to: string };
      current: { from: string };
      currencies: { currency: string; status: string; changeBps: number | null }[];
    }>(r);
    expect(d.current.from).toBe("2026-08-01");
    expect(d.base).toEqual({ from: "2026-05-01", to: "2026-07-31" });
    const ron = d.currencies.find((c) => c.currency === "RON")!;
    expect(ron.status).toBe("ok");
    for (const bad of ["?months=0", "?months=13", "?baseline=oricând", "?x=1"]) {
      expect(
        (await call(PR.inflationHandler, `/api/v1/inflation${bad}`, { bearer: A.bearer })).status,
        bad,
      ).toBe(400);
    }
    // implicit: 5 articole necesare → date insuficiente, fără variație
    const dflt = await call(PR.inflationHandler, "/api/v1/inflation", { bearer: A.bearer });
    const ronD = data<{ currencies: { status: string; changeBps: number | null }[] }>(dflt)
      .currencies[0];
    expect(ronD ? [ronD.status, ronD.changeBps] : ["insufficient", null]).toEqual([
      "insufficient",
      null,
    ]);
  });

  it("definiții: listă cu cele de sistem, creare idempotentă, Zod strict, izolare, sistem read-only", async () => {
    const list = await call(PR.listReportDefinitionsHandler, "/api/v1/report-definitions", {
      bearer: A.bearer,
    });
    expect(list.status).toBe(200);
    const defs = data<{ id: string; isSystem: boolean }[]>(list);
    expect(
      defs
        .filter((d) => d.isSystem)
        .map((d) => d.id)
        .sort(),
    ).toEqual(Object.values(SYS).sort());

    const body = {
      name: "Pungi personale",
      description: "Pungile mele",
      rules: {
        v: 1,
        combine: "any",
        include: [{ type: "token", value: "PUNGA" }],
        exclude: [{ type: "contains", value: "injectie" }],
        kinds: ["bag"],
        categoryIds: [],
        tagIds: [],
      },
    };
    const key = newKey();
    const created = await call(PR.createReportDefinitionHandler, "/api/v1/report-definitions", {
      bearer: A.bearer,
      body,
      headers: { "idempotency-key": key },
    });
    expect(created.status, created.text).toBe(201);
    const id = data<{ id: string }>(created).id;
    expect(data<{ rules: { include: unknown[] } }>(created).rules.include).toEqual([
      { type: "token", value: "punga" },
    ]);
    const replay = await call(PR.createReportDefinitionHandler, "/api/v1/report-definitions", {
      bearer: A.bearer,
      body,
      headers: { "idempotency-key": key },
    });
    expect(replay.status).toBe(201);
    expect(replay.res.headers.get("idempotent-replay")).toBe("true");
    expect(data<{ id: string }>(replay).id).toBe(id);
    // aceeași cheie, alt corp → 422
    const reused = await call(PR.createReportDefinitionHandler, "/api/v1/report-definitions", {
      bearer: A.bearer,
      body: { ...body, name: "Altul" },
      headers: { "idempotency-key": key },
    });
    expect(reused.status).toBe(422);
    // nume duplicat → 409
    const dup = await call(PR.createReportDefinitionHandler, "/api/v1/report-definitions", {
      bearer: A.bearer,
      body: { ...body, name: "PUNGI personale" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.reason).toBe("report_name_taken");
    // Zod strict
    for (const bad of [
      { ...body, householdId: HB },
      { ...body, isSystem: true },
      { ...body, rules: { ...body.rules, include: [{ type: "regex", value: "x" }] } },
      { ...body, name: "" },
      { name: "fără reguli" },
    ]) {
      const r = await call(PR.createReportDefinitionHandler, "/api/v1/report-definitions", {
        bearer: A.bearer,
        body: bad,
      });
      expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    // Cristi (alt membru HA) o vede; Bogdan (HB) nu
    const asC = await call(
      PR.getReportDefinitionHandler,
      `/api/v1/report-definitions/${id}`,
      { bearer: C.bearer },
      id,
    );
    expect(asC.status).toBe(200);
    for (const [h, init] of [
      [PR.getReportDefinitionHandler, {}],
      [PR.patchReportDefinitionHandler, { method: "PATCH", body: { name: "X" } }],
      [PR.deleteReportDefinitionHandler, { method: "DELETE" }],
      [PR.runReportHandler, {}],
    ] as const) {
      const path = `/api/v1/report-definitions/${id}${h === PR.runReportHandler ? "/run" : ""}`;
      const r = await call(h as Handler, path, { ...init, bearer: B.bearer }, id);
      expect(r.status, path).toBe(404);
    }
    // id invalid → 404
    expect(
      (
        await call(
          PR.getReportDefinitionHandler,
          "/api/v1/report-definitions/nu-e-uuid",
          { bearer: A.bearer },
          "nu-e-uuid",
        )
      ).status,
    ).toBe(404);
    // sistemul: citibil, nemodificabil
    const sys = await call(
      PR.getReportDefinitionHandler,
      `/api/v1/report-definitions/${SYS.bags}`,
      { bearer: B.bearer },
      SYS.bags!,
    );
    expect(sys.status).toBe(200);
    expect(data<{ isSystem: boolean }>(sys).isSystem).toBe(true);
    const patchSys = await call(
      PR.patchReportDefinitionHandler,
      `/api/v1/report-definitions/${SYS.bags}`,
      { method: "PATCH", bearer: A.bearer, body: { name: "x" } },
      SYS.bags!,
    );
    expect(patchSys.status).toBe(403);
    const delSys = await call(
      PR.deleteReportDefinitionHandler,
      `/api/v1/report-definitions/${SYS.bags}`,
      { method: "DELETE", bearer: A.bearer },
      SYS.bags!,
    );
    expect(delSys.status).toBe(403);
    // PATCH + DELETE pe cel propriu
    const patched = await call(
      PR.patchReportDefinitionHandler,
      `/api/v1/report-definitions/${id}`,
      { method: "PATCH", bearer: C.bearer, body: { description: null, archived: true } },
      id,
    );
    expect(patched.status, patched.text).toBe(200);
    expect(data<{ archived: boolean; description: string | null }>(patched)).toMatchObject({
      archived: true,
      description: null,
    });
    const del = await call(
      PR.deleteReportDefinitionHandler,
      `/api/v1/report-definitions/${id}`,
      { method: "DELETE", bearer: A.bearer },
      id,
    );
    expect(del.status).toBe(204);
  });

  it("rulare: pungi — conturile personale ale altora nu intră; perioade; parametri stricți", async () => {
    const asA = await call(
      PR.runReportHandler,
      `/api/v1/report-definitions/${SYS.bags}/run`,
      { bearer: A.bearer },
      SYS.bags!,
    );
    expect(asA.status, asA.text).toBe(200);
    const a = data<{
      currencies: { totalMinor: number; lineCount: number }[];
      lines: { name: string; receiptId: string }[];
      definition: { id: string };
    }>(asA);
    // 6 × 50 (pungi) + 10 (INJECTIE) — fără «PUNGA PERSONALA» (cont personal Cristi) și fără HB
    expect(a.currencies[0]).toMatchObject({ totalMinor: 310, lineCount: 7 });
    expect(a.lines.map((l) => l.name)).not.toContain("PUNGA PERSONALA");
    expect(a.lines.map((l) => l.name)).not.toContain("PUNGA STRAINA");
    const asC = await call(
      PR.runReportHandler,
      `/api/v1/report-definitions/${SYS.bags}/run`,
      { bearer: C.bearer },
      SYS.bags!,
    );
    expect(data<{ currencies: { totalMinor: number }[] }>(asC).currencies[0]!.totalMinor).toBe(710);
    const asB = await call(
      PR.runReportHandler,
      `/api/v1/report-definitions/${SYS.bags}/run`,
      { bearer: B.bearer },
      SYS.bags!,
    );
    expect(data<{ currencies: { totalMinor: number }[] }>(asB).currencies[0]!.totalMinor).toBe(
      9999,
    );
    const oct = await call(
      PR.runReportHandler,
      `/api/v1/report-definitions/${SYS.bags}/run?period=this_month`,
      { bearer: A.bearer },
      SYS.bags!,
    );
    expect(
      data<{
        from: string;
        to: string;
        currencies: { totalMinor: number; projection: { status: string } }[];
      }>(oct),
    ).toMatchObject({ from: "2026-10-01", to: "2026-10-28" });
    expect(
      data<{ currencies: { projection: { status: string } }[] }>(oct).currencies[0]!.projection
        .status,
    ).toBe("insufficient");
    for (const bad of ["?period=ieri", "?x=1", "?period=all&period=all"]) {
      expect(
        (
          await call(
            PR.runReportHandler,
            `/api/v1/report-definitions/${SYS.bags}/run${bad}`,
            { bearer: A.bearer },
            SYS.bags!,
          )
        ).status,
        bad,
      ).toBe(400);
    }
    expect(
      (
        await call(
          PR.runReportHandler,
          `/api/v1/report-definitions/${NIL}/run`,
          { bearer: A.bearer },
          NIL,
        )
      ).status,
    ).toBe(404);
  });

  it("previzualizare: nu salvează; corp strict", async () => {
    const before = await fx.scratch.admin`select count(*)::int as n from finet.report_definitions`;
    const r = await call(PR.previewReportHandler, "/api/v1/report-definitions/preview", {
      bearer: A.bearer,
      body: {
        rules: {
          v: 1,
          combine: "any",
          include: [{ type: "prefix", value: "lapte" }],
          exclude: [],
          kinds: ["product"],
          categoryIds: [],
          tagIds: [],
        },
        period: "all",
      },
    });
    expect(r.status, r.text).toBe(200);
    const d = data<{ definition: unknown; currencies: { totalMinor: number }[] }>(r);
    expect(d.definition).toBeNull();
    expect(d.currencies[0]!.totalMinor).toBe(780 + 790 + 810 + 800 + 700 + 720);
    const after = await fx.scratch.admin`select count(*)::int as n from finet.report_definitions`;
    expect(after[0]!.n).toBe(before[0]!.n);
    for (const bad of [{}, { rules: {} }, { rules: { v: 1 }, extra: 1 }]) {
      expect(
        (
          await call(PR.previewReportHandler, "/api/v1/report-definitions/preview", {
            bearer: A.bearer,
            body: bad,
          })
        ).status,
      ).toBe(400);
    }
  });

  it("export CSV: antete, BOM, escape, garda Sec-Fetch-Site, dialect, izolare", async () => {
    const path = `/api/v1/report-definitions/${SYS.bags}/export.csv`;
    for (const site of ["cross-site", "same-site", ""]) {
      const r = await call(
        PR.exportReportHandler,
        path,
        { cookie: A.cookie, headers: { "sec-fetch-site": site } },
        SYS.bags!,
      );
      expect(r.status, site || "lipsă").toBe(403);
    }
    const ok = await call(
      PR.exportReportHandler,
      path,
      { cookie: A.cookie, headers: { "sec-fetch-site": "same-origin" } },
      SYS.bags!,
    );
    expect(ok.status).toBe(200);
    const rows = ok.text.replace(/^﻿/, "").trim().split("\r\n");
    expect(rows[0]).toBe(
      "line_id,receipt_id,occurred_on,merchant,name,kind,quantity,currency,line_total_minor,line_total",
    );
    expect(rows).toHaveLength(1 + 7);
    expect(ok.text).toContain("'=CMD|");
    expect(ok.text).toContain("'-1+1 PUNGA INJECTIE");
    expect(ok.text).not.toContain("PUNGA PERSONALA");
    // dialect ro: separator `;`, virgulă zecimală
    const ro = await call(
      PR.exportReportHandler,
      `${path}?dialect=ro&period=this_month`,
      { bearer: A.bearer },
      SYS.bags!,
    );
    expect(ro.status).toBe(200);
    expect(ro.text.split("\r\n")[0]).toContain(";");
    expect(ro.text).toMatch(/;0,50\r\n/);
    expect(
      (await call(PR.exportReportHandler, `${path}?dialect=xx`, { bearer: A.bearer }, SYS.bags!))
        .status,
    ).toBe(400);
    expect(
      (await call(PR.exportReportHandler, `${path}?period=ieri`, { bearer: A.bearer }, SYS.bags!))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          PR.exportReportHandler,
          `/api/v1/report-definitions/${NIL}/export.csv`,
          { bearer: A.bearer },
          NIL,
        )
      ).status,
    ).toBe(404);
  });

  it("rate limit: rularea/previzualizarea (429, Retry-After) și exportul", async () => {
    // O fereastră nouă (ceas deplasat cu o oră), ca apelurile anterioare să nu intre în numărătoare.
    const limited: AuthEnv & ApiDeps = {
      ...env,
      now: () => clock + 3_600_000,
      limits: {
        ...env.limits,
        reportRun: { max: 2, windowSeconds: 60 },
        exports: { max: 1, windowSeconds: 60 },
      },
    };
    const run = () =>
      callWith(
        limited,
        PR.runReportHandler as Handler,
        `/api/v1/report-definitions/${SYS.savings}/run`,
        { bearer: B.bearer },
        SYS.savings!,
      );
    expect((await run()).status).toBe(200);
    expect((await run()).status).toBe(200);
    const third = await run();
    expect(third.status).toBe(429);
    expect(third.res.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    // previzualizarea împarte aceeași găleată
    const prev = await callWith(
      limited,
      PR.previewReportHandler as Handler,
      "/api/v1/report-definitions/preview",
      {
        bearer: B.bearer,
        body: {
          rules: {
            v: 1,
            combine: "any",
            include: [],
            exclude: [],
            kinds: ["product"],
            categoryIds: [],
            tagIds: [],
          },
        },
      },
    );
    expect(prev.status).toBe(429);
    const exp = () =>
      callWith(
        limited,
        PR.exportReportHandler as Handler,
        `/api/v1/report-definitions/${SYS.savings}/export.csv`,
        { bearer: B.bearer },
        SYS.savings!,
      );
    expect((await exp()).status).toBe(200);
    expect((await exp()).status).toBe(429);
  });
});
