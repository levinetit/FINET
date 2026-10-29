import { Readable } from "node:stream";
import { constants as zlibConstants, crc32, createDeflateRaw } from "node:zlib";

/**
 * Scriitor ZIP în flux (Faza 9, exportul GDPR; ADR 0021), fără dependențe: fiecare intrare se
 * scrie pe măsură ce sursa ei produce date (antet local cu bitul 3 = „dimensiuni în descriptorul
 * de după date”), deci arhiva nu e ținută în memorie. Metode: `deflate` (text: JSON, CSV) sau
 * `store` (fișiere deja comprimate: JPEG, PNG, PDF). Nume UTF-8 (bitul 11). Fără ZIP64: o intrare
 * sau arhiva peste 4 GiB, ori peste 65 535 de intrări, opresc fluxul cu eroare (exportul unei
 * gospodării FINET e cu ordine de mărime sub, din cota de stocare).
 *
 * Verificat independent (Python `zipfile`, `unzip -t`) în `zip.test.ts`.
 */

export type ZipSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Uint8Array | string;

export type ZipEntryOptions = Readonly<{ method?: "deflate" | "store" }>;

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

type Central = Readonly<{
  name: Buffer;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}>;

export class ZipLimitError extends Error {
  constructor() {
    super("Arhiva depășește limitele formatului ZIP (fără ZIP64).");
    this.name = "ZipLimitError";
  }
}

/** Numele unei intrări: relativ, fără `..`, fără `\`, fără caractere de control. */
export function assertEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    name.split("/").some((p) => p === "" || p === "." || p === "..")
  ) {
    throw new Error("nume de intrare ZIP invalid");
  }
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

async function* chunksOf(source: ZipSource): AsyncGenerator<Uint8Array> {
  if (typeof source === "string") {
    yield Buffer.from(source, "utf8");
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const c of source as AsyncIterable<Uint8Array>) {
    yield typeof c === "string" ? Buffer.from(c, "utf8") : c;
  }
}

/**
 * Arhiva ca generator de fragmente: `entries` produce perechi (nume, sursă, opțiuni); generatorul
 * le scrie pe rând, apoi directorul central. Cine consumă poate opri oricând (`return`).
 */
export async function* zipStream(
  entries: AsyncIterable<readonly [string, ZipSource, ZipEntryOptions?]>,
  now: Date = new Date(),
): AsyncGenerator<Uint8Array, void, undefined> {
  const { time, date } = dosDateTime(now);
  const central: Central[] = [];
  let offset = 0;

  for await (const [rawName, source, options] of entries) {
    assertEntryName(rawName);
    if (central.length >= MAX_ENTRIES) throw new ZipLimitError();
    const name = Buffer.from(rawName, "utf8");
    const method = options?.method === "store" ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versiunea necesară
    local.writeUInt16LE(0x0808, 6); // bit 3 (descriptor) + bit 11 (UTF-8)
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // CRC și dimensiunile: 0 aici, în descriptorul de după date.
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const entryOffset = offset;
    yield local;
    yield name;
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    let compressed = 0;
    async function* tap(): AsyncGenerator<Uint8Array> {
      for await (const c of chunksOf(source)) {
        crc = crc32(c, crc);
        size += c.byteLength;
        if (size > MAX_U32) throw new ZipLimitError();
        yield c;
      }
    }
    if (method === 0) {
      for await (const c of tap()) {
        compressed += c.byteLength;
        yield c;
      }
    } else {
      const deflate = Readable.from(tap()).pipe(
        createDeflateRaw({ level: zlibConstants.Z_DEFAULT_COMPRESSION }),
      );
      for await (const c of deflate as AsyncIterable<Buffer>) {
        compressed += c.byteLength;
        yield c;
      }
    }
    if (compressed > MAX_U32) throw new ZipLimitError();
    offset += compressed;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    offset += descriptor.length;
    if (offset > MAX_U32) throw new ZipLimitError();
    central.push({ name, method, crc: crc >>> 0, compressed, size, offset: entryOffset });
  }

  const start = offset;
  for (const e of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(0x0314, 4); // creat de: Unix, v2.0
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(0x0808, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.compressed, 20);
    h.writeUInt32LE(e.size, 24);
    h.writeUInt16LE(e.name.length, 28);
    // extra, comentariu, disc, atribute interne: 0
    h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // atribute externe: fișier obișnuit 0644
    h.writeUInt32LE(e.offset, 42);
    yield h;
    yield e.name;
    offset += h.length + e.name.length;
  }
  if (offset > MAX_U32) throw new ZipLimitError();
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - start, 12);
  end.writeUInt32LE(start, 16);
  yield end;
}
