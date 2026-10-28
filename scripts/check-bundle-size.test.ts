import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  evaluate,
  limitFor,
  measureRoutes,
  parseBudget,
  parseClientReferenceManifest,
  routeOf,
} from "./check-bundle-size.mjs";

const SCRIPT = join(import.meta.dirname, "check-bundle-size.mjs");

let dir: string;

function write(rel: string, content: string) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Un chunk de `n` octeți greu de comprimat (dimensiunea gzip ≈ n). */
function chunk(seed: number, n: number): string {
  let x = seed;
  let s = "";
  while (s.length < n) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    s += x.toString(36);
  }
  return s.slice(0, n);
}

function manifest(key: string, entry: Record<string, string[]>): string {
  return (
    "globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n" +
    `globalThis.__RSC_MANIFEST[${JSON.stringify(key)}] = ${JSON.stringify({ moduleLoading: { prefix: "" }, entryJSFiles: entry })};\n`
  );
}

const gz = (s: string) => gzipSync(Buffer.from(s)).length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finet-bundle-"));
  write(
    "build-manifest.json",
    JSON.stringify({
      polyfillFiles: ["static/chunks/polyfill.js"],
      rootMainFiles: ["static/chunks/react.js", "static/chunks/runtime.js"],
    }),
  );
  write("static/chunks/polyfill.js", chunk(1, 30_000));
  write("static/chunks/react.js", chunk(2, 4_000));
  write("static/chunks/runtime.js", chunk(3, 1_000));
  write("static/chunks/layout.js", chunk(4, 2_000));
  write("static/chunks/app.js", chunk(5, 3_000));
  write("static/chunks/dash.js", chunk(6, 5_000));
  write("static/css/x.css", chunk(7, 9_000));
  write(
    "server/app/(app)/dashboard/page_client-reference-manifest.js",
    manifest("/(app)/dashboard/page", {
      "[project]/src/app/layout": ["static/chunks/layout.js"],
      "[project]/src/app/(app)/layout": ["static/chunks/layout.js", "static/chunks/app.js"],
      "[project]/src/app/(app)/dashboard/page": ["/_next/static/chunks/dash.js"],
    }),
  );
  write(
    "server/app/login/page_client-reference-manifest.js",
    manifest("/login/page", { "[project]/src/app/layout": ["static/chunks/layout.js"] }),
  );
  write(
    "server/app/_not-found/page_client-reference-manifest.js",
    manifest("/_not-found/page", { "[project]/src/app/not-found": ["static/chunks/app.js"] }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-bundle-size", () => {
  it("numele rutelor: fără grupuri și fără `/page`", () => {
    expect(routeOf("/(app)/transactions/[id]/page")).toBe("/transactions/[id]");
    expect(routeOf("/login/page")).toBe("/login");
    expect(routeOf("/page")).toBe("/");
  });

  it("citește manifestul RSC ca JSON, fără a-l executa", () => {
    const parsed = parseClientReferenceManifest(manifest("/a/page", { x: ["static/chunks/a.js"] }));
    expect(parsed.key).toBe("/a/page");
    expect(parsed.manifest.entryJSFiles).toEqual({ x: ["static/chunks/a.js"] });
    expect(() => parseClientReferenceManifest("console.log(1)")).toThrow();
  });

  it("First Load JS = runtime + chunk-urile segmentelor, deduplicate, gzip, fără polyfill-uri", () => {
    const rows = measureRoutes(dir);
    expect(rows.map((r) => r.route)).toEqual(["/dashboard", "/login"]);
    const [dash, login] = rows;
    expect(dash!.files).toEqual([
      "static/chunks/app.js",
      "static/chunks/dash.js",
      "static/chunks/layout.js",
      "static/chunks/react.js",
      "static/chunks/runtime.js",
    ]);
    const size = (...names: number[]) =>
      names.reduce(
        (s, n) => s + gz(chunk(n, [0, 30_000, 4_000, 1_000, 2_000, 3_000, 5_000][n]!)),
        0,
      );
    expect(dash!.gzipBytes).toBe(size(2, 3, 4, 5, 6));
    expect(login!.gzipBytes).toBe(size(2, 3, 4));
  });

  it("`rootMainFilesTree` are prioritate față de `rootMainFiles`", () => {
    write(
      "build-manifest.json",
      JSON.stringify({
        rootMainFiles: ["static/chunks/react.js"],
        rootMainFilesTree: { "/login/page": ["static/chunks/runtime.js"] },
      }),
    );
    const login = measureRoutes(dir).find((r) => r.route === "/login")!;
    expect(login.files).toEqual(["static/chunks/layout.js", "static/chunks/runtime.js"]);
  });

  it("pragurile: exact, prefix, implicit", () => {
    const budget = parseBudget(
      'text\n```json bundle-budget\n{ "defaultKiB": 250, "routes": { "/login": 150, "/accounts": 200 } }\n```\n',
    );
    expect(limitFor(budget, "/login")).toBe(150);
    expect(limitFor(budget, "/accounts/[id]")).toBe(200);
    expect(limitFor(budget, "/dashboard")).toBe(250);
    expect(() => parseBudget("fără bloc")).toThrow(/bundle-budget/);
    expect(() => parseBudget("```json bundle-budget\n{}\n```")).toThrow(/defaultKiB/);
    const [row] = evaluate(
      [{ route: "/login", key: "/login/page", files: [], gzipBytes: 2048 }],
      budget,
    );
    expect(row).toMatchObject({ kib: 2, limitKiB: 150, ok: true });
  });

  it("CLI: 0 în buget, 1 peste prag, 2 fără build", () => {
    const run = (budgetKiB: number, nextDir = dir) => {
      write("budget.md", `\`\`\`json bundle-budget\n{ "defaultKiB": ${budgetKiB} }\n\`\`\`\n`);
      return spawnSync(
        process.execPath,
        [
          SCRIPT,
          "--next-dir",
          nextDir,
          "--budget",
          join(dir, "budget.md"),
          "--json",
          join(dir, "out.json"),
        ],
        { encoding: "utf8" },
      );
    };
    const ok = run(1000);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("/dashboard");
    const over = run(1);
    expect(over.status).toBe(1);
    expect(over.stdout).toContain("DEPĂȘIT");
    expect(run(1000, join(dir, "lipsa")).status).toBe(2);
  });
});
