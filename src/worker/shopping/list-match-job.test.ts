import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { createAiClient } from "@/lib/ai";
import { type MockAiServer, type MockRequest, startMockAiServer } from "@/lib/ai/mock-server";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { runComparison, setItemMatch } from "@/modules/shopping/compare.service";
import { createList, getList } from "@/modules/shopping/shopping.service";
import { grantExternalAi, seedReceipt } from "@/modules/shopping/testing";

import type { AiRuntime } from "../receipts/receipt-job";

import {
  type ListMatchDeps,
  handleListMatchProcess,
  handleListMatchSweep,
  listQueuedListMatches,
  processListMatch,
} from "./list-match-jobs";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const API_KEY = "sk-cheie-fictiva-de-test-0123456789";

/**
 * Pasul opțional cu LLM al comparației listă ↔ bon în worker (Postgres real, server AI fals):
 * dezactivat/neconfigurat/fără consimțământ → niciun apel; cu AI: doar perechile ambigue, doar
 * nume normalizate, ieșire constrânsă la candidați, buget rezervat, `ai_calls` fără conținut,
 * deciziile utilizatorului neatinse.
 */
describe.skipIf(!TEST_ADMIN_URL)("list-match în worker (Postgres real, server AI fals)", () => {
  let f: FamilyFixture;
  let mock: MockAiServer;
  let logs: Record<string, unknown>[];
  /** Răspunsul „modelului”: primește cererea parsată și întoarce conținutul. */
  let answer: (req: { items: { i: number }[]; pairs: { i: number; c: string[] }[] }) => string;

  const ai = (over: Partial<AiRuntime> = {}): AiRuntime => ({
    client: createAiClient({
      baseUrl: mock.baseUrl,
      apiKey: API_KEY,
      allowedHosts: [mock.host],
      timeoutMs: 8_000,
      maxRetries: 0,
      retryBaseMs: 5,
    }),
    visionModel: "finet-vision-external",
    textModel: "finet-text-external",
    pricing: { inputPerMTokMinor: 50n, outputPerMTokMinor: 300n },
    monthlyBudget: { amountMinor: 100_000n, currency: "USD" },
    confidenceThreshold: 80,
    ...over,
  });
  const deps = (over: Partial<ListMatchDeps> = {}): ListMatchDeps => ({
    db: f.db,
    enabled: true,
    ai: ai(),
    log: (e) => void logs.push({ ...e }),
    ...over,
  });
  const userMessage = (r: MockRequest) =>
    JSON.parse((r.body?.messages as { content: string }[])[1]!.content) as {
      items: { i: number; name: string }[];
      lines: { c: string; name: string }[];
      pairs: { i: number; c: string[] }[];
    };

  /** O listă cu „lapte” și un bon cu două linii ambigue; cererea AI e pusă în coadă. */
  async function scenario(opts: { consent?: boolean; personalBy?: "A" | "C" } = {}) {
    if (opts.consent !== false) await grantExternalAi(f.admin, f.A.userId).catch(() => {});
    const rc = await seedReceipt(f.admin, f.HA, f.A.userId, [
      ["CIOCOLATA CU LAPTE 100G"],
      ["BUDINCA CU LAPTE 200G"],
      ["PAINE FELIATA 500G"],
    ]);
    const list = await createList(f.deps, f.A, f.HA, {
      name: "AI",
      personal: opts.personalBy === "A",
      items: [{ name: "lapte" }, { name: "pâine" }],
    });
    const run = await runComparison(f.deps, f.A, f.HA, list.list.id, { receiptId: rc.id });
    return { rc, list, run };
  }
  const requestRow = async (listId: string) => {
    const [r] = await f.admin<
      { id: string; status: string; error_code: string | null; attempts: number }[]
    >`select id, status, error_code, attempts from finet.shopping_list_ai_requests where list_id = ${listId}`;
    return r!;
  };

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_listmatch");
    mock = await startMockAiServer((req) => ({
      kind: "content",
      content: answer(userMessage(req)),
      usage: { prompt: 200, completion: 20 },
    }));
  });
  afterAll(async () => {
    await mock?.close();
    await f?.close();
  });
  beforeEach(async () => {
    await f.admin`delete from finet.shopping_lists`;
    await f.admin`delete from finet.receipts`;
    await f.admin`delete from finet.consents`;
    await f.admin`delete from finet.ai_calls`;
    await f.admin`delete from finet.ai_budget_usage`;
    mock.reset();
    logs = [];
    // Implicit: modelul alege primul candidat al fiecărui articol.
    answer = (req) =>
      JSON.stringify({ answers: req.pairs.map((p) => ({ i: p.i, c: p.c[0] ?? null })) });
  });

  it("dezactivat (AI_LIST_MATCH=0) sau AI neconfigurat: cererea devine `skipped`, 0 cereri HTTP", async () => {
    const s1 = await scenario();
    expect(s1.run.view.ai.status).toBe("queued");
    const [q] = await listQueuedListMatches(f.db, 10);
    expect(q).toMatchObject({ householdId: f.HA, actorUserId: f.A.userId });
    expect(await processListMatch(deps({ enabled: false }), q!)).toEqual({ outcome: "skipped" });
    expect((await requestRow(s1.list.list.id)).status).toBe("skipped");
    // Din nou (coada e goală) și cu AI neconfigurat.
    expect(await listQueuedListMatches(f.db, 10)).toEqual([]);
    await runComparison(f.deps, f.A, f.HA, s1.list.list.id, { receiptId: s1.rc.id });
    const [q2] = await listQueuedListMatches(f.db, 10);
    expect(await processListMatch(deps({ ai: null }), q2!)).toEqual({ outcome: "skipped" });
    expect(mock.requests).toHaveLength(0);
    expect(await f.admin`select id from finet.ai_calls`).toHaveLength(0);
  });

  it("consimțământul retras după punerea în coadă: nimic nu pleacă", async () => {
    const s = await scenario();
    await f.admin`update finet.consents set revoked_at = now() where user_id = ${f.A.userId}`;
    const [q] = await listQueuedListMatches(f.db, 10);
    expect(await processListMatch(deps(), q!)).toEqual({ outcome: "no_consent" });
    const r = await requestRow(s.list.list.id);
    expect(r).toMatchObject({ status: "skipped", error_code: "consent_missing" });
    expect(mock.requests).toHaveLength(0);
  });

  it("cu AI: cererea poartă DOAR nume normalizate, modelul alege un candidat, propunerea devine `ai`, ai_calls fără conținut", async () => {
    const s = await scenario();
    expect(s.run.view.matched[0]).toMatchObject({ source: "code", uncertain: true });
    const [q] = await listQueuedListMatches(f.db, 10);
    expect(await processListMatch(deps(), q!)).toEqual({ outcome: "done" });
    // Cererea: un singur apel, doar articolul ambiguu („pâine” e sigură, nu pleacă).
    expect(mock.requests).toHaveLength(1);
    const sent = userMessage(mock.requests[0]!);
    expect(sent.items.map((i) => i.name)).toEqual(["lapte"]);
    expect(sent.lines.map((l) => l.name).sort()).toEqual([
      "budinca cu lapte 200g",
      "ciocolata cu lapte 100g",
    ]);
    const raw = JSON.stringify(mock.requests[0]!.body);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/); // fără id-uri
    expect(raw).not.toContain("MAGAZIN SINTETIC");
    expect(mock.requests[0]!.authorization).toBe(`Bearer ${API_KEY}`);
    // Rezultatul: propunerea articolului „lapte” e acum a AI-ului.
    const view = (await getList(f.deps, f.A, f.HA, s.list.list.id)).items.find(
      (i) => i.name === "lapte",
    )!;
    expect(view.match).toMatchObject({ status: "suggested", source: "ai" });
    expect(view.match.score).toBeGreaterThanOrEqual(50);
    expect((await requestRow(s.list.list.id)).status).toBe("done");
    // ai_calls: task list_match, doar metadate.
    const calls = await f.admin<Record<string, unknown>[]>`select * from finet.ai_calls`;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      task: "list_match",
      result: "ok",
      model_alias: "finet-text-external",
    });
    expect(JSON.stringify(calls)).not.toContain("lapte");
    // Bugetul s-a consumat.
    const [budget] = await f.admin<
      { reserved_minor: string }[]
    >`select reserved_minor::text from finet.ai_budget_usage`;
    expect(BigInt(budget!.reserved_minor)).toBeGreaterThan(0n);
    // Jurnalul worker-ului: doar coduri/contoare.
    expect(JSON.stringify(logs)).not.toContain("lapte");
    // Reluarea comparației păstrează alegerea AI și nu mai pune nimic în coadă (cererea e `done`).
    const again = await runComparison(f.deps, f.A, f.HA, s.list.list.id, { receiptId: s.rc.id });
    expect(again.view.matched.find((m) => m.item.name === "lapte")).toMatchObject({
      source: "ai",
      uncertain: true,
    });
    expect(again.view.ai.status).toBe("done");
    expect(await listQueuedListMatches(f.db, 10)).toEqual([]);
  });

  it("modelul răspunde „niciuna”: dispare doar propunerea ambiguă a codului", async () => {
    answer = (req) => JSON.stringify({ answers: req.pairs.map((p) => ({ i: p.i, c: null })) });
    const s = await scenario();
    const [q] = await listQueuedListMatches(f.db, 10);
    expect(await processListMatch(deps(), q!)).toEqual({ outcome: "done" });
    const items = (await getList(f.deps, f.A, f.HA, s.list.list.id)).items;
    expect(items.find((i) => i.name === "lapte")!.match.status).toBe("none");
    expect(items.find((i) => i.name === "pâine")!.match.status).toBe("suggested"); // sigură, neatinsă
  });

  it("răspuns invalid / cod inventat / buget epuizat: `failed` cu cod fix, propunerea codului rămâne", async () => {
    for (const [content, code] of [
      ["nu e json", "failed_validation"],
      [JSON.stringify({ answers: [{ i: 0, c: "c1", extra: true }] }), "failed_validation"],
    ] as const) {
      await f.admin`delete from finet.shopping_lists`;
      answer = () => content;
      const s = await scenario();
      const [q] = await listQueuedListMatches(f.db, 10);
      expect(await processListMatch(deps(), q!)).toEqual({ outcome: "failed", code });
      expect(await requestRow(s.list.list.id)).toMatchObject({
        status: "failed",
        error_code: code,
      });
      const lapte = (await getList(f.deps, f.A, f.HA, s.list.list.id)).items.find(
        (i) => i.name === "lapte",
      )!;
      expect(lapte.match).toMatchObject({ status: "suggested", source: "code" });
    }
    const failedCalls = await f.admin<{ result: string }[]>`select result from finet.ai_calls`;
    expect(failedCalls.every((c) => c.result === "failed_validation")).toBe(true);
    // Cod inexistent: răspuns valid ca formă, ignorat; cererea e `done`, propunerea codului rămâne.
    await f.admin`delete from finet.shopping_lists`;
    answer = (req) => JSON.stringify({ answers: req.pairs.map((p) => ({ i: p.i, c: "c9" })) });
    const s = await scenario();
    const [q] = await listQueuedListMatches(f.db, 10);
    expect(await processListMatch(deps(), q!)).toEqual({ outcome: "done" });
    expect(
      (await getList(f.deps, f.A, f.HA, s.list.list.id)).items.find((i) => i.name === "lapte")!
        .match.source,
    ).toBe("code");
    // Buget 0: nimic nu pleacă.
    await f.admin`delete from finet.shopping_lists`;
    mock.reset();
    const s2 = await scenario();
    const [q2] = await listQueuedListMatches(f.db, 10);
    const out = await processListMatch(
      deps({ ai: ai({ monthlyBudget: { amountMinor: 0n, currency: "USD" } }) }),
      q2!,
    );
    expect(out).toEqual({ outcome: "failed", code: "budget_exceeded" });
    expect(mock.requests).toHaveLength(0);
    expect((await requestRow(s2.list.list.id)).error_code).toBe("budget_exceeded");
  });

  it("deciziile utilizatorului nu se ating: articolul confirmat între timp rămâne confirmat", async () => {
    const s = await scenario();
    const lapte = s.list.items[0]!.id;
    await setItemMatch(f.deps, f.A, f.HA, s.list.list.id, lapte, { action: "confirm" });
    const [q] = await listQueuedListMatches(f.db, 10);
    // Confirmat → nu mai e ambiguu: nimic de cerut modelului.
    expect(await processListMatch(deps(), q!)).toEqual({ outcome: "nothing_to_ask" });
    expect(mock.requests).toHaveLength(0);
    const item = (await getList(f.deps, f.A, f.HA, s.list.list.id)).items.find(
      (i) => i.id === lapte,
    )!;
    expect(item.match).toMatchObject({ status: "confirmed", source: "code" });
  });

  it("lista personală: se lucrează în numele proprietarului; datele jobului sunt validate strict", async () => {
    const s = await scenario({ personalBy: "A" });
    const refs = await listQueuedListMatches(f.db, 10);
    expect(refs).toHaveLength(1);
    expect(await processListMatch(deps(), refs[0]!)).toEqual({ outcome: "done" });
    // C nu vede lista lui A, deci un job în numele lui nu găsește nimic de făcut.
    const lapte = (await getList(f.deps, f.A, f.HA, s.list.list.id)).items.find(
      (i) => i.name === "lapte",
    )!;
    expect(lapte.match.source).toBe("ai");
    // Validarea datelor jobului.
    const d = deps();
    expect(await handleListMatchProcess(d, { requestId: "x", householdId: f.HA })).toEqual({
      rejected: "invalid_data",
    });
    expect(
      await handleListMatchProcess(d, {
        requestId: refs[0]!.requestId,
        householdId: f.HA,
        extra: 1,
      }),
    ).toEqual({ rejected: "invalid_data" });
    expect(
      await handleListMatchProcess(d, {
        requestId: "00000000-0000-4000-8000-000000000001",
        householdId: f.HA,
      }),
    ).toEqual({ rejected: "not_found" });
    // Cererea e terminată: jobul repetat nu mai găsește nimic (nu plătește a doua oară).
    expect(
      await handleListMatchProcess(d, { requestId: refs[0]!.requestId, householdId: f.HA }),
    ).toEqual({ rejected: "not_found" });
    expect(mock.requests).toHaveLength(1);
  });

  it("sweep: trimite câte un job pe cerere, doar identificatori", async () => {
    await scenario();
    const sent: [string, string][] = [];
    const n = await handleListMatchSweep(deps(), async (r, h) => void sent.push([r, h]));
    expect(n).toBe(1);
    expect(sent[0]![1]).toBe(f.HA);
    expect(JSON.stringify(logs)).not.toContain("lapte");
  });
});
