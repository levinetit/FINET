import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Contrastul tokenilor de culoare (Faza 4, accesibilitate de bază): WCAG 2.2 AA în AMBELE teme,
 * calculat direct din `globals.css` (fără browser). Text normal ≥ 4,5:1; elemente grafice
 * (barele graficelor, marginile) ≥ 3:1 (criteriul 1.4.11).
 */

const css = readFileSync(join(import.meta.dirname, "globals.css"), "utf8");

function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`lipsește ${selector}`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// [text, fundal]: perechile folosite în componente (`text-*` pe `bg-*`).
const TEXT_PAIRS = [
  ["fg", "bg"],
  ["fg", "surface"],
  ["fg", "surface-2"],
  ["fg", "accent-soft"],
  ["fg", "ok-soft"],
  ["fg", "warn-soft"],
  ["fg", "bad-soft"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["muted", "surface-2"],
  ["muted", "accent-soft"],
  ["accent", "bg"],
  ["accent", "surface"],
  ["accent", "accent-soft"],
  ["accent-fg", "accent"],
  ["ok", "surface"],
  ["ok", "bg"],
  ["bad", "surface"],
  ["bad", "bg"],
  ["surface", "bad"],
  ["marker-fg", "marker"],
] as const;

// [element grafic, fundal]: `fill-ok|warn|bad`, `border-*`.
const GRAPHIC_PAIRS = [
  ["ok", "surface"],
  ["warn", "surface"],
  ["bad", "surface"],
  ["warn", "bg"],
  ["accent", "surface"],
] as const;

const THEMES = {
  luminoasă: tokens(":root {"),
  întunecată: tokens(':root[data-theme="dark"] {'),
  "întunecată (sistem)": tokens(':root:not([data-theme="light"]) {'),
};

describe("contrastul tokenilor (WCAG AA)", () => {
  for (const [theme, t] of Object.entries(THEMES)) {
    it(`tema ${theme}: text ≥ 4,5:1`, () => {
      const low = TEXT_PAIRS.map(([fg, bg]) => [`${fg}/${bg}`, ratio(t[fg]!, t[bg]!)] as const)
        .filter(([, r]) => !(r >= 4.5))
        .map(([pair, r]) => `${pair} ${r.toFixed(2)}`);
      expect(low).toEqual([]);
    });

    it(`tema ${theme}: elemente grafice ≥ 3:1`, () => {
      const low = GRAPHIC_PAIRS.map(([fg, bg]) => [`${fg}/${bg}`, ratio(t[fg]!, t[bg]!)] as const)
        .filter(([, r]) => !(r >= 3))
        .map(([pair, r]) => `${pair} ${r.toFixed(2)}`);
      expect(low).toEqual([]);
    });
  }

  it("tema întunecată forțată = tema întunecată a sistemului", () => {
    expect(THEMES.întunecată).toEqual(THEMES["întunecată (sistem)"]);
  });
});
