import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type AiClientOptions, createAiClient, parseModelJson, validateBaseUrl } from "./client";
import { costOfTokens, maxCostOf } from "./cost";
import { AiError, aiCallResultOf } from "./errors";
import { checkJsonShape, stripCodeFence } from "./json-guard";
import { type MockAiServer, startMockAiServer } from "./mock-server";

const KEY = "sk-test-cheie-fictiva-0123456789";
const req = {
  model: "finet-text-external",
  messages: [{ role: "user" as const, content: "x" }],
  maxTokens: 100,
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AiError ? `${e.code}:${e.detail}` : `other:${String(e)}`;
  }
}

describe("validateBaseUrl (anti-SSRF)", () => {
  const hosts = ["172.88.88.4:4000", "litellm-apps:4000"];
  it("acceptă doar gazda:port exactă din listă", () => {
    expect(validateBaseUrl("http://172.88.88.4:4000/v1", hosts).href).toBe(
      "http://172.88.88.4:4000/v1/",
    );
    for (const bad of [
      "http://172.88.88.4:4001/v1",
      "http://172.88.88.5:4000/v1",
      "http://169.254.169.254/latest",
      "file:///etc/passwd",
      "http://user:pw@172.88.88.4:4000/v1",
      "http://172.88.88.4:4000/v1?x=1",
      "http://172.88.88.4:4000/v1#f",
      "gopher://172.88.88.4:4000/",
      "nu-e-url",
    ]) {
      expect(() => validateBaseUrl(bad, hosts), bad).toThrow(AiError);
    }
  });
});

describe("json-guard", () => {
  const limits = { maxChars: 1000, maxDepth: 4, maxValues: 50 };
  it("elimină un singur gard de cod și refuză adâncimea/numărul de valori înainte de parsare", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence("```json\n```json\n{}\n```\n```")).toBe("```json\n{}\n```");
    expect(() => checkJsonShape("[[[[[1]]]]]", limits)).toThrow(AiError);
    expect(() => checkJsonShape("[[[[1]]]]", limits)).not.toThrow();
    expect(() => checkJsonShape(`[${"1,".repeat(60)}1]`, limits)).toThrow(AiError);
    expect(() => checkJsonShape("x".repeat(1001), limits)).toThrow(AiError);
    // Parantezele din șiruri nu contează.
    expect(() => checkJsonShape('{"a":"[[[[[[[[[["}', limits)).not.toThrow();
    expect(() => parseModelJson("{nu e json", limits)).toThrow(AiError);
    expect(parseModelJson('{"a":"\\"]]]]"}', limits)).toEqual({ a: '"]]]]' });
  });
});

describe("costul (bigint, rotunjit în sus, minim 1)", () => {
  const pricing = { inputPerMTokMinor: 50n, outputPerMTokMinor: 300n };
  it("un apel mic costă cel puțin 1 unitate minoră; fără tarife = 0", () => {
    expect(costOfTokens(pricing, 1000, 200)).toBe(1n);
    expect(costOfTokens(pricing, 2_000_000, 1_000_000)).toBe(400n);
    expect(costOfTokens(pricing, 1_000_001, 0)).toBe(51n);
    expect(costOfTokens({ inputPerMTokMinor: 0n, outputPerMTokMinor: 0n }, 10, 10)).toBe(0n);
    expect(maxCostOf(pricing, 0, 1, 8000)).toBeGreaterThanOrEqual(
      costOfTokens(pricing, 2200, 8000),
    );
  });
  it("rezultatul din ai_calls pentru fiecare cod", () => {
    expect(aiCallResultOf("timeout")).toBe("timeout");
    expect(aiCallResultOf("failed_validation")).toBe("failed_validation");
    expect(aiCallResultOf("provider_error")).toBe("error");
  });
});

describe("clientul AI pe serverul fals", () => {
  let mock: MockAiServer;
  const client = (extra: Partial<AiClientOptions> = {}) =>
    createAiClient({
      baseUrl: mock.baseUrl,
      apiKey: KEY,
      allowedHosts: [mock.host],
      timeoutMs: 300,
      maxRetries: 2,
      retryBaseMs: 5,
      ...extra,
    });

  beforeAll(async () => {
    mock = await startMockAiServer();
  });
  afterAll(async () => {
    await mock.close();
  });
  beforeEach(() => mock.reset());

  it("trimite cheia doar în Authorization, fără tools; întoarce conținutul ca text și tokenii", async () => {
    mock.enqueue({ kind: "content", content: '{"ok":true}', usage: { prompt: 10, completion: 5 } });
    const r = await client().chat(req);
    expect(r).toMatchObject({
      content: '{"ok":true}',
      usage: { promptTokens: 10, completionTokens: 5 },
      attempts: 1,
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(mock.requests[0]!.path).toBe("/v1/chat/completions");
    expect(mock.requests[0]!.body).not.toHaveProperty("tools");
    expect(mock.requests[0]!.body).not.toHaveProperty("functions");
  });

  it("reîncearcă la 500/429/timeout, cu cârligul înaintea fiecărei încercări", async () => {
    mock.enqueue(
      { kind: "status", status: 500 },
      { kind: "hang" },
      { kind: "content", content: "{}" },
    );
    const seen: number[] = [];
    const r = await client().chat(req, {
      beforeAttempt: async ({ attempt }) => void seen.push(attempt),
    });
    expect(r.attempts).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("nu reîncearcă la 400 sau la răspuns trunchiat; timeout după toate încercările", async () => {
    mock.enqueue({ kind: "status", status: 400 });
    expect(await code(client().chat(req))).toBe("provider_error:http_400");
    expect(mock.requests).toHaveLength(1);
    mock.reset();
    mock.enqueue({ kind: "content", content: "{", finishReason: "length" });
    expect(await code(client().chat(req))).toBe("failed_validation:truncated");
    expect(mock.requests).toHaveLength(1);
    mock.reset();
    mock.setHandler(() => ({ kind: "hang" }));
    expect(await code(client({ maxRetries: 1 }).chat(req))).toMatch(/^timeout/);
    expect(mock.requests).toHaveLength(2);
    mock.setHandler(() => ({ kind: "status", status: 500 }));
  });

  it("buget: o eroare din cârlig oprește apelul înainte de a trimite ceva", async () => {
    const r = client().chat(req, {
      beforeAttempt: async () => {
        throw new AiError("budget_exceeded");
      },
    });
    expect(await code(r)).toBe("budget_exceeded:budget_exceeded");
    expect(mock.requests).toHaveLength(0);
  });

  it("corp prea mare: refuzat după Content-Length sau oprit în flux; conținut prea lung refuzat", async () => {
    mock.enqueue({ kind: "huge", bytes: 2 * 1024 * 1024, declareLength: true });
    expect(await code(client({ maxRetries: 0 }).chat(req))).toBe(
      "response_too_large:content_length",
    );
    mock.enqueue({ kind: "huge", bytes: 4 * 1024 * 1024 });
    expect(await code(client({ maxRetries: 0, timeoutMs: 5000 }).chat(req))).toBe(
      "response_too_large:body_bytes",
    );
    mock.enqueue({ kind: "content", content: "x".repeat(2000) });
    expect(await code(client({ maxRetries: 0, maxContentChars: 1000 }).chat(req))).toBe(
      "response_too_large:content_chars",
    );
  });

  it("refuză redirecționările și plicurile invalide", async () => {
    mock.enqueue({ kind: "redirect", location: "http://169.254.169.254/" });
    expect(await code(client({ maxRetries: 0 }).chat(req))).toMatch(/^provider_error/);
    mock.enqueue({ kind: "raw", body: '{"choices":[]}' });
    expect(await code(client({ maxRetries: 0 }).chat(req))).toMatch(/^provider_error/);
    mock.enqueue({ kind: "raw", body: "<html>nu</html>" });
    expect(await code(client({ maxRetries: 0 }).chat(req))).toMatch(/^provider_error/);
  });

  it("mesajul erorii nu conține cheia sau conținutul", async () => {
    mock.enqueue({ kind: "raw", body: `{"secret":"${KEY}"` });
    try {
      await client({ maxRetries: 0 }).chat(req);
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY);
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });
});
