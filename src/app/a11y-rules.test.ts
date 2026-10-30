import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { ro } from "@/messages/ro";

/**
 * Reguli statice de accesibilitate (Faza 4), verificabile fără browser:
 * - `lang` pe `<html>`: `global-error` are `lang="ro"` literal; layout-ul rădăcină îl ia din antetul
 *   intern pus de proxy, cu `ro` ca singură alternativă implicită (F11-C3: `en` doar pe paginile
 *   publice ale `saas`, cu cookie explicit; vezi `site-locale.test.ts`);
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
  it('lang pe <html>: ro implicit (layout dinamic doar spre "en" pe site-ul public), "ro" fix în global-error', () => {
    const layout = read("layout.tsx");
    expect(layout).toMatch(/<html\s[^>]*lang=\{lang\}/);
    // Singura valoare alternativă a lui `lang` e "ro": orice altceva decât "en" cade pe română.
    expect(layout).toMatch(/=== "en" \? "en" : "ro"/);
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
      const source = readFileSync(file, "utf8");
      // Titlul vine din `ro.ts`; paginile publice (F11-C3) îl iau din `t.<secțiune>.title`, cu `t` =
      // textele limbii alese: se verifică versiunea română (referința), iar `site-locale.test.ts`
      // verifică paritatea cu engleza.
      const m = /\btitle:\s*(ro(?:\.\w+)+)/.exec(source);
      const generated = /\btitle:\s*t\.(\w+)\.title/.exec(source);
      const value = m
        ? resolve(m[1]!)
        : generated
          ? resolve(`ro.site.${generated[1]}.title`)
          : undefined;
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

  it("ecranul bonului: confirmarea blocată e accesibilă, iar „Reprocesează” cere confirmare", () => {
    const review = read("(app)/receipts/[id]/receipt-review.tsx");
    // Butonul rămâne focalizabil: `aria-disabled` + explicația asociată prin `aria-describedby`.
    expect(review).toMatch(/aria-disabled=\{blocker !== null/);
    expect(review).toMatch(/aria-describedby=\{blocker !== null \? "confirm-blocked"/);
    expect(review).toContain('id="confirm-blocked"');
    expect(review).toContain('href="/accounts"');
    // Serverul rămâne sursa de adevăr, dar clicul pe un buton blocat nu trimite nimic.
    expect(review).toMatch(/if \(blocker !== null \|\| accountId === ""\) return;/);
    // „Reprocesează” trece prin ConfirmButton (nu direct pe onClick), în ecran și în listă.
    expect(review).toMatch(/<ConfirmButton[^>]*\n\s*label=\{t\.reprocess\}/);
    expect(review).not.toMatch(/onClick=\{\(\) => void reprocess\(\)\}/);
    const row = read("(app)/receipts/receipt-row-actions.tsx");
    expect(row).toMatch(/<ConfirmButton[^>]*\n\s*label=\{t\.reprocess\}/);
    expect(read("../components/ledger/confirm-button.tsx")).toMatch(/role="group"/);
  });

  // Regresia CI F9-B (axe `label-content-name-mismatch`, WCAG 2.5.3): un `aria-label` pe un buton
  // sau o legătură trebuie să conțină textul vizibil. Cazurile reparate nu mai au `aria-label`.
  it("butonul „Nu, mulțumesc” și logoul din navigare au numele din textul vizibil (fără aria-label)", () => {
    const pwa = readFileSync(join(APP, "../components/app/pwa-app.tsx"), "utf8");
    const dismiss = pwa.slice(pwa.indexOf("onClick={dismiss}"), pwa.indexOf("{ro.pwa.notNow}"));
    expect(dismiss).not.toContain("aria-label");
    const nav = readFileSync(join(APP, "../components/app/app-nav.tsx"), "utf8");
    expect(nav).not.toMatch(/<Link href="\/dashboard" aria-label=/);
  });
});
