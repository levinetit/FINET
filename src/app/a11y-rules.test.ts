import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { ro } from "@/messages/ro";

/**
 * Reguli statice de accesibilitate (Faza 4), verificabile fără browser:
 * - `lang="ro"` pe `<html>` (layout-ul rădăcină și `global-error`);
 * - legătura „Sari la conținut” spre `<main id="continut">` în layout-ul autentificat;
 * - fiecare pagină are un titlu propriu (`metadata.title` din `ro.ts`), iar titlurile sunt unice.
 * E2E (`e2e/regressions.spec.ts`) verifică aceleași lucruri în pagina randată.
 */

const APP = import.meta.dirname;
const read = (p: string) => readFileSync(join(APP, p), "utf8");

function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "api") continue;
      pages(path, out);
    } else if (name === "page.tsx") {
      out.push(path);
    }
  }
  return out;
}

/** `ro.a.b` → valoarea din mesaje (doar șiruri). */
function resolve(path: string): unknown {
  return path
    .split(".")
    .slice(1)
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], ro);
}

describe("accesibilitate (reguli statice)", () => {
  it('lang="ro" pe <html>', () => {
    expect(read("layout.tsx")).toMatch(/<html\s[^>]*lang="ro"/);
    expect(read("global-error.tsx")).toMatch(/<html\s[^>]*lang="ro"/);
  });

  it("„Sari la conținut” duce la main#continut", () => {
    const layout = read("(app)/layout.tsx");
    expect(layout).toContain('href="#continut"');
    expect(layout).toMatch(/<main[\s\S]*id="continut"[\s\S]*tabIndex=\{-1\}/);
    expect(layout.indexOf('href="#continut"')).toBeLessThan(layout.indexOf("<AppNav"));
  });

  it("fiecare pagină are un titlu propriu, unic", () => {
    const titles = new Map<string, string>();
    const missing: string[] = [];
    for (const file of pages(APP)) {
      const rel = relative(APP, file);
      // `/` doar redirecționează (`src/app/page.tsx`).
      if (rel === "page.tsx") continue;
      const m = /\btitle:\s*(ro(?:\.\w+)+)/.exec(readFileSync(file, "utf8"));
      const value = m ? resolve(m[1]!) : undefined;
      if (typeof value !== "string" || value.trim() === "") {
        missing.push(rel);
        continue;
      }
      titles.set(rel, value);
    }
    expect(missing).toEqual([]);
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [rel, title] of titles) {
      const other = seen.get(title);
      if (other) duplicates.push(`${other} = ${rel} („${title}”)`);
      seen.set(title, rel);
    }
    expect(duplicates).toEqual([]);
    expect(titles.size).toBeGreaterThan(15);
  });
});
