import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Teste unitare și de integrare (Node). Testele E2E sunt în `e2e/` și rulează cu Playwright.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
  },
});
