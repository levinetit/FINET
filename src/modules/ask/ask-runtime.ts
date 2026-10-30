import "server-only";

import { type AiClient, createAiClient } from "@/lib/ai";
import type { Config } from "@/lib/config";
import type { Money } from "@/lib/money";

/**
 * Furnizorul AI al „Întreabă FINET” pe serverul WEB (F10-C, pasul LLM; ADR 0026): doar cu `AI_ASK=1`,
 * `AI_BASE_URL` și cheia DEDICATĂ (`AI_ASK_API_KEY_FILE`, nu cea a workerului). `null` = pasul LLM
 * nu rulează (întrebările neînțelese de parser primesc „nu am înțeles”).
 */
export type AskAi = Readonly<{
  client: AiClient;
  textModel: string;
  pricing: Config["ai"]["pricing"];
  monthlyBudget: Money;
  responseFormat: Config["ai"]["responseFormat"];
}>;

export function askAiFromConfig(config: Pick<Config, "ai">): AskAi | null {
  const ai = config.ai;
  if (!ai.ask.enabled || ai.ask.apiKey === null || ai.baseUrl === null) return null;
  return {
    client: createAiClient({
      baseUrl: ai.baseUrl,
      apiKey: ai.ask.apiKey,
      allowedHosts: ai.allowedHosts,
      timeoutMs: ai.timeoutMs,
      maxRetries: Math.min(ai.maxRetries, 1),
    }),
    textModel: ai.textModel,
    pricing: ai.pricing,
    monthlyBudget: ai.monthlyBudget,
    responseFormat: ai.responseFormat,
  };
}
