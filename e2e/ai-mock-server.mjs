// Serverul AI FALS pentru E2E (F6-C, ADR 0015): un proces separat, compatibil OpenAI
// (`POST /v1/chat/completions`), pornit de CI înaintea workerului. Răspunsuri DETERMINISTE:
// pentru o cerere „vision”, bonul întors depinde de LĂȚIMEA pozei JPEG preprocesate (testul E2E
// generează poze cu lățimi fixe, sub 2048 px, deci workerul nu le redimensionează):
//   801 → un bon simplu (Kaufland, 2 linii, totalul se potrivește);
//   802 / 803 → cele două părți ale unui bon lung (Lidl), cu o linie în suprapunere;
//   altfel → un bon generic, cu numărul bonului = lățimea (fără coliziuni de deduplicare).
// Categorisirea întoarce „necategorizat” pentru toate liniile. `GET /__requests` → numărul de
// cereri primite (testul „fără consimțământ, nimic nu ajunge la AI”). Nimic nu pleacă în afară.
// Rulare: `node e2e/ai-mock-server.mjs` (portul din `E2E_AI_MOCK_PORT`, implicit 4010).
import { createServer } from "node:http";

import { jpegWidth, receiptFor } from "../scripts/e2e-ai-mock-data.mjs";

const PORT = Number(process.env.E2E_AI_MOCK_PORT ?? 4010);
const MAX_BODY = 32 * 1024 * 1024;
let count = 0;

function completion(content) {
  return JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: 0,
    model: "e2e-mock",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 },
  });
}

function answer(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      const url = part?.image_url?.url;
      if (typeof url === "string" && url.startsWith("data:image/jpeg;base64,")) {
        const width = jpegWidth(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
        return JSON.stringify(receiptFor(width));
      }
    }
  }
  // Text: categorisirea (sau un PDF cu text, nefolosit în E2E) → nicio categorie.
  const text = JSON.stringify(messages);
  if (text.includes("categor")) return JSON.stringify({ items: [] });
  return JSON.stringify(receiptFor(null));
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__requests") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count }));
    return;
  }
  if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  count++;
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      body = null;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(completion(answer(body)));
  });
});

if (process.argv[1]?.endsWith("ai-mock-server.mjs")) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`ai-mock: http://127.0.0.1:${PORT}/v1`);
  });
}
