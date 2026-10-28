#!/usr/bin/env node
// Bugetul de mărime JavaScript (Faza 4, ADR 0010): calculează „First Load JS” (gzip) pentru
// fiecare pagină din build-ul de producție Next 16 (`.next`) și îl compară cu pragurile din
// `docs/PERFORMANCE.md` (blocul ```json bundle-budget```). Pică (cod 1) dacă o rută depășește
// pragul; cod 2: eroare de utilizare (build lipsă, praguri lipsă).
//
// Sursa (robustă pentru Turbopack, care NU mai scrie `app-build-manifest.json`):
// - `.next/server/app/**/page_client-reference-manifest.js` → `entryJSFiles` (chunk-urile
//   fiecărui segment: layout-uri, error, not-found, pagina);
// - `.next/build-manifest.json` → `rootMainFilesTree[<rută>]` sau `rootMainFiles` (runtime-ul
//   React/Next, comun). `polyfillFiles` sunt `nomodule` (nu se încarcă în browserele moderne).
// Chunk-urile se deduplică per rută, apoi se comprimă cu gzip (nivelul implicit zlib, ca
// serverul) și se adună.
//
// Utilizare: node scripts/check-bundle-size.mjs [--next-dir .next] [--budget docs/PERFORMANCE.md]
//                                               [--json raport.json]

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** `/(app)/transactions/[id]/page` → `/transactions/[id]`; `/page` → `/`. */
export function routeOf(key) {
  const parts = key.split("/").filter((p) => p !== "" && !(p.startsWith("(") && p.endsWith(")")));
  if (parts.at(-1) === "page") parts.pop();
  return `/${parts.join("/")}`;
}

/** Obiectul din `globalThis.__RSC_MANIFEST["<cheie>"] = {…};` (JSON, fără evaluarea codului). */
export function parseClientReferenceManifest(text) {
  const m = /globalThis\.__RSC_MANIFEST\["([^"]+)"\]\s*=\s*/.exec(text);
  if (!m) throw new Error("manifest RSC fără cheie");
  const start = m.index + m[0].length;
  const end = text.lastIndexOf("}");
  if (end < start) throw new Error("manifest RSC trunchiat");
  return { key: m[1], manifest: JSON.parse(text.slice(start, end + 1)) };
}

function manifestFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) manifestFiles(path, out);
    else if (name === "page_client-reference-manifest.js") out.push(path);
  }
  return out;
}

/** Fișier `static/chunks/x.js` sau `/_next/static/chunks/x.js` → cale relativă la `.next`. */
function normalize(file) {
  return file.replace(/^\/?_next\//, "").replace(/^\//, "");
}

const gzipCache = new Map();
function gzipSize(nextDir, file) {
  const path = join(nextDir, file);
  let size = gzipCache.get(path);
  if (size === undefined) {
    if (!existsSync(path)) throw new Error(`chunk lipsă: ${file}`);
    size = gzipSync(readFileSync(path)).length;
    gzipCache.set(path, size);
  }
  return size;
}

/**
 * First Load JS per rută: `[{ route, key, files, gzipBytes }]`, sortat după rută. Rutele interne
 * (`/_not-found`, `/_global-error`) se ignoră.
 */
export function measureRoutes(nextDir) {
  const buildManifestPath = join(nextDir, "build-manifest.json");
  if (!existsSync(buildManifestPath)) throw new Error(`lipsește ${buildManifestPath}`);
  const build = JSON.parse(readFileSync(buildManifestPath, "utf8"));
  const manifests = manifestFiles(join(nextDir, "server", "app"));
  if (manifests.length === 0) throw new Error("niciun page_client-reference-manifest.js");
  const rows = [];
  for (const file of manifests) {
    const { key, manifest } = parseClientReferenceManifest(readFileSync(file, "utf8"));
    const route = routeOf(key);
    if (route.split("/").some((p) => p.startsWith("_"))) continue;
    const root = build.rootMainFilesTree?.[key] ?? build.rootMainFiles ?? [];
    const entries = Object.values(manifest.entryJSFiles ?? {}).flat();
    const files = [...new Set([...root, ...entries].map(normalize))]
      .filter((f) => f.endsWith(".js"))
      .sort();
    const gzipBytes = files.reduce((sum, f) => sum + gzipSize(nextDir, f), 0);
    rows.push({ route, key, files, gzipBytes });
  }
  return rows.sort((a, b) => a.route.localeCompare(b.route));
}

/** Pragurile din blocul ```json bundle-budget``` al documentului (KiB gzip). */
export function parseBudget(markdown) {
  const m = /```json bundle-budget\n([\s\S]*?)```/.exec(markdown);
  if (!m) throw new Error("lipsește blocul ```json bundle-budget``` din docs/PERFORMANCE.md");
  const budget = JSON.parse(m[1]);
  if (typeof budget.defaultKiB !== "number" || budget.defaultKiB <= 0) {
    throw new Error("bundle-budget: `defaultKiB` lipsește sau e invalid");
  }
  return { defaultKiB: budget.defaultKiB, routes: budget.routes ?? {} };
}

/** Pragul unei rute: exact, apoi cel mai lung prefix (`/accounts` → `/accounts/[id]`), apoi implicit. */
export function limitFor(budget, route) {
  if (budget.routes[route] !== undefined) return budget.routes[route];
  const prefix = Object.keys(budget.routes)
    .filter((p) => p !== "/" && route.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? budget.routes[prefix] : budget.defaultKiB;
}

/** Rândurile cu pragul și verdictul. */
export function evaluate(rows, budget) {
  return rows.map((r) => {
    const limitKiB = limitFor(budget, r.route);
    const kib = r.gzipBytes / 1024;
    return { ...r, kib, limitKiB, ok: kib <= limitKiB };
  });
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const nextDir = resolve(opt("--next-dir", ".next"));
  const budgetPath = resolve(opt("--budget", "docs/PERFORMANCE.md"));
  const jsonOut = opt("--json", null);
  let results;
  try {
    const budget = parseBudget(readFileSync(budgetPath, "utf8"));
    results = evaluate(measureRoutes(nextDir), budget);
  } catch (error) {
    console.error(`check-bundle-size: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Rulează întâi `pnpm build` (build de producție).");
    return 2;
  }
  const width = Math.max(...results.map((r) => r.route.length), 4);
  console.log(`${"Ruta".padEnd(width)}  First Load JS (gzip)  Prag`);
  for (const r of results) {
    console.log(
      `${r.route.padEnd(width)}  ${`${r.kib.toFixed(1)} KiB`.padStart(20)}  ${r.limitKiB} KiB${r.ok ? "" : "  DEPĂȘIT"}`,
    );
  }
  if (jsonOut) {
    const out = results.map(({ route, gzipBytes, limitKiB, ok, files }) => ({
      route,
      gzipBytes,
      limitKiB,
      ok,
      chunks: files.length,
    }));
    writeFileSync(jsonOut, `${JSON.stringify(out, null, 2)}\n`);
  }
  const over = results.filter((r) => !r.ok);
  if (over.length > 0) {
    console.error(`check-bundle-size: ${over.length} rută(e) peste prag (docs/PERFORMANCE.md).`);
    return 1;
  }
  console.log(
    `check-bundle-size: ${results.length} rute în buget (${relative(process.cwd(), nextDir).split(sep).join("/") || "."}).`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
