import { main } from "./cli";

// Intrarea împachetată de `scripts/build-tools.mjs` în `dist/tools/worker.mjs` (finet-worker).
const result = await main({
  env: process.env,
  out: (line) => console.log(line),
  onSignal: (stop) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void stop().then(() => process.exit(0));
      });
    }
  },
});
if (result.code !== 0) process.exit(result.code);
