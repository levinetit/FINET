import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SW_SOURCE } from "./sw-source";

let cached: string | null = null;

/**
 * Versiunea service worker-ului (ADR 0020): `BUILD_ID`-ul build-ului Next (`.next/BUILD_ID`,
 * prezent și în ieșirea `standalone`), deci se schimbă la fiecare deploy → browserul vede un
 * `/sw.js` diferit, versiunea nouă se instalează și așteaptă confirmarea din banner. În
 * dezvoltare: `dev`. Dacă fișierul lipsește (neașteptat), o amprentă stabilă a codului SW: totul
 * funcționează, doar fără detectarea fiecărui deploy.
 */
export function serviceWorkerVersion(): string {
  if (process.env.NODE_ENV === "development") return "dev";
  if (cached) return cached;
  let id = "";
  try {
    id = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    id = "";
  }
  cached = /^[A-Za-z0-9_-]{1,64}$/.test(id)
    ? id
    : `src-${createHash("sha256").update(SW_SOURCE).digest("hex").slice(0, 16)}`;
  return cached;
}
