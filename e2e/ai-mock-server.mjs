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

const PORT = Number(process.env.E2E_AI_MOCK_PORT ?? 4010);
const MAX_BODY = 32 * 1024 * 1024;
let count = 0;

/** Lățimea unei imagini JPEG (markerul SOFn), fără biblioteci. */
export function jpegWidth(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return buf.readUInt16BE(i + 7);
    }
    i += 2 + len;
  }
  return null;
}

const line = (name, quantity, unitPrice, lineTotal) => ({
  name,
  quantity,
  unitPrice,
  lineTotal,
  vatRate: "11",
  type: "item",
});

const base = {
  storeAddress: null,
  paymentMethod: "card",
  currency: "RON",
  vatTotal: null,
};

export function receiptFor(width) {
  if (width === 801) {
    return {
      ...base,
      merchantName: "KAUFLAND ROMANIA SCS",
      merchantTaxId: "RO15991149",
      receiptNumber: "0777",
      date: "2026-10-20",
      total: "20.48",
      lines: [
        line("LAPTE ZUZU 1L", "2", "7.49", "14.98"),
        line("PAINE TOAST", "1", "5.50", "5.50"),
      ],
    };
  }
  if (width === 802) {
    return {
      ...base,
      merchantName: "LIDL DISCOUNT SRL",
      merchantTaxId: "RO22891860",
      receiptNumber: "0142",
      date: "2026-10-21",
      total: null,
      lines: [
        line("PAINE", "1", "3.00", "3.00"),
        line("LAPTE", "1", "7.50", "7.50"),
        line("OUA", "1", "12.00", "12.00"),
      ],
    };
  }
  if (width === 803) {
    return {
      ...base,
      merchantName: null,
      merchantTaxId: null,
      receiptNumber: null,
      date: null,
      total: "27.50",
      lines: [line("OUA", "1", "12.00", "12.00"), line("MERE", "1", "5.00", "5.00")],
    };
  }
  return {
    ...base,
    merchantName: "MEGA IMAGE SRL",
    merchantTaxId: "RO6719278",
    receiptNumber: String(width ?? 1),
    date: "2026-10-22",
    total: "9.99",
    lines: [line("APA PLATA 2L", "1", "9.99", "9.99")],
  };
}

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
