import { Worker } from "node:worker_threads";

/**
 * Citirea PDF-ului (pdf.js prin unpdf) într-un FIR IZOLAT, oprit efectiv la timeout (revizuirea
 * de securitate F6-A, M1/M2): `Worker.terminate()` oprește execuția JavaScript a lui pdf.js
 * (un `Promise.race` doar ar fi abandonat munca, lăsând-o să consume CPU și memorie). Firul are
 * heap-ul plafonat (`resourceLimits`): un PDF care cere prea multă memorie JavaScript omoară
 * doar firul (`ERR_WORKER_OUT_OF_MEMORY` → `pdf_too_complex`), nu workerul.
 *
 * Codul firului e un șir JavaScript simplu (`eval: true`), fără TypeScript și fără importuri
 * relative, ca să meargă la fel în teste (Vitest) și în pachetul `dist/tools/worker.mjs`
 * (`unpdf` e dependență externă, rezolvată din `node_modules`). Firul primește o COPIE a
 * octeților și întoarce doar: numărul de pagini, textul pe pagini și (pentru PDF scanat)
 * pixelii bruți ai celei mai mari imagini de pe fiecare pagină (transferați, nu copiați).
 */

export type PdfWorkerResult = Readonly<{
  pages: number;
  text: readonly string[];
  images: ReadonlyArray<
    Readonly<{ width: number; height: number; channels: 1 | 3 | 4; data: Uint8Array }>
  > | null;
}>;

export type PdfWorkerErrorCode =
  "pdf_invalid" | "pdf_encrypted" | "too_many_pages" | "pdf_too_complex" | "preprocess_timeout";

export class PdfWorkerError extends Error {
  constructor(readonly code: PdfWorkerErrorCode) {
    super("PDF-ul nu a putut fi citit.");
    this.name = "PdfWorkerError";
  }
}

/** Plafoanele firului (decizia mea, ADR 0013): heap 96 MB, stivă implicită. */
export const PDF_WORKER_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 96,
  maxYoungGenerationSizeMb: 16,
  codeRangeSizeMb: 16,
});

const SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const send = (m, t) => parentPort.postMessage(m, t || []);
  let pdf;
  try {
    const { getDocumentProxy, extractText, extractImages } = await import("unpdf");
    try {
      pdf = await getDocumentProxy(workerData.input, {
        isEvalSupported: false,
        useSystemFonts: false,
        disableFontFace: true,
        stopAtErrors: true,
      });
    } catch (error) {
      send({ error: error && error.name === "PasswordException" ? "pdf_encrypted" : "pdf_invalid" });
      return;
    }
    const pages = pdf.numPages;
    if (!(pages >= 1)) return send({ error: "pdf_invalid" });
    if (pages > workerData.maxPages) return send({ error: "too_many_pages" });
    const text = (await extractText(pdf, { mergePages: false })).text.map((t) => t.trim());
    const significant = text.join("").replace(/[^\p{L}\p{N}]/gu, "").length;
    if (significant >= workerData.minTextChars) return send({ pages, text, images: null });
    const images = [];
    for (let page = 1; page <= pages; page++) {
      const found = await extractImages(pdf, page);
      found.sort((a, b) => b.width * b.height - a.width * a.height);
      const largest = found[0];
      if (!largest) continue;
      // Copie compactă (datele pdf.js pot fi o vedere într-un buffer mai mare).
      const data = new Uint8Array(largest.data.byteLength);
      data.set(largest.data);
      images.push({ width: largest.width, height: largest.height, channels: largest.channels, data });
    }
    send({ pages, text, images }, images.map((i) => i.data.buffer));
  } catch {
    send({ error: "pdf_invalid" });
  } finally {
    try { if (pdf && pdf.loadingTask) await pdf.loadingTask.destroy(); } catch {}
  }
})();
`;

let active = 0;
let spawned = 0;

/** Câte fire PDF rulează acum (pentru teste: după timeout trebuie să fie 0). */
export function activePdfWorkers(): number {
  return active;
}

/** Câte fire PDF au fost pornite de la începutul procesului (pentru teste). */
export function spawnedPdfWorkers(): number {
  return spawned;
}

const KNOWN = new Set<string>(["pdf_invalid", "pdf_encrypted", "too_many_pages"]);

/** Citește PDF-ul în firul izolat; la `deadline` (ms Unix) firul e oprit și se aruncă timeout. */
export function readPdfIsolated(
  input: Uint8Array,
  options: Readonly<{ maxPages: number; minTextChars: number; deadline: number }>,
): Promise<PdfWorkerResult> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new PdfWorkerError("preprocess_timeout"));
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return new Promise<PdfWorkerResult>((resolve, reject) => {
    const worker = new Worker(SOURCE, {
      eval: true,
      workerData: { input: copy, maxPages: options.maxPages, minTextChars: options.minTextChars },
      transferList: [copy.buffer],
      resourceLimits: PDF_WORKER_LIMITS,
      // Firul nu moștenește mediul procesului (URL-uri, căi de secrete).
      env: {},
      stdout: false,
      stderr: true,
    });
    active++;
    spawned++;
    let settled = false;
    const finish = async (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => 0);
      active--;
      outcome();
    };
    const timer = setTimeout(() => {
      void finish(() => reject(new PdfWorkerError("preprocess_timeout")));
    }, remaining);
    worker.stderr?.resume();
    worker.on("message", (message: { error?: string } & Partial<PdfWorkerResult>) => {
      void finish(() => {
        if (message.error) {
          reject(
            new PdfWorkerError(
              KNOWN.has(message.error) ? (message.error as PdfWorkerErrorCode) : "pdf_invalid",
            ),
          );
        } else {
          resolve({ pages: message.pages!, text: message.text!, images: message.images ?? null });
        }
      });
    });
    worker.on("error", (error: { code?: string }) => {
      void finish(() =>
        reject(
          new PdfWorkerError(
            error?.code === "ERR_WORKER_OUT_OF_MEMORY" ? "pdf_too_complex" : "pdf_invalid",
          ),
        ),
      );
    });
    worker.on("exit", () => {
      void finish(() => reject(new PdfWorkerError("pdf_invalid")));
    });
  });
}
