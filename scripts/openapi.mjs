// Rulează scripts/generate-openapi.ts: îl împachetează cu esbuild (aliasul `@/` din tsconfig,
// condiția `react-server` pentru `server-only`) într-un fișier temporar din dist/tools/ și îl
// execută. `node scripts/openapi.mjs` scrie docs/openapi.json; cu `--check` doar verifică.
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const outfile = resolve("dist/tools/openapi.mjs");
await build({
  entryPoints: ["scripts/generate-openapi.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["react-server"],
  external: ["postgres", "drizzle-orm", "zod"],
  tsconfig: "tsconfig.json",
  logLevel: "warning",
});
await import(pathToFileURL(outfile).href);
