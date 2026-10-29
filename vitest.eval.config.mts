import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm eval:receipts` (F6-B, ADR 0014): evaluarea pe bonuri sintetice, în afara suitei standard.
// Implicit pe serverul AI fals; LiteLLM real doar cu AI_EVAL=1 (vezi scripts/eval-receipts.eval.ts).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["scripts/eval-receipts.eval.ts"],
    testTimeout: 900_000,
  },
});
