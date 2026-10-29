import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalStorage } from "@/lib/storage";

import { HEAD_BYTES } from "./content";
import { UploadError, receiveMultipart, type UploadLimits } from "./multipart";
import { HOSTILE, pngBomb, receiptLikeImage, textPdf } from "./testing";

const HH = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const LIMITS: UploadLimits = {
  maxFileBytes: 2 * 1024 * 1024,
  maxFiles: 4,
  maxImagePixels: 50_000_000,
};

let root: string;
let storage: LocalStorage;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "finet-upload-")));
  storage = new LocalStorage(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Part = readonly [name: string, data: Buffer | string, filename?: string, type?: string];

/**
 * O cerere multipart cu corpul deja serializat (ca de la un client real). Corpul generat de
 * `FormData` în undici nu suportă anularea la mijloc (eroare internă undici), deci se
 * serializează întâi.
 */
async function formRequest(
  parts: readonly Part[],
  headers: Record<string, string> = {},
): Promise<Request> {
  const form = new FormData();
  for (const [name, data, filename, type] of parts) {
    if (typeof data === "string") form.append(name, data);
    else form.append(name, new Blob([new Uint8Array(data)], { type: type ?? "" }), filename ?? "f");
  }
  const encoded = new Request("http://localhost/api/v1/documents", { method: "POST", body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  return new Request("http://localhost/api/v1/documents", {
    method: "POST",
    headers: { "content-type": encoded.headers.get("content-type")!, ...headers },
    body,
  });
}

/** Toate fișierele rămase în storage (inclusiv temporare). */
async function storedFiles(): Promise<string[]> {
  const dir = join(root, "households", HH, "documents");
  return readdir(dir).catch(() => []);
}

async function uploadError(
  request: Request | Promise<Request>,
  limits = LIMITS,
): Promise<UploadError> {
  const error = await receiveMultipart(await request, storage, HH, limits).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UploadError);
  return error as UploadError;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("receiveMultipart — fișiere valide", () => {
  it("scrie fișierele în flux, în ordine, cu SHA-256 și tipul detectat; câmpurile permise", async () => {
    const jpg = await receiptLikeImage();
    const pdf = textPdf();
    const result = await receiveMultipart(
      await formRequest([
        ["kind", "receipt"],
        ["files", jpg, "bon.jpg", "image/jpeg"],
        ["files", pdf, "bon.pdf", "application/pdf"],
        ["longReceipt", "false"],
      ]),
      storage,
      HH,
      LIMITS,
    );
    expect(result.fields).toEqual({ kind: "receipt", longReceipt: "false" });
    expect(
      result.files.map((f) => [f.index, f.mime, f.sizeBytes, f.sha256, f.declaredMime]),
    ).toEqual([
      [0, "image/jpeg", jpg.length, sha(jpg), "image/jpeg"],
      [1, "application/pdf", pdf.length, sha(pdf), "application/pdf"],
    ]);
    for (const [i, data] of [jpg, pdf].entries()) {
      expect(Buffer.from(await storage.get(result.files[i]!.key))).toEqual(data);
      expect(result.files[i]!.key.startsWith(`households/${HH}/documents/`)).toBe(true);
    }
    expect((await storedFiles()).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("un fișier mai mare decât fereastra antetului trece întreg (calea de flux)", async () => {
    const noise = await sharp(randomBytes(700 * 700 * 3), {
      raw: { width: 700, height: 700, channels: 3 },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    expect(noise.length).toBeGreaterThan(HEAD_BYTES);
    const result = await receiveMultipart(
      await formRequest([["files", noise, "mare.jpg", "image/jpeg"]]),
      storage,
      HH,
      LIMITS,
    );
    expect(result.files[0]!.sha256).toBe(sha(noise));
    // `equals` (nu `toEqual`): compararea profundă a 1,4 MB durează secunde.
    expect(Buffer.from(await storage.get(result.files[0]!.key)).equals(noise)).toBe(true);
  });

  it("tipul declarat de client nu contează (doar informativ)", async () => {
    const png = await receiptLikeImage({ format: "png" });
    const result = await receiveMultipart(
      await formRequest([["files", png, "poza.jpg", "text/html"]]),
      storage,
      HH,
      LIMITS,
    );
    expect(result.files[0]!.mime).toBe("image/png");
    expect(result.files[0]!.declaredMime).toBe("text/html");
  });
});

describe("receiveMultipart — refuzuri (fără fișiere rămase)", () => {
  it.each(HOSTILE)("%s → refuzat (%s)", async (_label, data, reason) => {
    const error = await uploadError(await formRequest([["files", data, "bon.jpg", "image/jpeg"]]));
    expect(error.reason).toBe(reason);
    expect(await storedFiles()).toEqual([]);
  });

  it("un fișier bun + unul ostil: ambele șterse, nimic rămas", async () => {
    const error = await uploadError(
      await formRequest([
        ["files", await receiptLikeImage(), "a.jpg"],
        ["files", HOSTILE[0]![1], "b.jpg"],
      ]),
    );
    expect(error.reason).toBe("unsupported_type");
    expect(await storedFiles()).toEqual([]);
  });

  it("bombă de decompresie (antet PNG 30000×30000) → 413 image_too_large", async () => {
    const error = await uploadError(await formRequest([["files", await pngBomb(), "x.png"]]));
    expect([error.status, error.reason]).toEqual([413, "image_too_large"]);
  });

  it("fișier peste MAX_UPLOAD_MB → 413 file_too_large", async () => {
    const big = await receiptLikeImage();
    const error = await uploadError(await formRequest([["files", big, "a.jpg"]]), {
      ...LIMITS,
      maxFileBytes: big.length - 1,
    });
    expect([error.status, error.reason]).toEqual([413, "file_too_large"]);
    expect(await storedFiles()).toEqual([]);
  });

  it("mai mult de 4 fișiere → 413 too_many_files", async () => {
    const jpg = await receiptLikeImage();
    const parts: Part[] = [1, 2, 3, 4, 5].map((i) => ["files", jpg, `${i}.jpg`] as const);
    const error = await uploadError(await formRequest(parts));
    expect(error.reason).toBe("too_many_files");
    expect(await storedFiles()).toEqual([]);
  });

  it("Content-Length peste plafonul corpului → 413 înainte de citire", async () => {
    const error = await uploadError(
      await formRequest([["files", await receiptLikeImage(), "a.jpg"]], {
        "content-length": String(4 * LIMITS.maxFileBytes + 1024 * 1024),
      }),
    );
    expect([error.status, error.reason]).toEqual([413, "payload_too_large"]);
  });

  it("corp peste plafon fără Content-Length → 413 payload_too_large", async () => {
    const jpg = await receiptLikeImage();
    const error = await uploadError(await formRequest([["files", jpg, "a.jpg"]]), {
      ...LIMITS,
      maxFiles: 1,
      maxFileBytes: 1024,
    });
    // Fie fișierul, fie corpul depășește primul plafonul; amândouă sunt 413.
    expect(error.status).toBe(413);
    expect(await storedFiles()).toEqual([]);
  });

  it("corp trunchiat (fără delimitatorul final, ca după proxy) → invalid_multipart", async () => {
    const full = await formRequest([["files", await receiptLikeImage(), "a.jpg"]]);
    const type = full.headers.get("content-type")!;
    const bytes = Buffer.from(await full.arrayBuffer());
    const truncated = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": type },
      body: bytes.subarray(0, bytes.length - 60),
    });
    const error = await uploadError(truncated);
    expect(error.reason).toBe("invalid_multipart");
    expect(await storedFiles()).toEqual([]);
  });

  it("alt Content-Type decât multipart → 415", async () => {
    const request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await uploadError(request)).status).toBe(415);
  });

  it("câmp necunoscut sau câmpul fișierelor greșit → invalid_field", async () => {
    const jpg = await receiptLikeImage();
    expect(
      (
        await uploadError(
          await formRequest([
            ["altceva", "x"],
            ["files", jpg],
          ]),
        )
      ).reason,
    ).toBe("invalid_field");
    expect((await uploadError(await formRequest([["file", jpg, "a.jpg"]]))).reason).toBe(
      "invalid_field",
    );
    expect(await storedFiles()).toEqual([]);
  });

  it("fără fișiere → 400 no_files", async () => {
    expect((await uploadError(await formRequest([["kind", "receipt"]]))).reason).toBe("no_files");
  });
});
