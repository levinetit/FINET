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
 * - `prlimit --cpu` (secunde CPU) și SIGKILL de la părinte la termenul de timp real; părintele
 *   așteaptă ieșirea copilului înainte de a întoarce eroarea (nimic nu rămâne în fundal);
 * - `prlimit --fsize=0` (copilul nu poate scrie fișiere), `--nofile`, `--core=0`;
 * - `--max-old-space-size` mic, mediu minim (fără URL-uri sau căi de secrete), fără stderr.
 *
 * MEMORIA PĂRINTELUI (revizuirea de securitate): copilul trimite imaginile deja redimensionate
 * (≤ 2048 px) și comprimate JPEG, niciodată raster brut. Părintele citește întâi antetul
 * (≤ `maxHeaderBytes`), verifică lungimile declarate față de un buget FIX mic
 * (`maxImageBytes` pe imagine, `maxTotalBytes` în total, ≤ 32 MB) și abia apoi alocă O SINGURĂ
 * dată bufferul de mărimea declarată, în care copiază corpul; orice octet în plus sau o
 * lungime peste buget → SIGKILL și `pdf_too_complex`.
 *
 * `prlimit` (util-linux) există în imaginea `tools` (node:24 bookworm-slim, verificat:
 * util-linux 2.38.1). Dacă lipsește, PDF-urile sunt REFUZATE (`pdf_sandbox_unavailable`):
 * fail-closed, nu se citesc fără limite.
 */

export type PdfChildResult = Readonly<{
  pages: number;
  text: readonly string[];
  /** Imaginile paginilor scanate, ca JPEG (≤ 2048 px), sau `null` pentru PDF cu text. */
  images: ReadonlyArray<Readonly<{ width: number; height: number; jpeg: Buffer }>> | null;
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

/** Limitele copilului și bugetul ieșirii (decizia mea, ADR 0013; pragurile măsurate în node:24). */
export const PDF_CHILD_LIMITS = Object.freeze({
  // Node 24 + unpdf + sharp rezervă ~1,6 GB de adrese virtuale la pornire (măsurat: sharp nu se
  // încarcă la 1500 MB, se încarcă la 1600 MB); 1800 MB lasă ~200 MB pentru pdf.js și pixeli.
  addressSpaceBytes: 1800 * 1000 * 1000,
  cpuSeconds: 30,
  maxOldSpaceMb: 64,
  maxImagesPerPage: 16,
  /** Latura lungă maximă a imaginii trimise de copil. */
  maxSidePx: 2048,
  /** Antetul JSON (textul paginilor). */
  maxHeaderBytes: 1024 * 1024,
  /** Un JPEG de 2048 px are de obicei 0,3–2 MB. */
  maxImageBytes: 8 * 1024 * 1024,
  /** Bugetul total al corpului (toate imaginile). */
  maxTotalBytes: 32 * 1024 * 1024,
});

const KNOWN = new Set<string>([
  "pdf_invalid",
  "pdf_encrypted",
  "too_many_pages",
  "pdf_too_complex",
]);

/** Calea scriptului copil: lângă acest modul (sursă) sau lângă `dist/tools/worker.mjs`. */
function defaultChildScript(): string {
  return fileURLToPath(new URL("./pdf-child.mjs", import.meta.url));
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
  /** Pixeli maximi ai unei imagini extrase (verificați și în copil, înainte de sharp). */
  maxImagePixels: number;
  /** Pixeli decodați maximi însumați pe document (în copil, independent de inventar). */
  maxTotalPixels?: number;
  /** Termenul (ms Unix): la el copilul primește SIGKILL. */
  deadline: number;
  /** Doar teste: alt script copil (de exemplu unul ostil). */
  childScript?: string;
}>;

type ImageHeader = { width: number; height: number; length: number };
type Header = {
  error?: string;
  pages?: number;
  text?: unknown;
  images?: ImageHeader[] | null;
};

/** Antetul validat; `null` dacă nu respectă forma sau bugetul. */
function validHeader(header: Header): Header | null {
  if (header.error !== undefined) return typeof header.error === "string" ? header : null;
  const { pages, text, images } = header;
  if (!Number.isSafeInteger(pages) || (pages as number) < 1) return null;
  if (!Array.isArray(text) || !text.every((t) => typeof t === "string")) return null;
  if (images === null || images === undefined) return header;
  if (!Array.isArray(images)) return null;
  const L = PDF_CHILD_LIMITS;
  let total = 0;
  for (const i of images) {
    const ok =
      Number.isSafeInteger(i?.width) &&
      Number.isSafeInteger(i?.height) &&
      Number.isSafeInteger(i?.length) &&
      i.width >= 1 &&
      i.height >= 1 &&
      i.width <= L.maxSidePx &&
      i.height <= L.maxSidePx &&
      i.length >= 1 &&
      i.length <= L.maxImageBytes;
    if (!ok) return null;
    total += i.length;
  }
  return total <= L.maxTotalBytes ? header : null;
}

/** Citește PDF-ul în procesul copil limitat. */
export function readPdfInChild(
  input: Uint8Array,
  options: PdfChildOptions,
): Promise<PdfChildResult> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new PdfChildError("preprocess_timeout"));
  const script = options.childScript ?? defaultChildScript();
  let prlimit: string;
  try {
    if (!existsSync(script)) throw new PdfChildError("pdf_sandbox_unavailable");
    prlimit = prlimitPath();
  } catch (error) {
    return Promise.reject(error);
  }
  const L = PDF_CHILD_LIMITS;
  const cpu = Math.max(1, Math.min(L.cpuSeconds, Math.ceil(remaining / 1000)));

  return new Promise<PdfChildResult>((resolve, reject) => {
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
        String(options.maxPages),
        String(options.minTextChars),
        String(L.maxImagesPerPage),
        String(options.maxImagePixels),
        String(L.maxSidePx),
        String(L.maxImageBytes),
        String(L.maxTotalBytes),
        String(options.maxTotalPixels ?? 2 * options.maxImagePixels),
      ],
      // Mediu minim: un singur fir libuv (sharp/libvips), nimic din mediul workerului.
      {
        stdio: ["pipe", "pipe", "ignore"],
        env: { NODE_ENV: "production", UV_THREADPOOL_SIZE: "1" },
        windowsHide: true,
      },
    );
    active++;
    spawned++;

    // Antetul: bucăți mici până la primul `\n` (plafonat). Corpul: UN buffer, alocat după
    // validarea antetului, de mărimea declarată.
    const headParts: Buffer[] = [];
    let headLength = 0;
    let header: Header | null = null;
    let body: Buffer | null = null;
    let filled = 0;
    let failure: PdfChildError | null = null;
    const kill = (code: PdfChildErrorCode) => {
      failure ??= new PdfChildError(code);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("preprocess_timeout"), remaining);

    const onBody = (chunk: Buffer) => {
      if (!body || filled + chunk.length > body.length) return kill("pdf_too_complex");
      chunk.copy(body, filled);
      filled += chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (header) return onBody(chunk);
      const newline = chunk.indexOf(0x0a);
      const take = newline < 0 ? chunk.length : newline;
      headLength += take;
      if (headLength > L.maxHeaderBytes) return kill("pdf_too_complex");
      headParts.push(chunk.subarray(0, take));
      if (newline < 0) return;
      let parsed: Header;
      try {
        parsed = JSON.parse(Buffer.concat(headParts).toString("utf8")) as Header;
      } catch {
        return kill("pdf_invalid");
      }
      headParts.length = 0;
      const valid = validHeader(parsed);
      if (!valid) return kill("pdf_too_complex");
      header = valid;
      const total = (valid.images ?? []).reduce((sum, i) => sum + i.length, 0);
      body = Buffer.allocUnsafe(total);
      const rest = chunk.subarray(newline + 1);
      if (rest.length > 0) onBody(rest);
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
      // Fără antet complet: copilul a murit (memorie, CPU) → prea complex.
      if (!header) return reject(new PdfChildError(code === 0 ? "pdf_invalid" : "pdf_too_complex"));
      if (header.error) {
        return reject(
          new PdfChildError(
            KNOWN.has(header.error) ? (header.error as PdfChildErrorCode) : "pdf_invalid",
          ),
        );
      }
      if (code !== 0 || !body || filled !== body.length) {
        return reject(new PdfChildError("pdf_too_complex"));
      }
      const text = header.text as string[];
      if (!header.images) return resolve({ pages: header.pages!, text, images: null });
      let offset = 0;
      const images = header.images.map((i) => {
        const jpeg = body!.subarray(offset, offset + i.length);
        offset += i.length;
        return { width: i.width, height: i.height, jpeg };
      });
      resolve({ pages: header.pages!, text, images });
    });
  });
}
