import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { buildOpenApiDocument, renderOpenApi } from "./document";
import { OPERATIONS } from "./registry";

/**
 * Registrul OpenAPI ↔ rutele reale: fiecare `route.ts` din `src/app/api/v1/**` (metodele
 * exportate) apare în registru și invers (nicio rută documentată inexistentă). Metodele se
 * citesc din text (regex), fără a importa rutele.
 */

const V1 = join(process.cwd(), "src", "app", "api", "v1");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

function realRoutes(): string[] {
  const found: string[] = [];
  for (const file of routeFiles(V1)) {
    const rel = relative(V1, file).split(sep).slice(0, -1);
    if (rel.some((s) => s.startsWith("_"))) continue;
    const path = ["/api/v1", ...rel.map((s) => s.replace(/^\[(\w+)\]$/, "{$1}"))].join("/");
    const text = readFileSync(file, "utf8");
    for (const m of METHODS) {
      if (
        new RegExp(
          `export\\s+(?:const\\s+${m}\\b|async\\s+function\\s+${m}\\b|function\\s+${m}\\b)`,
        ).test(text)
      ) {
        found.push(`${m} ${path}`);
      }
    }
  }
  return found.sort();
}

describe("OpenAPI", () => {
  it("fiecare rută reală e documentată și nicio rută documentată nu lipsește din cod", () => {
    const documented = OPERATIONS.map((o) => `${o.method} ${o.path}`).sort();
    const real = realRoutes();
    expect(real.length).toBeGreaterThan(30);
    expect(documented).toEqual(real);
  });

  it("operationId unic; 3.1; securitate cookie + bearer; antetele Idempotency-Key și X-FINET-Client", () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const doc = buildOpenApiDocument() as {
      openapi: string;
      security: unknown[];
      paths: Record<string, Record<string, { parameters: { $ref?: string }[] }>>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.security).toEqual([{ cookieSession: [] }, { bearerSession: [] }]);
    const post = doc.paths["/api/v1/transactions"]!.post!;
    const refs = post.parameters.map((p) => p.$ref);
    expect(refs).toContain("#/components/parameters/IdempotencyKey");
    expect(refs).toContain("#/components/parameters/FinetClient");
    for (const op of OPERATIONS.filter((o) => o.idempotent)) {
      expect(op.method).toBe("POST");
    }
  });

  it("generarea e deterministă și fără sume zecimale în scheme (`amountMinor` întreg)", () => {
    const a = renderOpenApi();
    expect(renderOpenApi()).toBe(a);
    const doc = JSON.parse(a) as unknown;
    const bad: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (/Minor$/.test(k) && v && typeof v === "object" && "type" in v && v.type !== "integer") {
          bad.push(`${path}.${k}`);
        }
        walk(v, `${path}.${k}`);
      }
    };
    walk(doc, "");
    expect(bad).toEqual([]);
  });

  it("docs/openapi.json e la zi (altfel: pnpm openapi:generate)", () => {
    const current = readFileSync(join(process.cwd(), "docs", "openapi.json"), "utf8");
    expect(current === renderOpenApi()).toBe(true);
  });
});
