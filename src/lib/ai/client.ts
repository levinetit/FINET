import { z } from "zod";

import { AiError } from "./errors";
import { type JsonLimits, parseJsonGuarded, stripCodeFence } from "./json-guard";

/**
 * Clientul AI al FINET (Faza 6, F6-B; master prompt 3.6; ADR 0014): LiteLLM-ul de pe gazdă,
 * API compatibil OpenAI (`POST <AI_BASE_URL>/chat/completions`). Alias-urile modelelor
 * (`finet-vision-external`, `finet-text-external`) stau în configurația LiteLLM, nu în cod.
 *
 * Garanții (revizuirile F6-A, aplicate din prima):
 * - **SSRF:** URL-ul de bază se validează la construcție (doar `http(s)`, fără utilizator/parolă,
 *   query sau fragment, gazda:port EXACT din lista permisă); URL-ul final se recalculează cu
 *   `new URL` și gazda se verifică din nou; redirecționările sunt refuzate (`redirect: "error"`).
 * - **Timpul:** fiecare încercare are propriul `AbortController` (termenul încercării), plafonat
 *   de un termen TOTAL peste toate încercările; anularea oprește și citirea corpului.
 * - **Reîncercări** doar la timeout, eroare de rețea, 429 și 5xx (cu pauză exponențială); NU la
 *   un răspuns invalid (fiecare încercare costă). Cârligul `beforeAttempt` rulează înaintea
 *   FIECĂREI încercări (rezervarea bugetului; poate opri apelul cu `budget_exceeded`).
 * - **Răspunsul:** `Content-Length` peste plafon → refuz fără citire; altfel corpul se citește în
 *   flux cu plafon de octeți (peste el, cererea e anulată); plicul se parsează cu plafoane de
 *   adâncime/valori, apoi Zod; conținutul (`choices[0].message.content`) are plafon de lungime
 *   ÎNAINTE de parsare și se întoarce ca TEXT: apelantul îl parsează cu `parseModelJson` și îl
 *   validează cu Zod strict. Ieșirea modelului e doar o dată neîncrezătoare: clientul nu trimite
 *   `tools`/`functions` și nu execută nimic din răspuns.
 * - **Cheia** vine doar din configurație (fișierul `AI_API_KEY_FILE`) și apare doar în antetul
 *   `Authorization`; nicio eroare sau log nu conține cheia, URL-ul complet sau conținut.
 */

export type ContentPart =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image_url"; image_url: Readonly<{ url: string }> }>;

export type ChatMessage = Readonly<{
  role: "system" | "user";
  content: string | readonly ContentPart[];
}>;

export type ChatRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  /** Plafonul de tokeni de ieșire (și baza estimării pesimiste a costului). */
  maxTokens: number;
  /** Schema JSON a răspunsului (`response_format: json_schema`, strict). */
  jsonSchema?: Readonly<{ name: string; schema: Readonly<Record<string, unknown>> }>;
  /**
   * Cum se cere JSON-ul (`AI_RESPONSE_FORMAT`): `json_schema` (implicit, structurat strict),
   * `json_object` (doar JSON) sau `none`. Validarea reală o face oricum Zod, în apelant.
   */
  responseFormat?: "json_schema" | "json_object" | "none";
}>;

export type ChatUsage = Readonly<{ promptTokens: number; completionTokens: number }>;

export type ChatResult = Readonly<{
  /** Textul răspunsului (NEPARSAT, neîncrezător). */
  content: string;
  /** Tokenii raportați de furnizor; `null` dacă lipsesc sau sunt invalizi. */
  usage: ChatUsage | null;
  attempts: number;
  durationMs: number;
}>;

export type AttemptInfo = Readonly<{ attempt: number }>;

export type AiClientOptions = Readonly<{
  baseUrl: string;
  apiKey: string;
  /** Gazdele permise, ca `host` sau `host:port` (comparate exact cu `URL.host`). */
  allowedHosts: readonly string[];
  /** Termenul unei încercări. */
  timeoutMs: number;
  /** Reîncercări după prima încercare (0..3). */
  maxRetries: number;
  /** Pauza de bază între încercări (dublată la fiecare reîncercare). */
  retryBaseMs?: number;
  /** Termenul total peste toate încercările (implicit: încercările + pauzele). */
  totalTimeoutMs?: number;
  /** Plafonul corpului HTTP citit (implicit 512 KB). */
  maxResponseBytes?: number;
  /** Plafonul conținutului mesajului (implicit 128 000 de caractere). */
  maxContentChars?: number;
  /** Doar teste. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}>;

export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
export const DEFAULT_MAX_CONTENT_CHARS = 128_000;
const ENVELOPE_LIMITS: JsonLimits = { maxChars: 1_000_000, maxDepth: 12, maxValues: 20_000 };

/** Valoarea pe care o primește apelantul dacă un câmp de config nu e valid (SSRF). */
export function validateBaseUrl(baseUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AiError("config", "base_url_invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AiError("config", "base_url_protocol");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new AiError("config", "base_url_shape");
  }
  const allowed = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  if (!allowed.has(url.host.toLowerCase())) throw new AiError("config", "base_url_host");
  // Calea de bază se termină cu `/`, ca `new URL("chat/completions", base)` s-o păstreze.
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url;
}

const envelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().max(64).nullish(),
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1)
    .max(8),
  usage: z
    .object({
      prompt_tokens: z.number().int().min(0).max(100_000_000),
      completion_tokens: z.number().int().min(0).max(100_000_000),
    })
    .nullish()
    .catch(null),
});

type AttemptOutcome =
  | Readonly<{ ok: true; content: string; usage: ChatUsage | null }>
  | Readonly<{ ok: false; error: AiError; retryable: boolean }>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type AiClient = Readonly<{
  chat(request: ChatRequest, hooks?: ChatHooks): Promise<ChatResult>;
}>;

export type ChatHooks = Readonly<{
  /** Înaintea fiecărei încercări (rezervarea bugetului); o eroare oprește apelul. */
  beforeAttempt?: (info: AttemptInfo) => Promise<void>;
  /** Termen absolut (ms epoch) al apelantului, de exemplu termenul documentului. */
  deadline?: number;
}>;

export function createAiClient(options: AiClientOptions): AiClient {
  const base = validateBaseUrl(options.baseUrl, options.allowedHosts);
  const endpoint = new URL("chat/completions", base);
  // Verificare repetată după compunere (o cale de bază ciudată nu poate schimba gazda).
  if (endpoint.host !== base.host || endpoint.protocol !== base.protocol) {
    throw new AiError("config", "endpoint_host");
  }
  if (!options.apiKey || /[\r\n]/.test(options.apiKey)) throw new AiError("config", "api_key");
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 3) {
    throw new AiError("config", "max_retries");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
    throw new AiError("config", "timeout");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const retryBaseMs = options.retryBaseMs ?? 1000;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const totalTimeoutMs =
    options.totalTimeoutMs ??
    options.timeoutMs * (options.maxRetries + 1) + retryBaseMs * (2 ** options.maxRetries - 1);

  async function readCapped(response: Response, controller: AbortController): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      controller.abort();
      throw new AiError("response_too_large", "content_length");
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw new AiError("response_too_large", "body_bytes");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(all);
    } catch {
      throw new AiError("provider_error", "body_encoding");
    }
  }

  async function attempt(body: string, timeoutMs: number): Promise<AttemptOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        return timedOut
          ? { ok: false, error: new AiError("timeout"), retryable: true }
          : { ok: false, error: new AiError("provider_error", "network"), retryable: true };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        const retryable = response.status === 429 || response.status >= 500;
        return {
          ok: false,
          error: new AiError("provider_error", `http_${response.status}`),
          retryable,
        };
      }
      let text: string;
      try {
        text = await readCapped(response, controller);
      } catch (error) {
        if (timedOut) return { ok: false, error: new AiError("timeout"), retryable: true };
        if (error instanceof AiError) return { ok: false, error, retryable: false };
        return { ok: false, error: new AiError("provider_error", "body_read"), retryable: true };
      }
      let envelope: z.infer<typeof envelopeSchema>;
      try {
        const parsed = envelopeSchema.safeParse(parseJsonGuarded(text, ENVELOPE_LIMITS));
        if (!parsed.success) throw new AiError("provider_error", "envelope");
        envelope = parsed.data;
      } catch (error) {
        const e = error instanceof AiError ? error : new AiError("provider_error", "envelope");
        return { ok: false, error: new AiError("provider_error", e.detail), retryable: false };
      }
      const choice = envelope.choices[0]!;
      const usage = envelope.usage
        ? {
            promptTokens: envelope.usage.prompt_tokens,
            completionTokens: envelope.usage.completion_tokens,
          }
        : null;
      if (choice.finish_reason === "length") {
        return {
          ok: false,
          error: new AiError("failed_validation", "truncated"),
          retryable: false,
        };
      }
      const content = choice.message.content ?? "";
      if (content.length > maxContentChars) {
        return {
          ok: false,
          error: new AiError("response_too_large", "content_chars"),
          retryable: false,
        };
      }
      return { ok: true, content, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async chat(request: ChatRequest, hooks: ChatHooks = {}): Promise<ChatResult> {
      const payload: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: 0,
        stream: false,
      };
      const format = request.responseFormat ?? "json_schema";
      if (request.jsonSchema && format === "json_object") {
        payload.response_format = { type: "json_object" };
      } else if (request.jsonSchema && format === "json_schema") {
        payload.response_format = {
          type: "json_schema",
          json_schema: {
            name: request.jsonSchema.name,
            strict: true,
            schema: request.jsonSchema.schema,
          },
        };
      }
      const body = JSON.stringify(payload);
      const started = now();
      const deadline = Math.min(
        started + totalTimeoutMs,
        hooks.deadline ?? Number.POSITIVE_INFINITY,
      );
      let last: AiError = new AiError("provider_error");
      for (let i = 0; i <= options.maxRetries; i++) {
        if (i > 0) {
          const pause = retryBaseMs * 2 ** (i - 1);
          if (now() + pause >= deadline) break;
          await sleep(pause);
        }
        const remaining = deadline - now();
        if (remaining <= 0) {
          last = new AiError("timeout", "total");
          break;
        }
        await hooks.beforeAttempt?.({ attempt: i + 1 });
        const outcome = await attempt(body, Math.min(options.timeoutMs, remaining));
        if (outcome.ok) {
          return {
            content: outcome.content,
            usage: outcome.usage,
            attempts: i + 1,
            durationMs: Math.max(0, now() - started),
          };
        }
        last = outcome.error;
        if (!outcome.retryable) break;
      }
      throw last;
    },
  });
}

/** Limitele implicite pentru JSON-ul din conținutul mesajului (bonul are ≤ 500 de linii). */
export const MODEL_JSON_LIMITS: JsonLimits = {
  maxChars: DEFAULT_MAX_CONTENT_CHARS,
  maxDepth: 6,
  maxValues: 12_000,
};

/** Conținutul modelului → valoare JSON, cu plafoane înainte de parsare (vezi `json-guard`). */
export function parseModelJson(content: string, limits: JsonLimits = MODEL_JSON_LIMITS): unknown {
  if (content.length > limits.maxChars) throw new AiError("response_too_large", "content_chars");
  return parseJsonGuarded(stripCodeFence(content), limits);
}
