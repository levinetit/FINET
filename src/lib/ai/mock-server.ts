import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Serverul AI FALS (Faza 6, F6-B; ADR 0014): un server HTTP local (127.0.0.1, port aleator),
 * compatibil OpenAI (`POST /v1/chat/completions`), cu răspunsuri DETERMINISTE. Îl folosesc toate
 * testele standard, CI-ul și `pnpm eval:receipts` fără `AI_EVAL=1`: nicio cerere nu pleacă la un
 * furnizor real.
 *
 * Fiecare cerere e trecută printr-un `handler` care întoarce un „scenariu”: un conținut JSON (ca
 * text), JSON invalid, un status HTTP, o pauză (timeout), un corp uriaș etc. Serverul numără
 * cererile și păstrează ultimele cereri (antete + corp, plafonat), ca testele să verifice ce a
 * plecat (de exemplu: zero cereri fără consimțământ; imaginea fără EXIF).
 */

export type MockScenario =
  | Readonly<{
      kind: "content";
      content: string;
      usage?: { prompt: number; completion: number } | null;
      finishReason?: string;
    }>
  | Readonly<{ kind: "status"; status: number }>
  | Readonly<{ kind: "raw"; body: string; contentType?: string }>
  | Readonly<{ kind: "hang" }>
  | Readonly<{ kind: "huge"; bytes: number; declareLength?: boolean }>
  | Readonly<{ kind: "redirect"; location: string }>;

export type MockRequest = Readonly<{
  path: string;
  authorization: string | null;
  body: Readonly<Record<string, unknown>> | null;
}>;

export type MockHandler = (request: MockRequest, index: number) => MockScenario;

export type MockAiServer = Readonly<{
  /** URL-ul de bază (`http://127.0.0.1:<port>/v1`). */
  baseUrl: string;
  /** `host:port`, pentru lista de gazde permise. */
  host: string;
  requests: MockRequest[];
  /** Schimbă handlerul (de exemplu între teste). */
  setHandler(handler: MockHandler): void;
  /** Coadă de scenarii, consumate în ordine; după ce se golește, se folosește handlerul. */
  enqueue(...scenarios: MockScenario[]): void;
  reset(): void;
  close(): Promise<void>;
}>;

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** Răspunsul OpenAI pentru un conținut dat. */
export function completion(
  content: string,
  usage: { prompt: number; completion: number } | null = { prompt: 1200, completion: 300 },
  finishReason = "stop",
): string {
  return JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: 0,
    model: "mock",
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            total_tokens: usage.prompt + usage.completion,
          },
        }
      : {}),
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("cerere prea mare");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMockAiServer(
  handler: MockHandler = () => ({ kind: "status", status: 500 }),
): Promise<MockAiServer> {
  let current = handler;
  const queue: MockScenario[] = [];
  const requests: MockRequest[] = [];
  const hanging = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    void (async () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        body = null;
      }
      const request: MockRequest = {
        path: req.url ?? "",
        authorization: req.headers.authorization ?? null,
        body,
      };
      requests.push(request);
      const scenario = queue.shift() ?? current(request, requests.length - 1);
      switch (scenario.kind) {
        case "content": {
          const text = completion(
            scenario.content,
            scenario.usage === undefined ? undefined : scenario.usage,
            scenario.finishReason,
          );
          res.writeHead(200, { "content-type": "application/json" });
          res.end(text);
          return;
        }
        case "status":
          res.writeHead(scenario.status, { "content-type": "application/json" });
          res.end('{"error":{"message":"mock"}}');
          return;
        case "raw":
          res.writeHead(200, { "content-type": scenario.contentType ?? "application/json" });
          res.end(scenario.body);
          return;
        case "redirect":
          res.writeHead(307, { location: scenario.location });
          res.end();
          return;
        case "hang":
          hanging.add(res);
          res.on("close", () => hanging.delete(res));
          return;
        case "huge": {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (scenario.declareLength) headers["content-length"] = String(scenario.bytes);
          res.writeHead(200, headers);
          const chunk = Buffer.alloc(64 * 1024, 0x20);
          let sent = 0;
          const pump = () => {
            while (sent < scenario.bytes) {
              sent += chunk.byteLength;
              if (!res.write(chunk)) {
                res.once("drain", pump);
                return;
              }
            }
            res.end();
          };
          res.on("error", () => {});
          pump();
          return;
        }
      }
    })();
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;

  return {
    baseUrl: `http://${host}/v1`,
    host,
    requests,
    setHandler(h) {
      current = h;
    },
    enqueue(...scenarios) {
      queue.push(...scenarios);
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
    },
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
