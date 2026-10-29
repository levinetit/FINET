import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Citirea PDF-ului (pdf.js prin unpdf) într-un PROCES COPIL limitat de sistemul de operare
 * (revizuirile de securitate F6-A; ADR 0013). Acesta e controlul real contra PDF-urilor ostile
 * (bombe de decompresie, structuri patologice), nu inventarul pe octeți (`pdf-scan.ts`, doar
 * „fail-fast”): limitele V8 (`resourceLimits` ale unui fir) nu acoperă memoria din afara
 * heap-ului (ArrayBuffer, nativ), deci decodarea rulează într-un proces separat:
 *
 * - `prlimit --as` (spațiul de adrese): o alocare peste plafon eșuează în copil, nu în worker;
 * - `prlimit --cpu` (secunde CPU, SIGXCPU/SIGKILL de la nucleu) și SIGKILL de la părinte la
 *   termenul de timp real; părintele așteaptă ieșirea copilului înainte de a întoarce eroarea
 *   (nimic nu rămâne în fundal);
 * - `prlimit --fsize=0` (copilul nu poate scrie fișiere), `--nofile`, `--nproc`;
 * - `--max-old-space-size` mic, mediu gol (fără URL-uri sau căi de secrete), fără stderr;
 * - ieșirea (stdout) plafonată: peste plafon copilul e ucis.
 * Plasa de siguranță rămâne cgroup-ul containerului `finet-worker` (384 MB).
 *
 * `prlimit` (util-linux) există în imaginea `tools` (node:24 bookworm-slim, verificat:
 * util-linux 2.38.1). Dacă lipsește, PDF-urile sunt REFUZATE (`pdf_sandbox_unavailable`):
 * fail-closed, nu se citesc fără limite.
 */

export type PdfChildResult = Readonly<{
  pages: number;
  text: readonly string[];
  images: ReadonlyArray<
    Readonly<{ width: number; height: number; channels: 1 | 3 | 4; data: Buffer }>
  > | null;
}>;

export type PdfChildErrorCode =
  | "pdf_invalid"
  | "pdf_encrypted"
  | "too_many_pages"
  | "pdf_too_complex"
  | "pdf_sandbox_unavailable"
  | "preprocess_timeout";

export class PdfChildError extends Error {
  constructor(readonly code: PdfChildErrorCode) {
    super("PDF-ul nu a putut fi citit.");
    this.name = "PdfChildError";
  }
}

/** Limitele copilului (decizia mea, ADR 0013; pragurile măsurate în node:24). */
export const PDF_CHILD_LIMITS = Object.freeze({
  // Node 24 rezervă ~1,2 GB de adrese virtuale la pornire (măsurat: pornește la 1300 MB, nu la
  // 1100 MB); 1500 MB lasă ~200–300 MB pentru heap, pdf.js și pixelii decodați.
  addressSpaceBytes: 1500 * 1000 * 1000,
  cpuSeconds: 30,
  maxOldSpaceMb: 64,
  maxImagesPerPage: 16,
  /** Antetul JSON al răspunsului (textul paginilor). */
  maxHeaderBytes: 2 * 1024 * 1024,
});

const KNOWN = new Set<string>([
  "pdf_invalid",
  "pdf_encrypted",
  "too_many_pages",
  "pdf_too_complex",
]);

/** Calea scriptului copil: lângă acest modul (sursă) sau lângă `dist/tools/worker.mjs`. */
function childScript(): string {
  const path = fileURLToPath(new URL("./pdf-child.mjs", import.meta.url));
  if (!existsSync(path)) throw new PdfChildError("pdf_sandbox_unavailable");
  return path;
}

const PRLIMIT_CANDIDATES = ["/usr/bin/prlimit", "/bin/prlimit"];
function prlimitPath(): string {
  const found = PRLIMIT_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new PdfChildError("pdf_sandbox_unavailable");
  return found;
}

let active = 0;
let spawned = 0;

/** Câte procese copil rulează acum (teste: după timeout/eroare trebuie să fie 0). */
export function activePdfChildren(): number {
  return active;
}

/** Câte procese copil au fost pornite (teste). */
export function spawnedPdfChildren(): number {
  return spawned;
}

export type PdfChildOptions = Readonly<{
  maxPages: number;
  minTextChars: number;
  /** Termenul (ms Unix): la el copilul primește SIGKILL. */
  deadline: number;
  /** Plafonul pixelilor întorși (toate imaginile; × 4 octeți). */
  maxOutputPixels: number;
  /** Doar teste: alt plafon al spațiului de adrese. */
  addressSpaceBytes?: number;
}>;

/** Citește PDF-ul în procesul copil limitat. */
export function readPdfInChild(
  input: Uint8Array,
  options: PdfChildOptions,
): Promise<PdfChildResult> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new PdfChildError("preprocess_timeout"));
  let script: string;
  let prlimit: string;
  try {
    script = childScript();
    prlimit = prlimitPath();
  } catch (error) {
    return Promise.reject(error);
  }
  const L = PDF_CHILD_LIMITS;
  const maxOutput = L.maxHeaderBytes + options.maxOutputPixels * 4;
  const cpu = Math.max(1, Math.min(L.cpuSeconds, Math.ceil(remaining / 1000)));

  return new Promise<PdfChildResult>((resolve, reject) => {
    const child = spawn(
      prlimit,
      [
        `--as=${options.addressSpaceBytes ?? L.addressSpaceBytes}`,
        `--cpu=${cpu}`,
        "--fsize=0",
        "--nofile=64",
        "--core=0",
        "--",
        process.execPath,
        `--max-old-space-size=${L.maxOldSpaceMb}`,
        script,
        String(options.maxPages),
        String(options.minTextChars),
        String(L.maxImagesPerPage),
      ],
      { stdio: ["pipe", "pipe", "ignore"], env: {}, windowsHide: true },
    );
    active++;
    spawned++;
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: PdfChildError | null = null;
    const kill = (code: PdfChildErrorCode) => {
      failure ??= new PdfChildError(code);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("preprocess_timeout"), remaining);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutput) kill("pdf_too_complex");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {}); // copilul ucis înainte să citească tot
    child.stdin.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));

    child.on("error", () => {
      failure ??= new PdfChildError("pdf_sandbox_unavailable");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      active--;
      if (failure) return reject(failure);
      try {
        resolve(parseOutput(Buffer.concat(chunks), code, options.maxOutputPixels * 4));
      } catch (error) {
        reject(error instanceof PdfChildError ? error : new PdfChildError("pdf_invalid"));
      }
    });
  });
}

type Header = {
  error?: string;
  pages?: number;
  text?: string[];
  images?: { width: number; height: number; channels: number; length: number }[] | null;
};

function parseOutput(out: Buffer, exitCode: number | null, maxDataBytes: number): PdfChildResult {
  const newline = out.indexOf(0x0a);
  // Fără antet complet: copilul a murit (memorie, CPU) → prea complex.
  if (newline < 0) throw new PdfChildError(exitCode === 0 ? "pdf_invalid" : "pdf_too_complex");
  if (newline > PDF_CHILD_LIMITS.maxHeaderBytes) throw new PdfChildError("pdf_too_complex");
  // Pixelii întorși, separat de antet: peste plafon → prea complex.
  if (out.length - newline - 1 > maxDataBytes) throw new PdfChildError("pdf_too_complex");
  const header = JSON.parse(out.subarray(0, newline).toString("utf8")) as Header;
  if (header.error) {
    throw new PdfChildError(
      KNOWN.has(header.error) ? (header.error as PdfChildErrorCode) : "pdf_invalid",
    );
  }
  if (exitCode !== 0) throw new PdfChildError("pdf_too_complex");
  const pages = header.pages;
  const text = header.text;
  if (
    !Number.isSafeInteger(pages) ||
    !Array.isArray(text) ||
    !text.every((t) => typeof t === "string")
  ) {
    throw new PdfChildError("pdf_invalid");
  }
  if (header.images === null || header.images === undefined) {
    return { pages: pages!, text, images: null };
  }
  let offset = newline + 1;
  const images = header.images.map((i) => {
    const valid =
      Number.isSafeInteger(i.width) &&
      Number.isSafeInteger(i.height) &&
      i.width > 0 &&
      i.height > 0 &&
      (i.channels === 1 || i.channels === 3 || i.channels === 4) &&
      i.length === i.width * i.height * i.channels &&
      offset + i.length <= out.length;
    if (!valid) throw new PdfChildError("pdf_invalid");
    const data = out.subarray(offset, offset + i.length);
    offset += i.length;
    return { width: i.width, height: i.height, channels: i.channels as 1 | 3 | 4, data };
  });
  if (offset !== out.length) throw new PdfChildError("pdf_invalid");
  return { pages: pages!, text, images };
}
