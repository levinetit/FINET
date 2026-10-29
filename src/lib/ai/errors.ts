/**
 * Erorile clientului AI (Faza 6, F6-B; ADR 0014). Mesajele sunt fixe: nu conțin niciodată
 * răspunsul modelului, cheia, URL-ul sau textul trimis. `code` e stabil (loguri, `ai_calls`).
 *
 * - `timeout`: termenul unei încercări sau termenul total a expirat (cererea a fost anulată);
 * - `provider_error`: rețea, HTTP 4xx/5xx, plic de răspuns invalid;
 * - `response_too_large`: corpul sau conținutul depășește plafonul (citirea e oprită);
 * - `failed_validation`: conținutul nu e JSON-ul cerut (formă, adâncime, Zod);
 * - `budget_exceeded`: bugetul lunar sau plafonul zilnic nu permite apelul (nimic nu pleacă);
 * - `config`: URL-ul de bază nu e permis (SSRF) sau lipsește cheia.
 */
export type AiErrorCode =
  | "timeout"
  | "provider_error"
  | "response_too_large"
  | "failed_validation"
  | "budget_exceeded"
  | "config";

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    /** Detaliu stabil, fără conținut (de exemplu `http_429`, `depth`). */
    readonly detail: string = code,
  ) {
    super(`Apelul AI a eșuat: ${code}`);
    this.name = "AiError";
  }
}

/** `result` din `ai_calls` pentru o eroare (CHECK-ul din 0008 are o listă închisă). */
export function aiCallResultOf(code: AiErrorCode): "timeout" | "failed_validation" | "error" {
  switch (code) {
    case "timeout":
      return "timeout";
    case "failed_validation":
    case "response_too_large":
      return "failed_validation";
    default:
      return "error";
  }
}
