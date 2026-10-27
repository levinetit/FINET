import { main } from "./cli";

// Intrarea împachetată de `scripts/build-tools.mjs` în `dist/tools/admin.mjs`.
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "--password-stdin: stdin e un terminal; trimite parola printr-un pipe sau fișier",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > 4096) throw new Error("--password-stdin: intrare prea mare");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

process.exitCode = await main({
  env: process.env,
  argv: process.argv.slice(2),
  readStdin,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
