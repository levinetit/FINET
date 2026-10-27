import { main } from "./migrate-cli";

// Intrarea împachetată de `scripts/build-tools.mjs` în `dist/tools/migrate.mjs`.
process.exitCode = await main({
  env: process.env,
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
