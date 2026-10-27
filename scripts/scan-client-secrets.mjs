#!/usr/bin/env node
// Scanează fișierele trimise browserului (implicit `.next/static`) după secrete scăpate în bundle.
// Pică (cod 1) dacă găsește un tipar de cheie secretă sau numele unei variabile marcate `# secret`
// în `.env.example`. Cod 2: eroare de utilizare (de exemplu directorul lipsește).
//
// Utilizare: node scripts/scan-client-secrets.mjs [director] [--env-example cale]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Tiparele de chei secrete căutate (master prompt 6.3). */
export const SECRET_PATTERNS = [
  { name: "Stripe live secret key", regex: /sk_live_[0-9A-Za-z]{8,}/g },
  { name: "Stripe test secret key", regex: /sk_test_[0-9A-Za-z]{8,}/g },
  { name: "Stripe restricted key", regex: /rk_live_[0-9A-Za-z]{8,}/g },
  { name: "Stripe webhook secret", regex: /whsec_[0-9A-Za-z]{8,}/g },
  { name: "cheie privată PEM", regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
];

/**
 * Extrage din conținutul unui `.env.example` numele variabilelor marcate cu un rând `# secret`
 * imediat deasupra. Variabilele `NEXT_PUBLIC_*` sunt publice și se ignoră mereu.
 * @param {string} text
 * @returns {string[]}
 */
export function parseSecretNames(text) {
  const names = [];
  let marked = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#\s*secret\s*$/i.test(line)) {
      marked = true;
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (match) {
      const name = match[1];
      if (marked && !name.startsWith("NEXT_PUBLIC_")) names.push(name);
      marked = false;
    } else if (line !== "" && !line.startsWith("#")) {
      marked = false;
    }
  }
  return [...new Set(names)];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Scanează recursiv un director. Întoarce constatările (fișier, tip), fără valoarea găsită,
 * ca un secret real să nu ajungă în logurile CI.
 * @param {string} dir
 * @param {{ secretNames?: string[] }} [options]
 * @returns {{ file: string, kind: string }[]}
 */
export function scanDirectory(dir, options = {}) {
  const nameRegexes = (options.secretNames ?? []).map((name) => ({
    name: `numele variabilei secrete ${name}`,
    regex: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g"),
  }));
  const checks = [...SECRET_PATTERNS, ...nameRegexes];
  const findings = [];
  for (const file of walk(dir)) {
    const content = readFileSync(file, "latin1");
    for (const check of checks) {
      check.regex.lastIndex = 0;
      if (check.regex.test(content)) {
        findings.push({ file: relative(dir, file), kind: check.name });
      }
    }
  }
  return findings;
}

function main(argv) {
  const args = argv.slice(2);
  let envExample = ".env.example";
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env-example") envExample = args[++i] ?? "";
    else positional.push(args[i]);
  }
  const dir = resolve(positional[0] ?? ".next/static");

  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    console.error(`Eroare: directorul de scanat nu există: ${dir} (rulează întâi build-ul).`);
    return 2;
  }

  let secretNames = [];
  try {
    secretNames = parseSecretNames(readFileSync(envExample, "utf8"));
  } catch {
    console.error(`Eroare: nu pot citi ${envExample} (lista variabilelor secrete).`);
    return 2;
  }

  const findings = scanDirectory(dir, { secretNames });
  if (findings.length > 0) {
    console.error(`Scanare eșuată: ${findings.length} constatări în ${dir}`);
    for (const f of findings) console.error(`  - ${f.file}: ${f.kind}`);
    return 1;
  }
  console.log(
    `Scanare curată: niciun secret în ${dir} (${SECRET_PATTERNS.length} tipare, ${secretNames.length} nume de variabile).`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
