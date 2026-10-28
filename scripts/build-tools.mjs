// Împachetează uneltele de rulat în containerul `tools` (Dockerfile, ținta `tools`) într-un
// singur fișier ESM pe unealtă, în dist/tools/. Codul FINET (TypeScript, aliasul `@/` din
// tsconfig) intră în pachet; dependențele de producție (postgres, drizzle-orm, zod) rămân
// externe și vin din node_modules-ul de producție al imaginii.
// `server-only` e împachetat cu condiția `react-server` (varianta goală): uneltele rulează doar
// pe server, iar varianta implicită a pachetului ar arunca la import.
import { build } from "esbuild";

const EXTERNAL = ["postgres", "drizzle-orm", "zod"];

const TOOLS = {
  migrate: "src/db/migrate-entry.ts",
  // CLI-ul de administrare (F1-B): fără better-auth, nodemailer sau next în graful de importuri.
  admin: "src/tools/admin/entry.ts",
};

for (const [name, entry] of Object.entries(TOOLS)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/tools/${name}.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    conditions: ["react-server"],
    external: EXTERNAL,
    tsconfig: "tsconfig.json",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  });
  console.log(`build-tools: dist/tools/${name}.mjs`);
}
