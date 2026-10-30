import { inflateRawSync } from "node:zlib";

import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { systemCategoryId } from "@/modules/ledger/testing";

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
 * Exporturile Excel și PDF (F10-C; ADR 0024) prin API: handlere reale, PostgreSQL real, aplicația
 * ca `finet_app`. Verifică antetele (contractul OpenAPI), conținutul (sume cu semn, diacritice),
 * izolarea între gospodării, plafonul PDF, auditul fără conținut și protecția `Sec-Fetch-Site`.
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
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26);
      return inflateRawSync(buf.subarray(start, start + csize)).toString("utf8");
    }
    p += 46 + nlen;
  }
  throw new Error(`lipsește ${wanted}`);
}

describe.skipIf(!TEST_ADMIN_URL)("exporturi Excel/PDF pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions;
  let B: Sessions;
  let HA: string;
  const PASS = "parola-export-tabele-1";

  async function call(handler: Handler, path: string, init: ApiInit, deps: ApiDeps = env) {
    const res = await handler(apiRequest(path, init), deps);
    await assertContract(handler as never, res);
    return { status: res.status, res, bytes: Buffer.from(await res.clone().arrayBuffer()) };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_exports_tables");
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
    HA = (await mk("ana@exemplu.ro", "Ana")).householdId!;
    await mk("bogdan@exemplu.ro", "Bogdan");
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);

    const account = await readJson(
      await L.createAccountHandler(
        apiRequest("/api/v1/accounts", {
          bearer: A.bearer,
          body: { name: "Card ȘtefanȚ", type: "bank", currency: "RON" },
        }),
        env,
      ),
    );
    const accountId = (account.data as { id: string }).id;
    const groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");
    const tx = async (body: Record<string, unknown>) => {
      const r = await L.createTransactionHandler(
        apiRequest("/api/v1/transactions", { bearer: A.bearer, body: { accountId, ...body } }),
        env,
      );
      expect(r.status, await r.clone().text()).toBe(201);
    };
    await tx({
      type: "expense",
      amountMinor: 1234,
      occurredOn: "2026-03-05",
      categoryId: groceries,
      merchant: "Piața Ștefan — țuică",
    });
    await tx({
      type: "income",
      amountMinor: 500000,
      occurredOn: "2026-03-06",
      description: "=SUM(A1:A9)",
    });
    const goal = await P.createGoalHandler(
      apiRequest("/api/v1/goals", {
        bearer: A.bearer,
        body: { name: "Vacanță în Țară", targetMinor: 200000, currency: "RON" },
      }),
      env,
    );
    expect(goal.status).toBe(201);
    const budget = await P.createBudgetHandler(
      apiRequest("/api/v1/budgets", {
        bearer: A.bearer,
        body: { amountMinor: 100000, currency: "RON", categoryId: groceries },
      }),
      env,
    );
    expect(budget.status, await budget.clone().text()).toBe(201);
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("tranzacții .xlsx: antete, sume cu semn exacte, text liber rămâne text", async () => {
    const r = await call(
      P.exportTransactionsXlsxHandler,
      "/api/v1/exports/transactions.xlsx?dateFrom=2026-03-01&dateTo=2026-03-31",
      { bearer: A.bearer },
    );
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-disposition")).toBe(
      'attachment; filename="finet-tranzactii.xlsx"',
    );
    const sheet = unzipText(r.bytes, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<v>-12.34</v>");
    expect(sheet).toContain("<v>5000.00</v>");
    expect(sheet).toContain("Cheltuială");
    expect(sheet).toContain("Venit");
    expect(sheet).toContain("Piața Ștefan — țuică");
    expect(sheet).toContain("=SUM(A1:A9)");
    expect(sheet).not.toContain("<f>");
    expect(unzipText(r.bytes, "xl/workbook.xml")).toContain('name="Tranzacții"');
  });

  it("tranzacții .pdf: textul extras conține diacriticele și sumele formatate", async () => {
    const r = await call(
      P.exportTransactionsPdfHandler,
      "/api/v1/exports/transactions.pdf?dateFrom=2026-03-01&dateTo=2026-03-31",
      { bearer: A.bearer },
    );
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toBe("application/pdf");
    expect(r.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const doc = await getDocumentProxy(new Uint8Array(r.bytes));
    const { text } = await extractText(doc, { mergePages: true });
    expect(text).toContain("Tranzacții");
    expect(text).toContain("Piața Ștefan — țuică");
    expect(text).toContain("-12,34");
    expect(text).toContain("5.000,00");
  });

  it("obiective și bugete, în ambele formate", async () => {
    const goals = await call(P.exportGoalsXlsxHandler, "/api/v1/exports/goals.xlsx", {
      bearer: A.bearer,
    });
    expect(unzipText(goals.bytes, "xl/worksheets/sheet1.xml")).toContain("Vacanță în Țară");
    const budgets = await call(
      P.exportBudgetsXlsxHandler,
      "/api/v1/exports/budgets.xlsx?month=2026-10",
      { bearer: A.bearer },
    );
    expect(unzipText(budgets.bytes, "xl/worksheets/sheet1.xml")).toContain("În limită");
    for (const [handler, path] of [
      [P.exportGoalsPdfHandler, "/api/v1/exports/goals.pdf"],
      [P.exportBudgetsPdfHandler, "/api/v1/exports/budgets.pdf?month=2026-10"],
    ] as const) {
      const r = await call(handler, path, { bearer: A.bearer });
      expect(r.status, path).toBe(200);
      expect(r.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    }
  });

  it("izolare: altă gospodărie primește doar datele ei (zero rânduri), niciodată ale lui A", async () => {
    const r = await call(P.exportTransactionsXlsxHandler, "/api/v1/exports/transactions.xlsx", {
      bearer: B.bearer,
    });
    expect(r.status).toBe(200);
    const sheet = unzipText(r.bytes, "xl/worksheets/sheet1.xml");
    expect(sheet).not.toContain("Piața");
    expect(sheet).not.toContain("-12.34");
    const goals = await call(P.exportGoalsXlsxHandler, "/api/v1/exports/goals.xlsx", {
      bearer: B.bearer,
    });
    expect(unzipText(goals.bytes, "xl/worksheets/sheet1.xml")).not.toContain("Vacanță");
  });

  it("fără sesiune: 401; cookie: doar Sec-Fetch-Site same-origin/none, altfel 403", async () => {
    for (const [handler, path] of [
      [P.exportTransactionsXlsxHandler, "/api/v1/exports/transactions.xlsx"],
      [P.exportTransactionsPdfHandler, "/api/v1/exports/transactions.pdf"],
      [P.exportGoalsXlsxHandler, "/api/v1/exports/goals.xlsx"],
      [P.exportGoalsPdfHandler, "/api/v1/exports/goals.pdf"],
      [P.exportBudgetsXlsxHandler, "/api/v1/exports/budgets.xlsx"],
      [P.exportBudgetsPdfHandler, "/api/v1/exports/budgets.pdf"],
    ] as const) {
      expect((await call(handler, path, {})).status, path).toBe(401);
      for (const site of ["cross-site", "same-site"]) {
        const r = await call(handler, path, {
          cookie: A.cookie,
          headers: { "sec-fetch-site": site },
        });
        expect(r.status, `${path} ${site}`).toBe(403);
      }
      const ok = await call(handler, path, {
        cookie: A.cookie,
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(ok.status, path).toBe(200);
    }
  });

  it("PDF: plafon de rânduri propriu (409 export_too_large), Excel peste plafonul CSV nu", async () => {
    const small: ApiDeps = { ...env, exportMaxRows: 1 };
    const pdf = await call(
      P.exportTransactionsPdfHandler,
      "/api/v1/exports/transactions.pdf",
      { bearer: A.bearer },
      small,
    );
    expect(pdf.status).toBe(409);
    expect(JSON.parse(pdf.bytes.toString()).error.reason).toBe("export_too_large");
    const xlsx = await call(
      P.exportTransactionsXlsxHandler,
      "/api/v1/exports/transactions.xlsx",
      { bearer: A.bearer },
      small,
    );
    expect(xlsx.status).toBe(409);
  });

  it("filtre nevalide: 400; parametri necunoscuți: 400", async () => {
    const r = await call(
      P.exportTransactionsXlsxHandler,
      "/api/v1/exports/transactions.xlsx?dateFrom=nu-e-data",
      { bearer: A.bearer },
    );
    expect(r.status).toBe(400);
    const extra = await call(P.exportGoalsPdfHandler, "/api/v1/exports/goals.pdf?x=1", {
      bearer: A.bearer,
    });
    expect(extra.status).toBe(400);
  });

  it("audit: tip + rânduri + format, fără conținut", async () => {
    await fx.scratch.admin`delete from finet.audit_events where action = 'export.downloaded'`;
    await call(P.exportGoalsPdfHandler, "/api/v1/exports/goals.pdf", { bearer: A.bearer });
    await call(P.exportTransactionsXlsxHandler, "/api/v1/exports/transactions.xlsx", {
      bearer: A.bearer,
    });
    const rows = await fx.scratch.admin<
      { metadata: Record<string, unknown>; household_id: string }[]
    >`
      select metadata, household_id from finet.audit_events
       where action = 'export.downloaded' order by created_at, id`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.metadata.kind}:${r.metadata.format}`).sort()).toEqual([
      "goals:pdf",
      "transactions:xlsx",
    ]);
    for (const r of rows) {
      expect(Object.keys(r.metadata).sort()).toEqual(["format", "kind", "rows"]);
      expect(r.household_id).toBe(HA);
    }
  });

  it("rate limit propriu (429) după plafon", async () => {
    const strict: ApiDeps = {
      ...env,
      limits: { ...env.limits, exports: { max: 2, windowSeconds: 60 } },
      now: () => clock + 7_777_777,
    };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push(
        (
          await call(
            P.exportGoalsXlsxHandler,
            "/api/v1/exports/goals.xlsx",
            { bearer: A.bearer },
            strict,
          )
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});
