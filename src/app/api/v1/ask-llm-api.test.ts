import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAiClient } from "@/lib/ai";
import { type MockAiServer, startMockAiServer } from "@/lib/ai/mock-server";
import { TEST_ADMIN_URL } from "@/db/testing";
import type { AskAi } from "@/modules/ask/ask-runtime";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { systemCategoryId } from "@/modules/ledger/testing";

import * as AH from "./_lib/ask-handlers";
import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import { type Sessions, apiRequest, assertContract, readJson, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Forma răspunsului e verificată prin contract (`assertContract`); în aserțiuni se citește liber.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

/**
 * „Întreabă FINET” cu LLM (F10-C, pasul LLM; ADR 0026) prin API: handler real, PostgreSQL real,
 * server AI fals. Verifică: modelul se apelează DOAR când parserul din cod nu înțelege și doar cu
 * consimțământul `external_ai`; ce pleacă (doar întrebarea, data și numele categoriilor); cheia
 * dedicată; bugetul; validarea strictă a ieșirii; rândul `ai_calls` fără conținut.
 */
describe.skipIf(!TEST_ADMIN_URL)("Întreabă FINET cu LLM pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  let mock: MockAiServer;
  let A: Sessions;
  let userA: string;
  let groceriesName: string;
  let answer: () => string;
  const clock = Date.parse("2026-10-28T10:00:00Z");
  const PASS = "parola-ask-llm-1";
  const KEY = "sk-cheie-dedicata-ask-0123456789";
  const FREE_QUESTION = "ce sumă mi-au luat alimentele luna trecută"; // parserul din cod nu o înțelege

  const ai = (over: Partial<AskAi> = {}): AskAi => ({
    client: createAiClient({
      baseUrl: mock.baseUrl,
      apiKey: KEY,
      allowedHosts: [mock.host],
      timeoutMs: 8_000,
      maxRetries: 0,
      retryBaseMs: 5,
    }),
    textModel: "finet-text-external",
    pricing: { inputPerMTokMinor: 50n, outputPerMTokMinor: 300n },
    monthlyBudget: { amountMinor: 100_000n, currency: "USD" },
    responseFormat: "json_object",
    ...over,
  });

  async function ask(question: string, deps: ApiDeps = { ...env, ask: { ai: ai() } }) {
    const res = await AH.askHandler(
      apiRequest("/api/v1/ask", { bearer: A.bearer, body: { question } as never }),
      deps,
    );
    await assertContract(AH.askHandler as never, res);
    const body = await readJson(res);
    return { status: res.status, data: (body as { data?: Loose }).data! };
  }
  const grantAskAi = () =>
    fx.scratch
      .admin`insert into finet.consents (user_id, kind) values (${userA}, 'external_ai_ask')`;
  const calls = () =>
    fx.scratch.admin<
      {
        task: string;
        provider: string;
        result: string;
        model_alias: string;
        units: number | null;
      }[]
    >`select task, provider, result, model_alias, units from finet.ai_calls order by created_at, id`;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_ask_llm");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        exports: { max: 100_000, windowSeconds: 60 },
        ask: { max: 100_000, windowSeconds: 60 },
      },
    };
    const a = await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    userA = a.userId;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    const account = (
      (
        await readJson(
          await L.createAccountHandler(
            apiRequest("/api/v1/accounts", {
              bearer: A.bearer,
              body: { name: "Card", type: "bank", currency: "RON" },
            }),
            env,
          ),
        )
      ).data as { id: string }
    ).id;
    const groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");
    groceriesName = (
      await fx.scratch.admin<
        { name: string }[]
      >`select name from finet.categories where id = ${groceries}`
    )[0]!.name;
    const tx = async (body: Record<string, unknown>) => {
      const r = await L.createTransactionHandler(
        apiRequest("/api/v1/transactions", {
          bearer: A.bearer,
          body: { accountId: account, type: "expense", ...body },
        }),
        env,
      );
      expect(r.status, await r.clone().text()).toBe(201);
    };
    await tx({
      amountMinor: 10000,
      occurredOn: "2026-09-12",
      categoryId: groceries,
      merchant: "Lidl",
    });
    await tx({ amountMinor: 2500, occurredOn: "2026-09-20", merchant: "Chioșc Secret" });
    mock = await startMockAiServer(() => ({
      kind: "content",
      content: answer(),
      usage: { prompt: 300, completion: 40 },
    }));
  });
  afterAll(async () => {
    await mock?.close();
    await fx?.close();
  });
  beforeEach(async () => {
    mock.reset();
    await fx.scratch.admin`delete from finet.ai_calls`;
    await fx.scratch.admin`delete from finet.consents where user_id = ${userA}`;
    answer = () =>
      JSON.stringify({
        understood: true,
        metric: "expense_total",
        period: { kind: "last_month" },
        category: groceriesName,
        merchant: null,
      });
  });

  it("întrebare liberă + consimțământ: tradusă de model, răspuns cu source=ai, cifre din baza de date", async () => {
    await grantAskAi();
    const r = await ask(FREE_QUESTION);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      understood: true,
      source: "ai",
      query: { metric: "expense_total", period: { from: "2026-09-01", to: "2026-09-30" } },
      answer: { kind: "total", rows: [{ currency: "RON", totalMinor: 10000, count: 1 }] },
    });
    expect(r.data.query.categoryId).toBeTruthy();
    expect(r.data.notes[0]).toContain("model AI extern");
    expect(r.data.queryText).toContain(groceriesName);
  });

  it("ce pleacă: doar întrebarea, data și numele categoriilor; cheia dedicată; fără comercianți/sume", async () => {
    await grantAskAi();
    await ask(FREE_QUESTION);
    expect(mock.requests).toHaveLength(1);
    const sent = mock.requests[0]!;
    expect(sent.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.path).toContain("/chat/completions");
    const messages = (sent.body as { messages: { role: string; content: string }[] }).messages;
    const payload = JSON.parse(messages[1]!.content) as {
      today: string;
      question: string;
      categories: string[];
    };
    expect(Object.keys(payload).sort()).toEqual(["categories", "question", "today"]);
    expect(payload.today).toBe("2026-10-28");
    expect(payload.question).toBe(FREE_QUESTION);
    expect(payload.categories).toContain(groceriesName);
    const wire = JSON.stringify(sent.body);
    for (const secret of ["Lidl", "Chioșc", "10000", "2500", "100,00", "ana@exemplu.ro", userA]) {
      expect(wire, secret).not.toContain(secret);
    }
  });

  it("rând ai_calls (sarcina ask_finet, extern, ok) fără conținut; întrebarea nu se păstrează", async () => {
    await grantAskAi();
    const marker = "UNICORN-LLM-4471";
    answer = () =>
      JSON.stringify({
        understood: false,
        metric: null,
        period: null,
        category: null,
        merchant: null,
      });
    await ask(`${marker} ce simbol are aurul`);
    const rows = await calls();
    expect(rows).toEqual([
      {
        task: "ask_finet",
        provider: "external",
        result: "ok",
        model_alias: "finet-text-external",
        units: 340,
      },
    ]);
    const tables = await fx.scratch.admin<{ t: string }[]>`
      select table_name as t from information_schema.tables where table_schema = 'finet'`;
    for (const { t } of tables) {
      const hit = await fx.scratch.admin.unsafe(
        `select count(*)::int as n from finet."${t}" x where x::text like '%${marker}%'`,
      );
      expect(hit[0]!.n, t).toBe(0);
    }
  });

  it("parserul din cod înțelege → modelul NU se apelează (nici cu consimțământ)", async () => {
    await grantAskAi();
    const r = await ask("Cât am cheltuit luna trecută?");
    expect(r.data).toMatchObject({ understood: true, source: "rules" });
    expect(mock.requests).toHaveLength(0);
    expect(await calls()).toHaveLength(0);
  });

  it("fără consimțământ: nu pleacă nimic, răspunsul indică activarea", async () => {
    const r = await ask(FREE_QUESTION);
    expect(r.data).toMatchObject({ understood: false, reason: "metric", aiHint: "consent" });
    expect(r.data.message).toContain("Profil");
    expect(mock.requests).toHaveLength(0);
    expect(await calls()).toHaveLength(0);
  });

  it("buget epuizat: nimic nu pleacă, mesaj despre buget", async () => {
    await grantAskAi();
    const r = await ask(FREE_QUESTION, {
      ...env,
      ask: { ai: ai({ monthlyBudget: { amountMinor: 0n, currency: "USD" } }) },
    });
    expect(r.data).toMatchObject({ understood: false, aiHint: "budget" });
    expect(mock.requests).toHaveLength(0);
  });

  it("pasul AI oprit (ai: null): comportament ca înainte, fără indiciu", async () => {
    await grantAskAi();
    const r = await ask(FREE_QUESTION, { ...env, ask: { ai: null } });
    expect(r.data).toMatchObject({ understood: false, reason: "metric", aiHint: null });
    expect(mock.requests).toHaveLength(0);
  });

  it("ieșire invalidă, perioadă inventată sau câmp în plus: refuzat, rând failed_validation", async () => {
    await grantAskAi();
    for (const bad of [
      "nu e json",
      JSON.stringify({
        understood: true,
        metric: "drop_table",
        period: null,
        category: null,
        merchant: null,
      }),
      JSON.stringify({
        understood: true,
        metric: "expense_total",
        period: { kind: "from_to" },
        category: null,
        merchant: null,
      }),
      JSON.stringify({
        understood: true,
        metric: "expense_total",
        period: null,
        category: null,
        merchant: null,
        sql: "x",
      }),
    ]) {
      answer = () => bad;
      const r = await ask(FREE_QUESTION);
      expect(r.data, bad).toMatchObject({ understood: false, aiHint: "error" });
    }
    expect((await calls()).every((c) => c.result === "failed_validation")).toBe(true);
  });

  it("nume necunoscut în răspunsul modelului: refuz explicit (reason=name), nu un răspuns nefiltrat", async () => {
    await grantAskAi();
    answer = () =>
      JSON.stringify({
        understood: true,
        metric: "expense_total",
        period: { kind: "last_month" },
        category: "Categorie Inventată",
        merchant: null,
      });
    const r = await ask(FREE_QUESTION);
    expect(r.data).toMatchObject({ understood: false, reason: "name" });
  });

  it("comerciantul din răspuns se acceptă doar dacă e al gospodăriei (egalitate după normalizare)", async () => {
    await grantAskAi();
    answer = () =>
      JSON.stringify({
        understood: true,
        metric: "expense_total",
        period: { kind: "last_month" },
        category: null,
        merchant: "LIDL",
      });
    const ok = await ask(FREE_QUESTION);
    expect(ok.data).toMatchObject({
      understood: true,
      source: "ai",
      query: { merchant: "Lidl" },
      answer: { rows: [{ totalMinor: 10000 }] },
    });
    answer = () =>
      JSON.stringify({
        understood: true,
        metric: "expense_total",
        period: { kind: "last_month" },
        category: null,
        merchant: "Magazin Inexistent",
      });
    expect((await ask(FREE_QUESTION)).data).toMatchObject({ understood: false, reason: "name" });
  });

  it("eroare HTTP a furnizorului: răspuns curat (aiHint=error), fără scurgeri, rând de eroare", async () => {
    await grantAskAi();
    mock.enqueue({ kind: "status", status: 500 });
    const r = await ask(FREE_QUESTION);
    expect(r.data).toMatchObject({ understood: false, aiHint: "error" });
    expect(JSON.stringify(r.data)).not.toContain(KEY);
    const rows = await calls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: "ask_finet", result: "error" });
  });
});
