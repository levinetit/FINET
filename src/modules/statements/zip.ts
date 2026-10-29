import { crc32, inflateRawSync } from "node:zlib";

import { StatementError } from "./types";

/**
 * Citirea SIGURĂ a unei arhive ZIP (extrase multiple; ADR 0018), fără dependențe noi: doar
 * directorul central, verificat câmp cu câmp, apoi fiecare intrare decomprimată cu
 * `inflateRawSync({ maxOutputLength })`. Refuz (`zip_unsafe`) pentru: prea multe intrări,
 * dimensiune decomprimată peste plafon (per fișier și total), raport de compresie suspect,
 * criptare, ZIP64/multi-disc, metode necunoscute, legături simbolice, nume periculoase
 * (absolute, `..`, `\`, litere de unitate, caractere de control), nume duplicate (și fără
 * diferență de majuscule), intrări suprapuse (bombe „overlapping”), CRC greșit, arhive imbricate
 * (orice intrare care e ea însăși ZIP, inclusiv XLSX: decizia mea). Structura stricată:
 * `zip_invalid`.
 */

export type ZipLimits = Readonly<{
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRatio: number;
  /** Doar XLSX (pachet OOXML): intrările ZIP sunt permise în interior (`false` implicit). */
  allowNested?: boolean;
}>;

export const STATEMENT_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxEntries: 20,
  maxEntryBytes: 20 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxRatio: 100,
});

export type ZipEntry = Readonly<{ name: string; data: Buffer }>;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export const isZip = (b: Uint8Array): boolean =>
  b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

const unsafe = (): never => {
  throw new StatementError("zip_unsafe");
};
const invalid = (): never => {
  throw new StatementError("zip_invalid");
};

function safeName(raw: string): string {
  if (raw.length === 0 || raw.length > 255) unsafe();
  if (/[\u0000-\u001f\u007f\\:]/.test(raw)) unsafe();
  if (raw.startsWith("/")) unsafe();
  const segments = raw.split("/");
  if (segments.some((s) => s === ".." || s === ".")) unsafe();
  return raw;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return invalid();
}

export function readZip(input: Uint8Array, limits: ZipLimits = STATEMENT_ZIP_LIMITS): ZipEntry[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 22 || !isZip(buf)) invalid();
  const eocd = findEocd(buf);
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // Multi-disc sau ZIP64 (valorile 0xFFFF / 0xFFFFFFFF): refuz.
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) unsafe();
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) unsafe();
  if (count === 0) invalid();
  if (count > limits.maxEntries) unsafe();
  if (cdOffset + cdSize > eocd) invalid();

  const seen = new Set<string>();
  const ranges: [number, number][] = [];
  const entries: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== SIG_CENTRAL) invalid();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > eocd) invalid();
    // Bitul 0 = criptat, bitul 6 = criptare puternică.
    if (flags & 0x0001 || flags & 0x0040) unsafe();
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) unsafe();
    const name = safeName(
      buf.subarray(p + 46, nameEnd).toString(flags & 0x0800 ? "utf8" : "latin1"),
    );
    p = nameEnd + extraLen + commentLen;
    // Legătură simbolică (atributele Unix în octeții superiori).
    if (((external >>> 16) & 0o170000) === 0o120000) unsafe();
    const key = name.toLowerCase();
    if (seen.has(key)) unsafe();
    seen.add(key);
    if (name.endsWith("/")) {
      if (usize !== 0) unsafe();
      continue; // director
    }
    if (method !== 0 && method !== 8) unsafe();
    if (usize > limits.maxEntryBytes) unsafe();
    total += usize;
    if (total > limits.maxTotalBytes) unsafe();
    if (csize > 0 && usize / csize > limits.maxRatio) unsafe();
    if (method === 0 && csize !== usize) invalid();

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== SIG_LOCAL) invalid();
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const lName = buf.subarray(localOffset + 30, localOffset + 30 + lNameLen);
    if (lName.toString(flags & 0x0800 ? "utf8" : "latin1") !== name) unsafe();
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const end = start + csize;
    if (end > cdOffset) invalid();
    ranges.push([localOffset, end]);

    let data: Buffer;
    if (method === 0) data = Buffer.from(buf.subarray(start, end));
    else {
      try {
        data = inflateRawSync(buf.subarray(start, end), { maxOutputLength: Math.max(1, usize) });
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
          unsafe();
        }
        return invalid();
      }
    }
    if (data.length !== usize) unsafe();
    if (crc32(data) >>> 0 !== crc >>> 0) invalid();
    if (!limits.allowNested && isZip(data)) unsafe();
    entries.push({ name, data });
  }
  // Intrări suprapuse (aceleași date referite de mai multe intrări): refuz.
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) unsafe();
  return entries;
}
