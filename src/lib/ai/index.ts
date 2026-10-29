/**
 * `lib/ai` (master prompt 3.6; ADR 0014): clientul LiteLLM, plafoanele de parsare și estimarea
 * costului. Serverul fals (`mock-server.ts`) se importă direct, doar din teste și din evaluare.
 */
export {
  type AiClient,
  type AiClientOptions,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
  MODEL_JSON_LIMITS,
  createAiClient,
  parseModelJson,
  validateBaseUrl,
} from "./client";
export { type Pricing, actualCostOf, costOfTokens, estimatePromptTokens, maxCostOf } from "./cost";
export { AiError, type AiErrorCode, aiCallResultOf } from "./errors";
export { type JsonLimits, checkJsonShape, parseJsonGuarded, stripCodeFence } from "./json-guard";

/** Furnizorul unui alias: `*-local` = local (rezervat, Faza 6 nu are model local); altfel extern. */
export function providerOf(modelAlias: string): "local" | "external" {
  return modelAlias.endsWith("-local") ? "local" : "external";
}
