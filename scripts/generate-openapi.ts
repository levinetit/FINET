import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderOpenApi } from "@/openapi/document";

/**
 * Generează `docs/openapi.json` din registrul `src/openapi/` (`pnpm openapi:generate`) sau
 * verifică faptul că fișierul din repo e la zi (`pnpm openapi:check`, cod de ieșire 1 dacă
 * diferă). Se rulează împachetat de `scripts/openapi.mjs` (esbuild, aliasul `@/`).
 */

const TARGET = join(process.cwd(), "docs", "openapi.json");

export function run(argv: readonly string[]): number {
  const expected = renderOpenApi();
  if (argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(TARGET, "utf8");
    } catch {
      // lipsește: diferă
    }
    if (current !== expected) {
      console.error("openapi: docs/openapi.json nu e la zi; rulează `pnpm openapi:generate`");
      return 1;
    }
    console.log("openapi: docs/openapi.json e la zi");
    return 0;
  }
  writeFileSync(TARGET, expected);
  console.log("openapi: docs/openapi.json generat");
  return 0;
}

process.exitCode = run(process.argv.slice(2));
