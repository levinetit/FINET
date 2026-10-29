/**
 * Generator de coduri QR (ISO/IEC 18004), fără dependențe (Faza 9: codul QR al linkului de
 * descărcare Android, „generat local”; ADR 0020). Doar ce trebuie pentru un link: modul byte
 * (UTF-8), nivelul de corecție M (~15%), versiunile 1–10 (până la 213 octeți). Algoritmul urmează
 * implementarea de referință publică a lui Project Nayuki (licență MIT), rescrisă pe scurt.
 *
 * Verificat în `qr.test.ts`: matrice identice, modul cu modul, cu cele produse de o bibliotecă
 * independentă (python-qrcode 8.2) pentru aceleași date, versiune și mască (vectorii sunt în test).
 *
 * Ieșirea e o matrice de booleene (`true` = modul închis) sau calea SVG (`qrSvgPath`), randată pe
 * server: fără JavaScript în browser, fără atribute `style`.
 */

export type QrMatrix = readonly (readonly boolean[])[];

const MIN_VERSION = 1;
const MAX_VERSION = 10;
// Nivelul M: codurile de corecție pe bloc și numărul de blocuri, pe versiune (index 0 nefolosit).
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
// Biții de format ai nivelului M.
const ECL_M_FORMAT_BITS = 0;

export class QrTooLongError extends Error {
  constructor() {
    super("textul e prea lung pentru un cod QR (maximum versiunea 10)");
    this.name = "QrTooLongError";
  }
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (ver: number): number =>
  Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver]! * BLOCKS_M[ver]!;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i]! ^= gfMul(coef, factor)));
  }
  return result;
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Codurile de date (cu completarea standard), pentru versiunea dată. */
function encodeData(bytes: Uint8Array, ver: number): number[] {
  const capacityBits = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // modul byte
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    out.push(byte);
  }
  return out;
}

/** Împarte în blocuri, adaugă corecția Reed–Solomon și le întrețese. */
function withErrorCorrection(data: readonly number[], ver: number): number[] {
  const numBlocks = BLOCKS_M[ver]!;
  const eccLen = ECC_PER_BLOCK_M[ver]!;
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push([...dat, ...ecc]);
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]!);
    });
  }
  return result;
}

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  setFunction(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size)
            this.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const pos = alignmentPositions(this.ver);
    const last = pos.length - 1;
    pos.forEach((px, i) =>
      pos.forEach((py, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.setFunction(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }),
    );
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask: number) {
    const data = (ECL_M_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const { size } = this;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true);
  }

  drawVersion() {
    if (this.ver < 7) return;
    let rem = this.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  drawCodewords(data: readonly number[]) {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number) {
    const fn = MASKS[mask]!;
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y]![x] && fn(x, y)) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /** Penalizarea standard (regulile N1–N4), pentru alegerea măștii. */
  penalty(): number {
    const { size, modules } = this;
    let score = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // N3: 1:1:3:1:1 cu 4 module deschise înainte sau după.
      const pattern = [true, false, true, true, true, false, true];
      for (let i = 0; i + 7 <= size; i++) {
        if (!pattern.every((p, k) => get(i + k) === p)) continue;
        const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
        const lightAfter = i + 11 <= size && [7, 8, 9, 10].every((k) => !get(i + k));
        if (lightBefore || lightAfter) score += 40;
      }
    };
    for (let y = 0; y < size; y++) line((x) => modules[y]![x]!);
    for (let x = 0; x < size; x++) line((y) => modules[y]![x]!);
    for (let y = 0; y + 1 < size; y++) {
      for (let x = 0; x + 1 < size; x++) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) {
          score += 3;
        }
      }
    }
    const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return score + Math.max(0, k) * 10;
  }
}

/** Cea mai mică versiune (1–10) în care încape textul. */
export function qrVersionFor(byteLength: number): number {
  for (let ver = MIN_VERSION; ver <= MAX_VERSION; ver++) {
    const headerBits = 4 + (ver <= 9 ? 8 : 16);
    if (headerBits + byteLength * 8 <= dataCodewords(ver) * 8) return ver;
  }
  throw new QrTooLongError();
}

export type QrOptions = Readonly<{ version?: number; mask?: number }>;

/** Matricea QR (nivel M, mod byte) a textului; masca se alege după penalizare, dacă nu e dată. */
export function qrMatrix(text: string, options: QrOptions = {}): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const minVer = qrVersionFor(bytes.length);
  const ver = options.version ?? minVer;
  if (!Number.isInteger(ver) || ver < minVer || ver > MAX_VERSION) throw new QrTooLongError();
  const codewords = withErrorCorrection(encodeData(bytes, ver), ver);
  const grid = new Grid(ver);
  grid.drawFunctionPatterns();
  grid.drawCodewords(codewords);
  let mask = options.mask;
  if (mask === undefined) {
    let best = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 8; m++) {
      grid.applyMask(m);
      grid.drawFormatBits(m);
      const p = grid.penalty();
      if (p < best) {
        best = p;
        mask = m;
      }
      grid.applyMask(m); // XOR: a doua aplicare anulează masca
    }
  }
  if (mask === undefined || !Number.isInteger(mask) || mask < 0 || mask > 7) {
    throw new Error("mască QR invalidă");
  }
  grid.applyMask(mask);
  grid.drawFormatBits(mask);
  return grid.modules.map((row) => [...row]);
}

/** Calea SVG (un dreptunghi 1×1 pe modul închis), cu marginea liniștită de 4 module. */
export function qrSvgPath(matrix: QrMatrix, quiet = 4): { d: string; size: number } {
  const parts: string[] = [];
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }),
  );
  return { d: parts.join(""), size: matrix.length + quiet * 2 };
}
