import "server-only";

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

/**
 * Ultima versiune a aplicației Android (Faza 9; promptul Android 12.1; ADR 0020): metadatele vin
 * dintr-un fișier JSON scris de operator (sau de workflow-ul de release), NU din cod și fără APK
 * în repository: `<STORAGE_DIR>/app/android-latest.json`. Calea e fixă, sub directorul local de
 * storage (care există pe ambele drivere, `local` și `s3`), deci fără o variabilă de mediu nouă.
 *
 * Fișierul se citește la fiecare cerere (operatorul îl schimbă fără restart), cel mult 16 KiB,
 * validat strict (Zod `strict`): orice abatere înseamnă „indisponibil” (fail closed), fără să
 * expună conținutul fișierului.
 */

export const ANDROID_RELEASE_FILE = join("app", "android-latest.json");
const MAX_FILE_BYTES = 16 * 1024;

export const androidReleaseSchema = z.strictObject({
  versionName: z.string().regex(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,4})$/),
  versionCode: z.int().min(1).max(2_100_000_000),
  minSupportedVersionCode: z.int().min(1).max(2_100_000_000),
  url: z.url({ protocol: /^https$/ }).max(500),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z
    .int()
    .min(1)
    .max(500 * 1024 * 1024),
  notes: z.string().max(2000),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
});

export type AndroidRelease = z.infer<typeof androidReleaseSchema>;

/** Validează conținutul fișierului; `null` dacă nu e o versiune validă. */
export function parseAndroidRelease(raw: string): AndroidRelease | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = androidReleaseSchema.safeParse(data);
  if (!parsed.success) return null;
  if (parsed.data.minSupportedVersionCode > parsed.data.versionCode) return null;
  return parsed.data;
}

/**
 * Citește versiunea publicată din `storageDir`. `null` = nicio versiune (fișier lipsă, prea mare,
 * invalid). Un fișier invalid se semnalează în log doar prin cod, fără conținut.
 */
export async function readAndroidRelease(storageDir: string): Promise<AndroidRelease | null> {
  const path = join(storageDir, ANDROID_RELEASE_FILE);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      console.error("[android] android-latest.json: fișier invalid");
      return null;
    }
    const release = parseAndroidRelease(await readFile(path, "utf8"));
    if (!release) console.error("[android] android-latest.json: conținut invalid");
    return release;
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "ENOENT") {
      console.error("[android] android-latest.json: nu poate fi citit");
    }
    return null;
  }
}

/** Forma JSON din API (`GET /api/v1/app/android/latest`). */
export function androidReleaseJson(r: AndroidRelease) {
  return {
    versionName: r.versionName,
    versionCode: r.versionCode,
    minSupportedVersionCode: r.minSupportedVersionCode,
    url: r.url,
    sha256: r.sha256,
    sizeBytes: r.sizeBytes,
    notes: r.notes,
    publishedAt: r.publishedAt ?? null,
  };
}
