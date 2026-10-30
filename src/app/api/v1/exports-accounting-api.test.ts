import { inflateRawSync } from "node:zlib";

import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { addMemberByEmail, createUserWithHousehold } from "@/modules/auth/users.service";
import { systemCategoryId } from "@/modules/ledger/testing";
import { seedReceipt } from "@/modules/prices/testing";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as P from "./_lib/planning-handlers";
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
 * Exportul pentru contabil și lista bonurilor (F10-C; ADR 0024) prin API, pe PostgreSQL real:
 * defalcarea pe cote, vizibilitatea (contul personal al altui membru), validarea perioadei,
 * plafonul, auditul și cele trei formate.
 */

type Handler = (request: Request, deps: ApiDeps) => Promise<Response>;

function unzipText(buf: Buffer, wanted: string): string {
  const eocd = buf.length - 22;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    if (buf.subarray(p + 46, p + 46 + nlen).toString("utf8") === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26);
      return inflateRawSync(buf.subarray(start, start + csize)).toString("utf8");
    }
    p += 46 + nlen;
  }
  throw new Error(`lipsește ${wanted}`);
}

describe.skipIf(!TEST_ADMIN_URL)("export contabil pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions; // proprietar
  let C: Sessions; // membru
  let B: Sessions; // altă gospodărie
  let HA: string;
  let userA: string;
  const PASS = "parola-export-contabil-1";
  const RANGE = "from=2026-03-01&to=2026-03-31";

  async function call(handler: Handler, path: string, init: ApiInit, deps: ApiDeps = env) {
    const res = await handler(apiRequest(path, init), deps);
    await assertContract(handler as never, res);
    const bytes = Buffer.from(await res.clone().arrayBuffer());
    return { status: res.status, res, bytes, text: bytes.toString("utf8") };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_exports_accounting");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        exports: { max: 100_000, windowSeconds: 60 },
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
    const a = await mk("ana@exemplu.ro", "Ana");
    HA = a.householdId!;
    userA = a.userId;
    await mk("bogdan@exemplu.ro", "Bogdan");
    const c = await mk("cristi@exemplu.ro", "Cristi");
    await addMemberByEmail(fx.db, HA, "cristi@exemplu.ro", "member");
    await fx.scratch.admin`delete from finet.households where id = ${c.householdId!}`;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    C = await sessionsFor(env, "cristi@exemplu.ro", PASS);

    const account = async (body: Record<string, unknown>) => {
      const r = await readJson(
        await L.createAccountHandler(
          apiRequest("/api/v1/accounts", { bearer: A.bearer, body }),
          env,
        ),
      );
      return (r.data as { id: string }).id;
    };
    const shared = await account({ name: "Card comun", type: "bank", currency: "RON" });
    const personal = await account({
      name: "Cardul Anei",
      type: "bank",
      currency: "RON",
      ownerUserId: userA,
    });
    const groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");

    // Bon 1 (cont comun): 119,00 la 19 % + 30,00 la 9 %; TVA pe bon 19,91.
    await seedReceipt(fx.scratch.admin, {
      householdId: HA,
      accountId: shared,
      actorId: userA,
      on: "2026-03-05",
      merchant: "LIDL DISCOUNT SRL",
      cui: "RO22891860",
      number: "0123",
      vatTotalMinor: 1991,
      transactionCategoryId: groceries,
      lines: [
        { name: "Produs A", totalMinor: 11900, vatRate: "19.00" },
        { name: "Produs B", totalMinor: 3000, vatRate: "9.00" },
      ],
    });
    // Bon 2 (cont PERSONAL al Anei): nu trebuie să apară la Cristi.
    await seedReceipt(fx.scratch.admin, {
      householdId: HA,
      accountId: personal,
      actorId: userA,
      on: "2026-03-10",
      merchant: "SECRET SRL",
      cui: "RO11111111",
      lines: [{ name: "Cadou", totalMinor: 5000, vatRate: "21.00" }],
    });
    // Bon 3: nu e confirmat (needs_review), în afara oricărui export.
    await seedReceipt(fx.scratch.admin, {
      householdId: HA,
      accountId: shared,
      actorId: userA,
      on: "2026-03-11",
      merchant: "NECONFIRMAT SRL",
      status: "needs_review",
      lines: [{ name: "X", totalMinor: 100, vatRate: "19.00" }],
    });
    // Bon 4: altă perioadă.
    await seedReceipt(fx.scratch.admin, {
      householdId: HA,
      accountId: shared,
      actorId: userA,
      on: "2026-04-02",
      merchant: "APRILIE SRL",
      lines: [{ name: "Y", totalMinor: 100, vatRate: "19.00" }],
    });
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("Excel: o linie per bon, defalcarea pe cote, diferențele de control, totaluri", async () => {
    const r = await call(
      P.exportAccountingXlsxHandler,
      `/api/v1/exports/accounting.xlsx?${RANGE}`,
      { bearer: A.bearer },
    );
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.res.headers.get("content-disposition")).toBe(
      'attachment; filename="finet-contabilitate.xlsx"',
    );
    const sheet = unzipText(r.bytes, "xl/worksheets/sheet1.xml");
    for (const needle of [
      "LIDL DISCOUNT SRL",
      "RO22891860",
      "SECRET SRL", // proprietarul contului personal îl vede
      "<v>100.00</v>", // baza 19 %
      "<v>19.00</v>",
      "<v>27.52</v>", // baza 9 %
      "<v>2.48</v>",
      "<v>21.48</v>", // TVA calculat
      "<v>19.91</v>", // TVA pe bon
      "<v>1.57</v>", // diferența de TVA
      "<v>149.00</v>",
    ]) {
      expect(sheet, needle).toContain(needle);
    }
    expect(sheet).not.toContain("NECONFIRMAT");
    expect(sheet).not.toContain("APRILIE");
    expect(sheet).toContain("Bonuri: 2");
  });

  it("CSV: coduri stabile, BOM, sume zecimale; dialectul ro cu virgulă", async () => {
    const r = await call(P.exportAccountingCsvHandler, `/api/v1/exports/accounting.csv?${RANGE}`, {
      bearer: A.bearer,
    });
    expect(r.status).toBe(200);
    const lines = r.text.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines[0]).toMatch(/^occurred_on,receipt_number,merchant,tax_id,currency,base_0,vat_0,/);
    expect(lines).toHaveLength(3);
    const lidl = lines.find((l) => l.includes("LIDL"))!;
    expect(lidl).toContain("2026-03-05,0123,LIDL DISCOUNT SRL,RO22891860,RON");
    expect(lidl).toContain(",100.00,19.00,");
    const ro = await call(
      P.exportAccountingCsvHandler,
      `/api/v1/exports/accounting.csv?${RANGE}&dialect=ro`,
      { bearer: A.bearer },
    );
    expect(ro.text).toContain(";100,00;19,00;");
  });

  it("vizibilitate: membrul nu vede bonul din contul personal al altuia; altă gospodărie, nimic", async () => {
    const c = await call(
      P.exportAccountingXlsxHandler,
      `/api/v1/exports/accounting.xlsx?${RANGE}`,
      {
        bearer: C.bearer,
      },
    );
    const sheet = unzipText(c.bytes, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("LIDL DISCOUNT SRL");
    expect(sheet).not.toContain("SECRET SRL");
    expect(sheet).toContain("Bonuri: 1");
    const b = await call(
      P.exportAccountingXlsxHandler,
      `/api/v1/exports/accounting.xlsx?${RANGE}`,
      {
        bearer: B.bearer,
      },
    );
    const other = unzipText(b.bytes, "xl/worksheets/sheet1.xml");
    expect(other).not.toContain("LIDL");
    expect(other).toContain("Bonuri: 0");
  });

  it("lista bonurilor: Excel și PDF (diacritice și sume formatate)", async () => {
    const x = await call(P.exportReceiptsXlsxHandler, `/api/v1/exports/receipts.xlsx?${RANGE}`, {
      bearer: A.bearer,
    });
    expect(unzipText(x.bytes, "xl/workbook.xml")).toContain('name="Bonuri"');
    const p = await call(P.exportReceiptsPdfHandler, `/api/v1/exports/receipts.pdf?${RANGE}`, {
      bearer: A.bearer,
    });
    expect(p.status).toBe(200);
    expect(p.res.headers.get("content-disposition")).toBe(
      'attachment; filename="finet-bonuri.pdf"',
    );
    const doc = await getDocumentProxy(new Uint8Array(p.bytes));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text).toContain("LIDL DISCOUNT SRL");
    expect(text).toContain("149,00");
  });

  it("perioada: obligatorie, ordonată, cel mult 1.100 de zile; parametri necunoscuți → 400", async () => {
    const bad = [
      "/api/v1/exports/accounting.xlsx",
      "/api/v1/exports/accounting.xlsx?from=2026-03-01",
      "/api/v1/exports/accounting.xlsx?from=2026-03-31&to=2026-03-01",
      "/api/v1/exports/accounting.xlsx?from=2020-01-01&to=2026-03-01",
      "/api/v1/exports/accounting.xlsx?from=2026-02-30&to=2026-03-01",
      `/api/v1/exports/accounting.xlsx?${RANGE}&x=1`,
    ];
    for (const path of bad) {
      expect(
        (await call(P.exportAccountingXlsxHandler, path, { bearer: A.bearer })).status,
        path,
      ).toBe(400);
    }
  });

  it("dialect necunoscut → 400 (înainte de orice citire); cele valide trec", async () => {
    const bad = await call(
      P.exportAccountingCsvHandler,
      `/api/v1/exports/accounting.csv?${RANGE}&dialect=xx`,
      { bearer: A.bearer },
    );
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text).error.fields.dialect).toBeTruthy();
    for (const dialect of ["rfc4180", "ro"]) {
      const ok = await call(
        P.exportAccountingCsvHandler,
        `/api/v1/exports/accounting.csv?${RANGE}&dialect=${dialect}`,
        { bearer: A.bearer },
      );
      expect(ok.status, dialect).toBe(200);
    }
  });

  it("plafon: peste maxRows → 409 export_too_large (fără conținut)", async () => {
    const small: ApiDeps = { ...env, exportMaxRows: 1 };
    const r = await call(
      P.exportAccountingXlsxHandler,
      `/api/v1/exports/accounting.xlsx?${RANGE}`,
      { bearer: A.bearer },
      small,
    );
    expect(r.status).toBe(409);
    expect(JSON.parse(r.text).error.reason).toBe("export_too_large");
  });

  it("401 fără sesiune; cookie doar cu Sec-Fetch-Site corect", async () => {
    for (const [handler, path] of [
      [P.exportAccountingCsvHandler, "/api/v1/exports/accounting.csv"],
      [P.exportAccountingXlsxHandler, "/api/v1/exports/accounting.xlsx"],
      [P.exportReceiptsXlsxHandler, "/api/v1/exports/receipts.xlsx"],
      [P.exportReceiptsPdfHandler, "/api/v1/exports/receipts.pdf"],
    ] as const) {
      expect((await call(handler, `${path}?${RANGE}`, {})).status, path).toBe(401);
      const cross = await call(handler, `${path}?${RANGE}`, {
        cookie: A.cookie,
        headers: { "sec-fetch-site": "cross-site" },
      });
      expect(cross.status, path).toBe(403);
    }
  });

  it("audit: tip, număr de rânduri și format, fără conținut", async () => {
    await fx.scratch.admin`delete from finet.audit_events where action = 'export.downloaded'`;
    await call(P.exportAccountingXlsxHandler, `/api/v1/exports/accounting.xlsx?${RANGE}`, {
      bearer: A.bearer,
    });
    await call(P.exportAccountingCsvHandler, `/api/v1/exports/accounting.csv?${RANGE}`, {
      bearer: A.bearer,
    });
    const rows = await fx.scratch.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events where action = 'export.downloaded' order by created_at, id`;
    expect(rows.map((r) => r.metadata)).toEqual([
      { kind: "accounting", rows: 2, format: "xlsx" },
      { kind: "accounting", rows: 2 },
    ]);
  });
});
