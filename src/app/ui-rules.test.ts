import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Reguli statice pentru interfață (F2-C):
 * - fără atribute `style=` în markup: CSP-ul de producție (`style-src 'self' 'nonce-…'`) le-ar
 *   bloca, iar în dezvoltare (`'unsafe-inline'`) nu s-ar vedea;
 * - banii în UI doar prin `src/lib/money.ts`: fără `parseFloat`, `toFixed`, înmulțiri/împărțiri
 *   cu 100 sau `Number(...)` pe sume.
 */

const ROOT = join(import.meta.dirname, "..");
const DIRS = [join(ROOT, "app"), join(ROOT, "components")];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "api") continue; // rutele API nu au markup
      files(path, out);
    } else if (/\.(tsx|ts)$/.test(name) && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

const all = DIRS.flatMap((d) => files(d));

describe("regulile interfeței", () => {
  it("găsește fișierele UI", () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it("niciun atribut `style=` în componente", () => {
    const offenders = all
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /\bstyle\s*=\s*[{"']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("fără aritmetică float pe sume în UI", () => {
    const pattern = /parseFloat|toFixed\(|\*\s*100\b|\/\s*100\b|Number\(\s*[a-zA-Z_.]*amount/i;
    const offenders = all
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
