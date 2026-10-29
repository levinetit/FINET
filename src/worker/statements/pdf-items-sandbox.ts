import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cleanItems } from "@/modules/statements/text";
import type { TextItem } from "@/modules/statements/types";

/**
 * Extracția elementelor de text poziționale dintr-un extras PDF, într-un PROCES COPIL limitat de
 * sistemul de operare (ADR 0018; același model ca citirea bonurilor PDF din Faza 6, ADR 0013):
 * `prlimit --as` (spațiu de adrese), `--cpu`, `--fsize=0` (copilul nu scrie fișiere), `--nofile`,
 * `--core=0`, SIGKILL la termen, mediu minim, fără stderr. Ieșirea copilului (o linie JSON) e
 * plafonată la `maxOutputBytes` și validată element cu element; textul e curățat din nou
 * (control/NUL/bidi). `prlimit` lipsă → refuz (`pdf_sandbox_unavailable`), nu citire fără limite.
 *
 * Rulează DOAR în worker (imaginea `tools`, unde `scripts/build-tools.mjs` copiază
 * `pdf-items-child.mjs` lângă `worker.mjs`); imaginea web nu conține copilul.
 */

export type StatementPdfErrorCode =
  | "pdf_invalid"
  | "pdf_encrypted"
  | "pdf_no_text"
  | "too_many_pages"
  | "pdf_too_complex"
  | "pdf_sandbox_unavailable"
  | "extract_timeout";

export class StatementPdfError extends Error {
  constructor(readonly code: StatementPdfErrorCode) {
    super("Extrasul PDF nu a putut fi citit.");
    this.name = "StatementPdfError";
  }
}

/** Plafoanele (decizia mea, ADR 0018). */
export const STATEMENT_PDF_LIMITS = Object.freeze({
  // Node 24 + unpdf rezervă ~1,5 GB de adrese virtuale la pornire (măsurat în Faza 6 cu sharp
  // inclus: 1600 MB); 1800 MB lasă loc pentru pdf.js.
  addressSpaceBytes: 1800 * 1000 * 1000,
  cpuSeconds: 30,
  maxOldSpaceMb: 96,
  maxPages: 60,
  maxItemsPerPage: 5000,
  maxItems: 100_000,
  maxItemChars: 500,
  maxOutputBytes: 16 * 1024 * 1024,
  /** Dimensiunea maximă a fișierului primit (verificată înainte de copil). */
  maxInputBytes: 20 * 1024 * 1024,
});

const KNOWN = new Set<string>([
  "pdf_invalid",
  "pdf_encrypted",
  "pdf_no_text",
  "too_many_pages",
  "pdf_too_complex",
]);

const PRLIMIT_CANDIDATES = ["/usr/bin/prlimit", "/bin/prlimit"];

function defaultChildScript(): string {
  return fileURLToPath(new URL("./pdf-items-child.mjs", import.meta.url));
}

let active = 0;
/** Câte procese copil rulează acum (teste: după timeout/eroare trebuie să fie 0). */
export function activeStatementPdfChildren(): number {
  return active;
}

export type StatementPdfOptions = Readonly<{
  /** Termenul (ms Unix): la el copilul primește SIGKILL. */
  deadline: number;
  maxPages?: number;
  /** Doar teste: alt script copil. */
  childScript?: string;
}>;

function validItems(raw: unknown): TextItem[] | null {
  if (!Array.isArray(raw) || raw.length > STATEMENT_PDF_LIMITS.maxItems) return null;
  const out: TextItem[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 5) return null;
    const [p, x, y, w, s] = r as unknown[];
    if (!Number.isSafeInteger(p) || (p as number) < 1 || (p as number) > 1000) return null;
    if (![x, y, w].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if (typeof s !== "string" || s.length > STATEMENT_PDF_LIMITS.maxItemChars) return null;
    out.push({ p: p as number, x: x as number, y: y as number, w: w as number, s });
  }
  return out;
}

/** PDF → elemente poziționale curățate, în procesul copil limitat. */
export function extractStatementPdfItems(
  input: Uint8Array,
  options: StatementPdfOptions,
): Promise<TextItem[]> {
  const L = STATEMENT_PDF_LIMITS;
  if (input.byteLength > L.maxInputBytes) {
    return Promise.reject(new StatementPdfError("pdf_too_complex"));
  }
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new StatementPdfError("extract_timeout"));
  const script = options.childScript ?? defaultChildScript();
  const prlimit = PRLIMIT_CANDIDATES.find((p) => existsSync(p));
  if (!prlimit || !existsSync(script)) {
    return Promise.reject(new StatementPdfError("pdf_sandbox_unavailable"));
  }
  const cpu = Math.max(1, Math.min(L.cpuSeconds, Math.ceil(remaining / 1000)));
  const maxPages = Math.min(options.maxPages ?? L.maxPages, L.maxPages);

  return new Promise<TextItem[]>((resolve, reject) => {
    const child = spawn(
      prlimit,
      [
        `--as=${L.addressSpaceBytes}`,
        `--cpu=${cpu}`,
        "--fsize=0",
        "--nofile=64",
        "--core=0",
        "--",
        process.execPath,
        `--max-old-space-size=${L.maxOldSpaceMb}`,
        script,
        String(maxPages),
        String(L.maxItemsPerPage),
        String(L.maxItems),
        String(L.maxItemChars),
      ],
      { stdio: ["pipe", "pipe", "ignore"], env: { NODE_ENV: "production" }, windowsHide: true },
    );
    active++;
    const parts: Buffer[] = [];
    let length = 0;
    let failure: StatementPdfError | null = null;
    const kill = (code: StatementPdfErrorCode) => {
      failure ??= new StatementPdfError(code);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("extract_timeout"), remaining);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      length += chunk.length;
      if (length > L.maxOutputBytes) return kill("pdf_too_complex");
      parts.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    child.on("error", () => {
      failure ??= new StatementPdfError("pdf_sandbox_unavailable");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      active--;
      if (failure) return reject(failure);
      const text = Buffer.concat(parts).toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0 || newline !== text.length - 1) {
        return reject(new StatementPdfError(code === 0 ? "pdf_invalid" : "pdf_too_complex"));
      }
      let header: { error?: unknown; pages?: unknown; items?: unknown };
      try {
        header = JSON.parse(text.slice(0, newline)) as typeof header;
      } catch {
        return reject(new StatementPdfError("pdf_invalid"));
      }
      if (header.error !== undefined) {
        const e = String(header.error);
        return reject(
          new StatementPdfError(KNOWN.has(e) ? (e as StatementPdfErrorCode) : "pdf_invalid"),
        );
      }
      if (code !== 0) return reject(new StatementPdfError("pdf_too_complex"));
      const items = validItems(header.items);
      if (!items) return reject(new StatementPdfError("pdf_too_complex"));
      // Apărare în adâncime: textul copilului e neîncrezător.
      resolve(cleanItems(items));
    });
  });
}
